"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import UsageBarChart, { type UsagePoint } from "@/components/usage/UsageBarChart";
import { planLimits } from "@/lib/planLimits";

type OrgLite = { id: string; name: string };
type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

type Range = "7d" | "30d" | "month";
type Metric = "queries" | "documents" | "agentRuns" | "graphs";

type DocRow = { file_size_bytes: number | null; created_at: string | null };
type RunRow = { created_at: string | null; status: string | null };
type GraphRow = { created_at: string | null; status: string | null; node_count: number | null; edge_count: number | null };

type Raw = {
  docs: DocRow[];
  queriesTs: string[];
  runs: RunRow[];
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

export default function UsageWorkspace({
  supabase,
  organization,
  onLog,
}: {
  supabase: SupabaseClient;
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
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const uid = user?.id;

      // resolve the user's home organization (owner first), like the other workspaces
      let orgId = organization?.id ?? null;
      if (uid) {
        const { data: mems } = await supabase
          .from("organization_members")
          .select("organization_id, role")
          .eq("user_id", uid);
        const rows = (mems as Array<Record<string, unknown>>) || [];
        const owner = rows.find((m) => String(m.role) === "owner");
        orgId = String((owner || rows[0])?.organization_id || orgId || "");
      }
      if (!orgId) {
        setRaw(null);
        return;
      }

      const now = new Date();
      const windowStart = (startOfMonth(now) < addDays(startOfDay(now), -29)
        ? startOfMonth(now)
        : addDays(startOfDay(now), -29)
      ).toISOString();

      const [docsR, libsR, chunksR, queriesR, runsR, graphsR, artsR, orgR] = await Promise.all([
        supabase.from("documents").select("file_size_bytes, created_at").eq("organization_id", orgId),
        supabase.from("libraries").select("*", { count: "exact", head: true }).eq("organization_id", orgId),
        supabase.from("chunk_embeddings").select("*", { count: "exact", head: true }).eq("organization_id", orgId),
        supabase
          .from("chat_messages")
          .select("created_at")
          .eq("organization_id", orgId)
          .eq("role", "user")
          .gte("created_at", windowStart),
        supabase.from("agent_runs").select("created_at, status").eq("organization_id", orgId).gte("created_at", windowStart),
        supabase.from("kg_graphs").select("created_at, status, node_count, edge_count").eq("organization_id", orgId),
        supabase.from("agent_artifacts").select("*", { count: "exact", head: true }).eq("organization_id", orgId),
        supabase.from("organizations").select("plan").eq("id", orgId).maybeSingle(),
      ]);

      setPlan(String((orgR.data as { plan?: string } | null)?.plan || "free"));
      setRaw({
        docs: ((docsR.data as DocRow[]) || []).map((d) => ({ file_size_bytes: d.file_size_bytes, created_at: d.created_at })),
        queriesTs: ((queriesR.data as Array<{ created_at: string | null }>) || []).map((r) => r.created_at || "").filter(Boolean),
        runs: (runsR.data as RunRow[]) || [],
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
  }, [supabase, organization, onLog]);

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
    const queriesTs = raw?.queriesTs || [];

    const metricTs: Record<Metric, string[]> = { queries: queriesTs, documents: docsTs, agentRuns: runsTs, graphs: graphsTs };

    const series = (m: Metric) => bucketByDay(metricTs[m], rangeStart, now);
    const periodTotal = (m: Metric) => countSince(metricTs[m], rangeStart);

    const storage = (raw?.docs || []).reduce((s, d) => s + (d.file_size_bytes || 0), 0);
    const nodes = (raw?.graphs || []).reduce((s, g) => s + (g.node_count || 0), 0);
    const edges = (raw?.graphs || []).reduce((s, g) => s + (g.edge_count || 0), 0);
    const graphsDone = (raw?.graphs || []).filter((g) => g.status === "done").length;

    return {
      rangeStart,
      heroSeries: series(metric),
      heroTotal: periodTotal(metric),
      series,
      periodTotal,
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
        <div className="flex flex-1 items-center justify-center text-sm text-white/40">Loading usage…</div>
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

            {/* placeholder for Step 2 token/request metering */}
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5">
              <h2 className="text-sm font-semibold text-white/55">Tokens &amp; requests</h2>
              <p className="mt-1 text-xs text-white/35">
                Per-model token and request metering becomes available once usage logging is enabled.
              </p>
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
