"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import UsageBarChart, { type UsagePoint } from "@/components/usage/UsageBarChart";
import { planLimits } from "@/lib/planLimits";
import { getUserOrgIds, getUserPlan } from "@/lib/usage";

type OrgLite = { id: string; name: string };
type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

type Range = "7d" | "30d" | "month";
type Metric = "queries" | "documents" | "agentRuns" | "graphs";

type DocRow = { file_size_bytes: number | null; created_at: string | null };
type RunRow = { created_at: string | null; status: string | null };
type GraphRow = { created_at: string | null; status: string | null; node_count: number | null; edge_count: number | null };
type MsgRow = { role: string | null; content: string | null; created_at: string | null };

type Raw = {
  docs: DocRow[];
  chatMsgs: MsgRow[];
  runs: RunRow[];
  agentMsgs: MsgRow[];
  graphs: GraphRow[];
  librariesCount: number;
  chunksCount: number;
  artifactsCount: number;
};

const METRICS: Record<Metric, { label: string; color: string }> = {
  queries: { label: "Chat queries", color: "#a78bfa" },
  documents: { label: "Documents", color: "#34d399" },
  agentRuns: { label: "Agent runs", color: "#fbbf24" },
  graphs: { label: "Knowledge graphs", color: "#f472b6" },
};

// ---- date helpers ----------------------------------------------------------
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

function bucketByDay(timestamps: string[], start: Date, end: Date): UsagePoint[] {
  const days: { date: Date; value: number }[] = [];
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur <= last) {
    days.push({ date: new Date(cur), value: 0 });
    cur.setDate(cur.getDate() + 1);
  }
  const idx = new Map<string, number>();
  days.forEach((d, i) => idx.set(dayKey(d.date), i));
  for (const ts of timestamps) {
    if (!ts) continue;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const i = idx.get(dayKey(startOfDay(d)));
    if (i !== undefined) days[i].value += 1;
  }
  return days.map((d) => ({ date: fmtDay(d.date), value: d.value }));
}

const countSince = (timestamps: string[], since: Date) =>
  timestamps.reduce((n, ts) => (ts && new Date(ts) >= since ? n + 1 : n), 0);

function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
const fmtNum = (n: number) => n.toLocaleString();

// Rough token estimate (~4 chars/token) — used for the "estimated" meter since no per-model
// token logging exists yet.
const approxTokens = (s: string | null | undefined) => Math.ceil((s?.length || 0) / 4);

function fmtCompact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const u = ["", "K", "M", "B"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

export default function UsageWorkspace({
  supabase,
  onLog,
}: {
  supabase: SupabaseClient;
  // organization is accepted for prop compatibility but usage is now per-USER (all the user's orgs).
  organization?: OrgLite | null;
  onLog?: LogFn;
}) {
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<string>("free");
  const [raw, setRaw] = useState<Raw | null>(null);
  const [range, setRange] = useState<Range>("30d");
  const [metric, setMetric] = useState<Metric>("queries");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Usage is per-USER: pool across every organization the user belongs to (a new org must not
      // reset the allowance), matching how the limit gates count.
      const orgIds = await getUserOrgIds(supabase);
      if (!orgIds.length) {
        setRaw(null);
        return;
      }

      const now = new Date();
      const windowStart = (startOfMonth(now) < addDays(startOfDay(now), -29)
        ? startOfMonth(now)
        : addDays(startOfDay(now), -29)
      ).toISOString();

      const [docsR, libsR, chunksR, chatR, runsR, agentMsgsR, graphsR, artsR, plan] = await Promise.all([
        supabase.from("documents").select("file_size_bytes, created_at").in("organization_id", orgIds),
        supabase.from("libraries").select("*", { count: "exact", head: true }).in("organization_id", orgIds),
        supabase.from("chunk_embeddings").select("*", { count: "exact", head: true }).in("organization_id", orgIds),
        // Pull role + content (windowed) so we can both count queries and estimate token volume.
        supabase
          .from("chat_messages")
          .select("role, content, created_at")
          .in("organization_id", orgIds)
          .gte("created_at", windowStart)
          .limit(8000),
        supabase.from("agent_runs").select("created_at, status").in("organization_id", orgIds).gte("created_at", windowStart),
        supabase
          .from("agent_messages")
          .select("role, content, created_at")
          .in("organization_id", orgIds)
          .gte("created_at", windowStart)
          .limit(8000),
        supabase.from("kg_graphs").select("created_at, status, node_count, edge_count").in("organization_id", orgIds),
        supabase.from("agent_artifacts").select("*", { count: "exact", head: true }).in("organization_id", orgIds),
        getUserPlan(supabase, orgIds),
      ]);

      setPlan(plan);
      setRaw({
        docs: ((docsR.data as DocRow[]) || []).map((d) => ({ file_size_bytes: d.file_size_bytes, created_at: d.created_at })),
        chatMsgs: (chatR.data as MsgRow[]) || [],
        runs: (runsR.data as RunRow[]) || [],
        agentMsgs: (agentMsgsR.data as MsgRow[]) || [],
        graphs: (graphsR.data as GraphRow[]) || [],
        librariesCount: libsR.count ?? 0,
        chunksCount: chunksR.count ?? 0,
        artifactsCount: artsR.count ?? 0,
      });
    } catch (e) {
      onLog?.({ level: "error", message: "Failed to load usage", details: e });
      setRaw(null);
    } finally {
      setLoading(false);
    }
  }, [supabase, onLog]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- derived ----
  const view = useMemo(() => {
    const now = new Date();
    const rangeStart = range === "month" ? startOfMonth(now) : addDays(startOfDay(now), range === "7d" ? -6 : -29);
    const monthStart = startOfMonth(now);

    const docsTs = (raw?.docs || []).map((d) => d.created_at || "").filter(Boolean);
    const runsTs = (raw?.runs || []).map((r) => r.created_at || "").filter(Boolean);
    const graphsTs = (raw?.graphs || []).map((g) => g.created_at || "").filter(Boolean);
    const chatMsgs = raw?.chatMsgs || [];
    const agentMsgs = raw?.agentMsgs || [];
    const queriesTs = chatMsgs.filter((m) => m.role === "user").map((m) => m.created_at || "").filter(Boolean);

    const metricTs: Record<Metric, string[]> = { queries: queriesTs, documents: docsTs, agentRuns: runsTs, graphs: graphsTs };

    const series = (m: Metric) => bucketByDay(metricTs[m], rangeStart, now);
    const periodTotal = (m: Metric) => countSince(metricTs[m], rangeStart);

    const storage = (raw?.docs || []).reduce((s, d) => s + (d.file_size_bytes || 0), 0);
    const nodes = (raw?.graphs || []).reduce((s, g) => s + (g.node_count || 0), 0);
    const edges = (raw?.graphs || []).reduce((s, g) => s + (g.edge_count || 0), 0);
    const graphsDone = (raw?.graphs || []).filter((g) => g.status === "done").length;

    // ---- estimated token / request meter (range-aware) ----
    const inRange = (m: MsgRow) => !!m.created_at && new Date(m.created_at) >= rangeStart;
    const chatR = chatMsgs.filter(inRange);
    const agentR = agentMsgs.filter(inRange);
    const chatRequests = chatR.filter((m) => m.role === "assistant").length;
    const chatTokens = chatR.reduce((s, m) => s + approxTokens(m.content), 0);
    const agentRequests = agentR.filter((m) => m.role === "assistant").length;
    const agentTokens = agentR.reduce((s, m) => s + approxTokens(m.content), 0);
    const meterRows = [
      { label: "Chat", color: METRICS.queries.color, requests: chatRequests, tokens: chatTokens },
      { label: "Agent", color: METRICS.agentRuns.color, requests: agentRequests, tokens: agentTokens },
    ];
    const meter = {
      rows: meterRows,
      maxTokens: Math.max(1, ...meterRows.map((r) => r.tokens)),
      totalRequests: chatRequests + agentRequests,
      totalTokens: chatTokens + agentTokens,
    };

    return {
      rangeStart,
      heroSeries: series(metric),
      heroTotal: periodTotal(metric),
      series,
      periodTotal,
      meter,
      month: {
        queries: countSince(queriesTs, monthStart),
        runs: countSince(runsTs, monthStart),
        graphs: countSince(graphsTs, monthStart),
      },
      totals: {
        documents: raw?.docs.length ?? 0,
        storage,
        libraries: raw?.librariesCount ?? 0,
        chunks: raw?.chunksCount ?? 0,
        artifacts: raw?.artifactsCount ?? 0,
        graphsDone,
        nodes,
        edges,
      },
    };
  }, [raw, range, metric]);

  const limits = planLimits(plan);
  const rangeLabel = range === "7d" ? "last 7 days" : range === "30d" ? "last 30 days" : "this month";

  return (
    <div className="flex h-[calc(100vh-5.25rem)] flex-col overflow-y-auto pb-8">
      {/* header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="gradient-text">Usage</span>
          </h1>
          <p className="mt-0.5 text-xs text-white/45">Your activity and plan limits, {rangeLabel}.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-violet-400/20 bg-violet-500/15 px-2 py-[3px] text-[10px] font-semibold uppercase tracking-wide text-violet-300">
            {limits.label}
          </span>
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-0.5 text-xs">
            {(["7d", "30d", "month"] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-full px-2.5 py-1 font-medium transition ${
                  range === r ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                {r === "7d" ? "7 days" : r === "30d" ? "30 days" : "This month"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <UsageSkeleton />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* main column */}
          <div className="space-y-5 lg:col-span-2">
            {/* hero chart */}
            <div className="rounded-2xl glass glass-hi p-5">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-white/45">{METRICS[metric].label} · {rangeLabel}</p>
                  <p className="mt-0.5 text-3xl font-bold tracking-tight">{fmtNum(view.heroTotal)}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {(Object.keys(METRICS) as Metric[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMetric(m)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                        metric === m ? "bg-white/15 text-white" : "text-white/45 hover:text-white/75"
                      }`}
                    >
                      {METRICS[m].label}
                    </button>
                  ))}
                </div>
              </div>
              <UsageBarChart data={view.heroSeries} color={METRICS[metric].color} height={240} />
            </div>

            {/* capability breakdown */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <CapabilityCard
                title="Chat"
                value={view.periodTotal("queries")}
                subtitle="grounded questions answered"
                color={METRICS.queries.color}
                series={view.series("queries")}
              />
              <CapabilityCard
                title="Agent"
                value={view.periodTotal("agentRuns")}
                subtitle={`${fmtNum(view.totals.artifacts)} artefacts generated`}
                color={METRICS.agentRuns.color}
                series={view.series("agentRuns")}
              />
              <CapabilityCard
                title="Knowledge Graph"
                value={view.periodTotal("graphs")}
                subtitle={`${fmtNum(view.totals.nodes)} nodes · ${fmtNum(view.totals.edges)} edges`}
                color={METRICS.graphs.color}
                series={view.series("graphs")}
              />
              <CapabilityCard
                title="Ingestion"
                value={view.periodTotal("documents")}
                subtitle={`${fmtNum(view.totals.chunks)} chunks indexed`}
                color={METRICS.documents.color}
                series={view.series("documents")}
              />
            </div>
          </div>

          {/* right rail */}
          <div className="space-y-5">
            <div className="rounded-2xl glass glass-hi p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white/90">Plan &amp; limits</h2>
                <span className="text-[11px] text-white/40">{limits.label} plan</span>
              </div>
              <div className="space-y-3.5">
                <LimitBar label="Storage" used={view.totals.storage} limit={limits.storageBytes} fmt={fmtBytes} />
                <LimitBar label="Documents" used={view.totals.documents} limit={limits.documents} />
                <LimitBar label="Libraries" used={view.totals.libraries} limit={limits.libraries} />
                <LimitBar label="Queries this month" used={view.month.queries} limit={limits.monthlyQueries} />
                <LimitBar label="Agent runs this month" used={view.month.runs} limit={limits.monthlyAgentRuns} />
              </div>
            </div>

            <div className="rounded-2xl glass glass-hi p-5">
              <h2 className="mb-3 text-sm font-semibold text-white/90">Totals</h2>
              <div className="grid grid-cols-2 gap-3">
                <StatTile label="Documents" value={fmtNum(view.totals.documents)} />
                <StatTile label="Storage" value={fmtBytes(view.totals.storage)} />
                <StatTile label="Libraries" value={fmtNum(view.totals.libraries)} />
                <StatTile label="Chunks" value={fmtNum(view.totals.chunks)} />
                <StatTile label="Graphs built" value={fmtNum(view.totals.graphsDone)} />
                <StatTile label="Artefacts" value={fmtNum(view.totals.artifacts)} />
              </div>
            </div>

            {/* Tokens & requests — estimated from message volume */}
            <div className="rounded-2xl glass glass-hi p-5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white/90">Tokens &amp; requests</h2>
                <span
                  title="Approximated from message volume (~4 chars per token). No per-model token logging yet."
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-[2px] text-[9px] font-semibold uppercase tracking-wide text-white/40"
                >
                  est.
                </span>
              </div>
              <p className="mb-3 text-[11px] text-white/35">Approx. model usage from message volume, {rangeLabel}.</p>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <StatTile label="Model requests" value={fmtNum(view.meter.totalRequests)} />
                <StatTile label="Est. tokens" value={fmtCompact(view.meter.totalTokens)} />
              </div>
              <div className="space-y-2.5">
                {view.meter.rows.map((r) => (
                  <TokenRow key={r.label} {...r} max={view.meter.maxTokens} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CapabilityCard({
  title,
  value,
  subtitle,
  color,
  series,
}: {
  title: string;
  value: number;
  subtitle: string;
  color: string;
  series: UsagePoint[];
}) {
  return (
    <div className="rounded-2xl glass glass-hi p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white/90">{title}</h3>
        <span className="text-lg font-bold tracking-tight">{fmtNum(value)}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-white/40">{subtitle}</p>
      <div className="mt-3">
        <UsageBarChart data={series} variant="spark" color={color} height={52} />
      </div>
    </div>
  );
}

function LimitBar({
  label,
  used,
  limit,
  fmt = fmtNum,
}: {
  label: string;
  used: number;
  limit: number;
  fmt?: (n: number) => string;
}) {
  const unlimited = !Number.isFinite(limit);
  const pct = unlimited ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);
  const tone = pct >= 90 ? "#fb7185" : pct >= 75 ? "#fbbf24" : "#34d399";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-white/65">{label}</span>
        <span className="text-white/45">
          {fmt(used)} <span className="text-white/25">/ {unlimited ? "∞" : fmt(limit)}</span>
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${unlimited ? 4 : Math.max(used > 0 ? 3 : 0, pct)}%`, backgroundColor: unlimited ? "#34d399" : tone }}
        />
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
      <p className="text-[11px] text-white/40">{label}</p>
      <p className="mt-0.5 text-base font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function TokenRow({
  label,
  color,
  requests,
  tokens,
  max,
}: {
  label: string;
  color: string;
  requests: number;
  tokens: number;
  max: number;
}) {
  const pct = max > 0 ? Math.max(tokens > 0 ? 4 : 0, (tokens / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 text-white/70">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
          {label}
        </span>
        <span className="tabular-nums text-white/45">
          {fmtNum(requests)} req <span className="text-white/25">·</span> {fmtCompact(tokens)} tok
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

// ---- loading skeleton -------------------------------------------------------
function SkeletonBars({ count, height, gap = "gap-1.5" }: { count: number; height: string; gap?: string }) {
  // Deterministic heights (no Math.random → no hydration mismatch); each bar pulses on a stagger.
  return (
    <div className={`flex items-end ${gap} ${height}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="usage-bar flex-1 rounded-t bg-gradient-to-t from-violet-500/30 to-fuchsia-400/20"
          style={{ height: `${22 + ((i * 37) % 78)}%`, animationDelay: `${(i % 12) * 70}ms` }}
        />
      ))}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      {/* main column */}
      <div className="space-y-5 lg:col-span-2">
        <div className="rounded-2xl glass glass-hi p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="h-3 w-28 animate-pulse rounded bg-white/10" />
              <div className="h-7 w-24 animate-pulse rounded bg-white/10" />
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-6 w-16 animate-pulse rounded-full bg-white/8" style={{ animationDelay: `${i * 90}ms` }} />
              ))}
            </div>
          </div>
          <SkeletonBars count={28} height="h-[240px]" />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl glass glass-hi p-4">
              <div className="flex items-baseline justify-between">
                <div className="h-3.5 w-20 animate-pulse rounded bg-white/10" />
                <div className="h-4 w-10 animate-pulse rounded bg-white/10" />
              </div>
              <div className="mt-1.5 h-2.5 w-28 animate-pulse rounded bg-white/8" />
              <div className="mt-3">
                <SkeletonBars count={16} height="h-[52px]" gap="gap-1" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* right rail */}
      <div className="space-y-5">
        <div className="space-y-3.5 rounded-2xl glass glass-hi p-5">
          <div className="h-3.5 w-28 animate-pulse rounded bg-white/10" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex justify-between">
                <div className="h-2.5 w-24 animate-pulse rounded bg-white/8" />
                <div className="h-2.5 w-12 animate-pulse rounded bg-white/8" />
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
                <div className="h-full animate-pulse rounded-full bg-white/15" style={{ width: `${28 + i * 13}%` }} />
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl glass glass-hi p-5">
          <div className="mb-3 h-3.5 w-16 animate-pulse rounded bg-white/10" />
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl border border-white/8 bg-white/[0.03]" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        </div>

        <div className="rounded-2xl glass glass-hi p-5">
          <div className="mb-3 h-3.5 w-32 animate-pulse rounded bg-white/10" />
          <div className="space-y-2.5">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-6 w-full animate-pulse rounded bg-white/8" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
