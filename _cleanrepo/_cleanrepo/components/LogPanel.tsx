"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FiChevronDown, FiTrash2, FiCopy } from "react-icons/fi";
import type { LogEntry, LogLevel } from "@/context/LogContext";

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function levelBadge(level: LogLevel) {
  switch (level) {
    case "error":
      return "bg-red-500/15 text-red-200 border border-red-500/30";
    case "warn":
      return "bg-yellow-500/15 text-yellow-100 border border-yellow-500/30";
    case "success":
      return "bg-emerald-500/15 text-emerald-200 border border-emerald-500/30";
    default:
      return "bg-white/8 text-gray-200 border border-white/10";
  }
}

type LibraryLite = { id: string; name: string; pipeline_status?: string | null };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

type Props = {
  open: boolean;
  onClose: () => void;
  logs: LogEntry[];
  libraries?: LibraryLite[];
  onClear: () => void;
  defaultHeight?: number;
};

export default function LogPanel({ open, onClose, logs, libraries, onClear, defaultHeight = 280 }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startH: number; dragging: boolean }>({
    startY: 0,
    startH: defaultHeight,
    dragging: false,
  });

  const [height, setHeight] = useState<number>(() => {
    if (typeof window === "undefined") return defaultHeight;
    const raw = window.localStorage.getItem("synapse_log_panel_height");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 120 ? n : defaultHeight;
  });

  const [filter, setFilter] = useState<"all" | "pipeline" | "errors">("all");
  const [pipelineView, setPipelineView] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<string>("all");

  const libraryNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of libraries ?? []) {
      if (l?.id && l?.name) m.set(l.id, l.name);
    }
    return m;
  }, [libraries]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("synapse_log_panel_height", String(height));
    }
  }, [height]);

  const processingLibraries = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; pipeline_status?: string | null; count: number }>();
    for (const l of libraries ?? []) byId.set(l.id, { ...l, count: 0 });
    for (const log of logs) {
      if (!log.libraryId) continue;
      const row = byId.get(log.libraryId);
      if (row) row.count += 1;
      else
        byId.set(log.libraryId, {
          id: log.libraryId,
          name: libraryNameById.get(log.libraryId) ?? "Unknown library",
          count: 1,
        });
    }
    const isProcessing = (s: string | null | undefined) => {
      const v = (s ?? "").toLowerCase();
      return v === "queued" || v === "running";
    };
    return Array.from(byId.values())
      .filter((l) => (l.pipeline_status ? isProcessing(l.pipeline_status) : l.count > 0))
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, 12);
  }, [libraries, logs, libraryNameById]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((l) => {
      if (filter === "errors" && l.level !== "error") return false;
      if (filter === "pipeline" && l.source !== "pipeline") return false;
      if (libraryFilter !== "all" && l.libraryId !== libraryFilter) return false;
      if (!q) return true;
      const hay = `${l.source} ${l.level} ${l.message}`.toLowerCase();
      return hay.includes(q);
    });
  }, [logs, filter, query, libraryFilter]);

  const pipelineStages = useMemo(
    () => ["sync", "layout_parser", "text_extraction", "image_captioning", "chunking", "embedding"],
    []
  );

  const pipelineLive = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = logs.filter((l) => {
      if (l.source !== "pipeline") return false;
      if (!l.key || !l.key.startsWith("pipeline:")) return false;
      if (libraryFilter !== "all" && l.libraryId !== libraryFilter) return false;
      return true;
    });
    const byStage = new Map<string, LogEntry[]>();
    for (const l of live) {
      const d = asRecord(l.details);
      const st = getStr(d, "stage");
      if (!st) continue;
      if (q) {
        const hay = `${l.source} ${l.level} ${l.message}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (!byStage.has(st)) byStage.set(st, []);
      byStage.get(st)!.push(l);
    }

    const order = new Map<string, number>([
      ["failed", 0],
      ["running", 1],
      ["queued", 2],
      ["done", 3],
      ["canceled", 4],
    ]);
    for (const arr of byStage.values()) {
      arr.sort((a, b) => {
        const ad = asRecord(a.details);
        const bd = asRecord(b.details);
        const as = getStr(ad, "status");
        const bs = getStr(bd, "status");
        const ao = order.get(as) ?? 9;
        const bo = order.get(bs) ?? 9;
        if (ao !== bo) return ao - bo;
        return b.ts - a.ts;
      });
    }

    return { live, byStage };
  }, [logs, query, libraryFilter]);

  const copy = async () => {
    const payload = filtered.map((l) => ({
      time: new Date(l.ts).toISOString(),
      level: l.level,
      source: l.source,
      message: l.message,
      details: l.details,
      libraryId: l.libraryId,
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      // ignore
    }
  };

  const onPointerDown = (ev: ReactPointerEvent) => {
    dragRef.current.dragging = true;
    dragRef.current.startY = ev.clientY;
    dragRef.current.startH = height;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: ReactPointerEvent) => {
    if (!dragRef.current.dragging) return;
    const dy = dragRef.current.startY - ev.clientY;
    const next = Math.max(140, Math.min(Math.floor(window.innerHeight * 0.72), dragRef.current.startH + dy));
    setHeight(next);
  };

  const onPointerUp = () => {
    dragRef.current.dragging = false;
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="fixed bottom-0 left-14 right-0 z-50"
      style={{ height }}
    >
      <div
        className="h-full border-t border-white/10 shadow-[0_-10px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(180deg, rgba(18,24,39,0.92) 0%, rgba(14,18,30,0.96) 55%, rgba(11,15,26,0.98) 100%)",
        }}
      >
        {/* Drag handle */}
        <div
          className="relative h-6 cursor-ns-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="absolute left-1/2 top-1/2 h-1 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/15" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(184,127,217,0.18),transparent_55%)]" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 pb-2">
          <div className="flex items-center gap-3">
            <div className="text-[11px] tracking-[0.22em] uppercase text-gray-400">
              Console
            </div>
            <div className="text-[10px] text-gray-500">
              {logs.length} events
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter logs"
              className="hidden sm:block w-48 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-white/20"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}
            />

            <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/4 p-0.5">
              {(["all", "pipeline", "errors"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  className={`rounded-md px-2 py-1 text-[11px] transition-colors ${filter === k ? "bg-white/10 text-gray-100" : "text-gray-400 hover:text-gray-100"}`}
                >
                  {k === "all" ? "All" : k === "pipeline" ? "Pipeline" : "Errors"}
                </button>
              ))}
            </div>

            {/* Library selector */}
            <div className="hidden lg:flex items-center gap-1 max-w-[440px] overflow-x-auto no-scrollbar">
              <button
                type="button"
                onClick={() => setLibraryFilter("all")}
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  libraryFilter === "all"
                    ? "border-white/20 bg-white/10 text-gray-100"
                    : "border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                }`}
                title="Show logs for all libraries"
              >
                All libraries
              </button>
              {processingLibraries.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLibraryFilter(l.id)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                    libraryFilter === l.id
                      ? "border-[#b87fd9]/50 bg-[#884ab4]/25 text-gray-100"
                      : "border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                  }`}
                  title="Filter logs to this library"
                >
                  <span className="max-w-[180px] truncate inline-block align-bottom">{l.name}</span>
                </button>
              ))}
            </div>

            {filter === "pipeline" && (
              <button
                type="button"
                onClick={() => setPipelineView((v) => !v)}
                className={`rounded-md border border-white/10 px-2 py-1 text-[11px] transition-colors ${pipelineView ? "bg-white/10 text-gray-100" : "bg-white/5 text-gray-300 hover:text-white hover:bg-white/10"}`}
                title="Toggle grouped pipeline view"
              >
                {pipelineView ? "Timeline" : "Grouped"}
              </button>
            )}

            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
              title="Copy filtered logs as JSON"
            >
              <FiCopy className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={onClear}
              className="rounded-md border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
              title="Clear"
            >
              <FiTrash2 className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
              title="Hide"
            >
              <FiChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="h-[calc(100%-56px)] overflow-auto px-2 pb-3">
          {filter === "pipeline" && pipelineView ? (
            <div className="px-2 pb-3">
              {pipelineStages.map((st) => {
                const items = pipelineLive.byStage.get(st) ?? [];
                if (items.length === 0) return null;
                const failed = items.filter((i) => getStr(asRecord(i.details), "status") === "failed").length;
                const running = items.filter((i) => getStr(asRecord(i.details), "status") === "running").length;
                const queued = items.filter((i) => getStr(asRecord(i.details), "status") === "queued").length;
                return (
                  <div key={st} className="mb-3 rounded-xl border border-white/10 bg-white/3">
                    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/8">
                      <div className="text-xs font-medium text-gray-200">{st}</div>
                      <div className="text-[11px] text-gray-500">
                        {items.length} · {failed ? `${failed} failed` : "0 failed"} · {running ? `${running} running` : "0 running"} · {queued ? `${queued} queued` : "0 queued"}
                      </div>
                    </div>
                    <div className="divide-y divide-white/6">
                      {items.slice(0, 250).map((l) => {
                        const d = asRecord(l.details);
                        const status = getStr(d, "status");
                        const batchShort =
                          String(l.message.match(/Batch ([0-9a-f]{1,8})/i)?.[1] ?? "") ||
                          (l.libraryId ? libraryNameById.get(l.libraryId) ?? "Unknown library" : "Unknown library");
                        const progRaw = d.progress;
                        const prog = Array.isArray(progRaw) ? progRaw : null;
                        return (
                          <div key={l.id} className="px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1 text-xs text-gray-200 truncate">
                                <span className="text-gray-500">{batchShort}</span>
                                <span className="mx-2 text-gray-600">·</span>
                                <span className="text-gray-300">{status}</span>
                                {prog && (
                                  <>
                                    <span className="mx-2 text-gray-600">·</span>
                                    <span className="text-gray-400">
                                      {String(prog[0] ?? 0)}/{String(prog[1] ?? 0)}
                                    </span>
                                  </>
                                )}
                                {getStr(d, "worker") ? (
                                  <>
                                    <span className="mx-2 text-gray-600">·</span>
                                    <span className="text-gray-500">{getStr(d, "worker")}</span>
                                  </>
                                ) : null}
                              </div>
                              <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[10px] ${levelBadge(l.level)}`}>
                                {l.level.toUpperCase()}
                              </span>
                            </div>
                            {getStr(d, "error") ? (
                              <div className="mt-1 text-[11px] text-red-200/90">{getStr(d, "error")}</div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {pipelineLive.live.length === 0 && (
                <div className="px-4 py-10 text-sm text-gray-500">No pipeline jobs yet.</div>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-10 text-sm text-gray-500">No logs to show.</div>
          ) : (
            <div className="space-y-1 px-2">
              {filtered.slice(-800).map((l) => {
                const isExpanded = expanded.has(l.id);
                return (
                  <div key={l.id} className="rounded-lg border border-white/8 bg-white/3 hover:bg-white/5 transition-colors">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(l.id)) next.delete(l.id);
                          else next.add(l.id);
                          return next;
                        })
                      }
                      className="w-full text-left px-3 py-2"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="mt-[2px] shrink-0 rounded-full px-2 py-[2px] text-[10px] font-medium"
                          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}
                        >
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-[2px] ${levelBadge(l.level)}`}>
                            {l.level.toUpperCase()}
                          </span>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <div className="truncate text-xs text-gray-200">
                              <span className="text-gray-500">{formatTime(l.ts)}</span>
                              <span className="mx-2 text-gray-600">·</span>
                              <span className="text-gray-400">{l.source}</span>
                              <span className="mx-2 text-gray-600">·</span>
                              <span className="text-gray-100">{l.message}</span>
                            </div>
                              <div className="shrink-0 text-[10px] text-gray-500">
                              {l.libraryId
                                ? (libraryNameById.get(l.libraryId) ?? "Unknown library")
                                : ""}
                            </div>
                          </div>
                          {isExpanded && l.details !== undefined && (
                            <pre
                              className="mt-2 max-h-64 overflow-auto rounded-md border border-white/8 bg-black/30 p-2 text-[11px] leading-relaxed text-gray-200"
                              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}
                            >
                              {typeof l.details === "string"
                                ? l.details
                                : JSON.stringify(l.details, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
