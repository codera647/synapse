"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiCheck, FiAlertTriangle, FiClock } from "react-icons/fi";

// The pipeline stages, in order. Matches backend/pipeline_config.py.
const STAGES: { key: string; label: string }[] = [
  { key: "sync", label: "Sync" },
  { key: "layout_parser", label: "Layout" },
  { key: "text_extraction", label: "Extract" },
  { key: "image_captioning", label: "Caption" },
  { key: "chunking", label: "Chunk" },
  { key: "embedding", label: "Embed" },
  { key: "clustering", label: "Cluster" },
];

type StageStat = { total: number; done: number; running: number; failed: number; queued: number };

function emptyStat(): StageStat {
  return { total: 0, done: 0, running: 0, failed: 0, queued: 0 };
}

/**
 * Live per-stage view of a library's preprocessing, read straight from batch_stage_jobs.
 * Self-polls (every 3s) only while something is in flight and `active` is true, so it stops
 * on its own when the library finishes. `compact` renders a horizontal dot strip for cards;
 * the default is a detailed vertical stepper for the drawer.
 */
export default function PipelineStepper({
  supabase,
  libraryId,
  active = true,
  compact = false,
}: {
  supabase: SupabaseClient;
  libraryId: string;
  active?: boolean;
  compact?: boolean;
}) {
  const [stats, setStats] = useState<Record<string, StageStat>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const { data } = await supabase
        .from("batch_stage_jobs")
        .select("stage, status")
        .eq("library_id", libraryId)
        .limit(5000);
      if (!alive) return;
      const m: Record<string, StageStat> = {};
      for (const r of (data || []) as { stage: string; status: string }[]) {
        const s = m[r.stage] || (m[r.stage] = emptyStat());
        s.total++;
        if (r.status === "done") s.done++;
        else if (r.status === "running") s.running++;
        else if (r.status === "failed") s.failed++;
        else s.queued++;
      }
      setStats(m);
      setLoaded(true);
      const inflight = Object.values(m).some((s) => s.running > 0 || s.queued > 0);
      if (alive && active && inflight) timer = setTimeout(load, 3000);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [supabase, libraryId, active]);

  const present = STAGES.filter((s) => stats[s.key]?.total);
  // Determine the "current" stage = first stage still running, else first with queued work.
  const currentKey =
    present.find((s) => (stats[s.key]?.running || 0) > 0)?.key ||
    present.find((s) => (stats[s.key]?.done || 0) < (stats[s.key]?.total || 0))?.key ||
    null;

  const stageState = (key: string): "done" | "running" | "failed" | "queued" | "idle" => {
    const s = stats[key];
    if (!s || s.total === 0) return "idle";
    if (s.failed > 0) return "failed";
    if (s.done >= s.total) return "done";
    if (key === currentKey || s.running > 0) return "running";
    return "queued";
  };

  if (!loaded) {
    return <div className={compact ? "h-1.5" : "py-3 text-xs text-white/40"}>{compact ? null : "Loading pipeline…"}</div>;
  }
  if (present.length === 0) {
    return <div className={compact ? "" : "py-2 text-xs text-white/40"}>{compact ? null : "No pipeline jobs yet."}</div>;
  }

  // ── Compact: a horizontal segmented strip for the card ───────────────────────────────
  if (compact) {
    return (
      <div className="flex items-center gap-1" title={currentKey ? `Processing: ${currentKey}` : "Pipeline"}>
        {present.map((s) => {
          const st = stageState(s.key);
          const stat = stats[s.key];
          const frac = stat.total ? stat.done / stat.total : 0;
          const color =
            st === "failed"
              ? "bg-rose-400"
              : st === "done"
                ? "bg-emerald-400"
                : st === "running"
                  ? "bg-violet-400"
                  : "bg-white/15";
          return (
            <div key={s.key} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10" title={`${s.label}: ${stat.done}/${stat.total}`}>
              <div
                className={`h-full rounded-full ${color} ${st === "running" ? "shimmer" : ""} transition-all`}
                style={{ width: st === "done" ? "100%" : `${Math.max(st === "running" ? 8 : 0, frac * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
    );
  }

  // ── Full: vertical stepper for the drawer ────────────────────────────────────────────
  return (
    <div className="space-y-1.5">
      {present.map((s) => {
        const st = stageState(s.key);
        const stat = stats[s.key];
        const frac = stat.total ? Math.round((stat.done / stat.total) * 100) : 0;
        return (
          <div key={s.key} className="flex items-center gap-3">
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] ${
                st === "done"
                  ? "bg-emerald-500/20 text-emerald-300"
                  : st === "running"
                    ? "bg-violet-500/25 text-violet-200"
                    : st === "failed"
                      ? "bg-rose-500/20 text-rose-300"
                      : "bg-white/8 text-white/40"
              }`}
            >
              {st === "done" ? (
                <FiCheck className="h-3.5 w-3.5" />
              ) : st === "failed" ? (
                <FiAlertTriangle className="h-3.5 w-3.5" />
              ) : st === "running" ? (
                <span className="h-3 w-3 rounded-full border-2 border-violet-300/40 border-t-violet-300 animate-spin" />
              ) : (
                <FiClock className="h-3 w-3" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className={st === "running" ? "text-white" : "text-white/70"}>{s.label}</span>
                <span className="text-white/40">
                  {stat.done}/{stat.total}
                  {stat.failed > 0 ? <span className="ml-1 text-rose-300">· {stat.failed} failed</span> : null}
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/8">
                <div
                  className={`h-full rounded-full ${
                    st === "failed" ? "bg-rose-400" : st === "running" ? "bg-violet-400 shimmer" : "bg-emerald-400"
                  }`}
                  style={{ width: `${st === "done" ? 100 : frac}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
