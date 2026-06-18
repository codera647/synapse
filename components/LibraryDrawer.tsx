"use client";

import { useEffect, useMemo, useState } from "react";
import { FiX, FiRefreshCcw, FiDatabase, FiLayers, FiTrash2, FiAlertTriangle, FiPlus } from "react-icons/fi";
import type { SupabaseClient } from "@supabase/supabase-js";
import PipelineStepper from "@/components/PipelineStepper";

type Library = {
  id: string;
  name: string;
  status: string;
  created_at: string | null;
  source_type?: string | null;
  pipeline_status?: string | null;
  pipeline_stage?: string | null;
  pipeline_progress_percent?: number | null;
  pipeline_error?: string | null;
  total_batches?: number | null;
  completed_batches?: number | null;
  last_synced_at?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  library: Library | null;
  organizationId: string | null;
  supabase: SupabaseClient;
  onLog?: (entry: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;
  onDeleted?: (libraryId: string) => void;
  onAddFiles?: () => void;
  onRetry?: () => void;
  canAddFiles?: boolean;
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function pct(v: number | null | undefined) {
  if (typeof v !== "number") return 0;
  return Math.max(0, Math.min(100, v));
}

// The backend already writes friendly pipeline errors; this is a defensive map for any raw or
// legacy messages so the user never sees a CUDA stack trace.
function friendlyError(raw: string): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("googleapis.com/drive") || s.includes("drive/v3/files") || (s.includes("drive") && s.includes("400")))
    return "Couldn't read the source folder from Google Drive. If this is a local (desktop) library, click Retry to reprocess the files you uploaded.";
  if (s.includes("503") || s.includes("502") || s.includes("bad gateway") || s.includes("service unavailable"))
    return "The server was busy and an upload didn't complete. Click Retry to process the files again.";
  if (s.includes("out of memory") || (s.includes("cuda") && s.includes("memory")))
    return "Ran out of GPU memory on a processing stage. Lower that stage's workers in Settings → Processing, then click Resume — finished stages are kept.";
  if (s.includes("rate limit") || s.includes("quota") || s.includes("429"))
    return "The AI service was rate-limited or out of quota. Wait a moment, then click Resume to retry.";
  if (s.includes("timeout") || s.includes("timed out") || s.includes("connection"))
    return "A network/service timeout interrupted processing. Click Resume to retry.";
  if (s.includes("api key") || s.includes("unauthorized") || s.includes("401"))
    return "An API key was missing or invalid for a stage. Check the backend config, then Resume.";
  return raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
}

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-white/10 bg-white/4 p-4 transition-colors hover:bg-white/6"
      style={{ boxShadow: "0 10px 35px rgba(0,0,0,0.18)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{label}</div>
          <div className="mt-2 truncate text-sm font-semibold text-gray-100">{value}</div>
          {hint ? <div className="mt-1 text-[11px] text-gray-500">{hint}</div> : null}
        </div>
        {icon ? (
          <div className="shrink-0 rounded-lg border border-white/10 bg-black/20 p-2 text-gray-300">{icon}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function LibraryDrawer({ open, onClose, library, organizationId, supabase, onLog, onDeleted, onAddFiles, onRetry, canAddFiles }: Props) {
  const [docsCount, setDocsCount] = useState<number | null>(null);
  const [embedCount, setEmbedCount] = useState<number | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showErrDetails, setShowErrDetails] = useState(false);

  const libId = library?.id ?? null;

  const statusLabel = useMemo(() => {
    if (!library) return "—";
    return String(library.pipeline_status || library.status || "idle");
  }, [library]);

  const refresh = async () => {
    if (!open || !libId) return;
    setLoading(true);
    try {
      const [docs, embeds, libMeta] = await Promise.all([
        supabase.from("documents").select("id", { count: "exact", head: true }).eq("library_id", libId),
        supabase.from("chunk_embeddings").select("chunk_id", { count: "exact", head: true }).eq("library_id", libId),
        supabase.from("libraries").select("last_synced_at, pipeline_finished_at").eq("id", libId).single(),
      ]);

      setDocsCount(typeof docs.count === "number" ? docs.count : null);
      setEmbedCount(typeof embeds.count === "number" ? embeds.count : null);
      const meta = (libMeta.data && typeof libMeta.data === "object" ? libMeta.data : {}) as {
        last_synced_at?: string | null;
        pipeline_finished_at?: string | null;
      };
      // Older completed libraries never recorded last_synced_at — fall back to when the pipeline
      // finished so "Last Synced" isn't perpetually blank.
      setLastSyncedAt(meta.last_synced_at ?? meta.pipeline_finished_at ?? null);

      if (docs.error) onLog?.({ level: "warn", message: "Drawer: failed to fetch documents count", details: docs.error });
      if (embeds.error) onLog?.({ level: "warn", message: "Drawer: failed to fetch embeddings count", details: embeds.error });
      if (libMeta.error) onLog?.({ level: "warn", message: "Drawer: failed to fetch library metadata", details: libMeta.error });
    } catch (err) {
      onLog?.({ level: "error", message: "Drawer: refresh failed", details: err });
    } finally {
      setLoading(false);
    }
  };

  const deleteLibrary = async () => {
    if (!libId || !organizationId) {
      setDeleteError("Missing organization/library id.");
      return;
    }
    const ok = window.confirm("Delete this library and all its processed artifacts? This cannot be undone.");
    if (!ok) return;

    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/library/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ library_id: libId, organization_id: organizationId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = payload?.error || `Failed to delete library (HTTP ${res.status}).`;
        setDeleteError(msg);
        onLog?.({ level: "error", message: "Drawer: delete failed", details: payload ?? msg });
        return;
      }
      onLog?.({ level: "success", message: "Library deleted", details: { library_id: libId } });
      onDeleted?.(libId);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeleteError(msg);
      onLog?.({ level: "error", message: "Drawer: delete failed", details: err });
    } finally {
      setDeleteLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !libId) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, libId]);

  if (!library) return null;

  return (
    <>
      <button
        aria-label="Close library panel"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/35 backdrop-blur-[1px] transition-opacity ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      />

      <aside
        className={`fixed right-0 top-14 z-50 h-[calc(100vh-3.5rem)] w-[420px] max-w-[92vw] border-l border-white/10 transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          background:
            "linear-gradient(180deg, rgba(18,24,39,0.96) 0%, rgba(15,19,32,0.98) 55%, rgba(11,15,26,0.99) 100%)",
          boxShadow: "-20px 0 80px rgba(0,0,0,0.35)",
        }}
      >
        <div className="h-full overflow-auto px-4 sm:px-5 pb-6 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Library</div>
              <div className="mt-1 truncate text-xl font-semibold text-gray-100">{library.name}</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-gray-200">
                  {statusLabel}
                </span>
                <span className="text-[11px] text-gray-500">{Math.round(pct(library.pipeline_progress_percent))}%</span>
              </div>
              {library.pipeline_error ? (
                <div className="mt-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.08] p-3">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-500/15 text-red-300">
                      <FiAlertTriangle className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-red-100">Processing didn&apos;t finish</div>
                      <p className="mt-0.5 text-xs leading-relaxed text-red-200/90">
                        {friendlyError(library.pipeline_error)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {onRetry ? (
                          <button
                            type="button"
                            onClick={onRetry}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-500/15 px-2.5 py-1 text-[11px] font-medium text-red-100 transition-colors hover:bg-red-500/25"
                          >
                            <FiRefreshCcw className="h-3 w-3" /> Retry processing
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setShowErrDetails((v) => !v)}
                          className="text-[11px] text-red-200/70 underline-offset-2 hover:text-red-100 hover:underline"
                        >
                          {showErrDetails ? "Hide details" : "Show details"}
                        </button>
                      </div>
                      {showErrDetails ? (
                        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[10px] leading-relaxed text-red-200/70">
                          {library.pipeline_error}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {onAddFiles && canAddFiles && library.pipeline_status === "completed" ? (
                <button
                  type="button"
                  onClick={onAddFiles}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-medium text-gray-200 hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white transition-colors"
                  title="Add files to this library"
                >
                  <FiPlus className="h-4 w-4" /> Add files
                </button>
              ) : null}
              <button
                type="button"
                onClick={deleteLibrary}
                disabled={deleteLoading || loading}
                className="rounded-lg border border-red-500/35 bg-red-500/10 p-2 text-red-200 hover:bg-red-500/15 hover:text-red-100 transition-colors disabled:opacity-60"
                title="Delete library"
              >
                <FiTrash2 className={`h-4 w-4 ${deleteLoading ? "animate-pulse" : ""}`} />
              </button>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="rounded-lg border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-60"
                title="Refresh"
              >
                <FiRefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/10 bg-white/5 p-2 text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
                title="Close"
              >
                <FiX className="h-4 w-4" />
              </button>
            </div>
          </div>

          {deleteError ? (
            <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {deleteError}
            </div>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/[0.06]">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out ${
                  (library.pipeline_status || "") !== "completed" && (library.pipeline_status || "") !== "failed"
                    ? "shimmer"
                    : ""
                }`}
                style={{
                  width: `${pct(library.pipeline_progress_percent)}%`,
                  background:
                    (library.pipeline_status || "") === "completed"
                      ? "linear-gradient(90deg, #34d399, #2dd4bf)"
                      : (library.pipeline_status || "") === "failed"
                        ? "linear-gradient(90deg, #f43f5e, #fb7185)"
                        : "linear-gradient(90deg, rgba(184,127,217,0.95) 0%, rgba(217,70,239,0.9) 55%, rgba(139,92,246,0.9) 100%)",
                  boxShadow:
                    (library.pipeline_status || "") === "completed"
                      ? "0 0 14px rgba(52,211,153,0.45)"
                      : (library.pipeline_status || "") === "failed"
                        ? "0 0 14px rgba(244,63,94,0.4)"
                        : "0 0 14px rgba(167,139,250,0.5)",
                }}
              />
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums text-white/80">
              {Math.round(pct(library.pipeline_progress_percent))}%
            </span>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <StatCard label="Documents" value={docsCount === null ? "—" : String(docsCount)} hint="Indexed in Supabase" icon={<FiDatabase className="h-4 w-4" />} />
            <StatCard label="Last Synced" value={formatDate(lastSyncedAt ?? library.last_synced_at ?? null)} hint="From Drive to R2" icon={<FiLayers className="h-4 w-4" />} />
            <StatCard label="Embeddings" value={embedCount === null ? "—" : String(embedCount)} hint="Chunks embedded" />
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/4 p-4">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Pipeline</div>
              <div className="text-[11px] text-gray-500">
                {library.pipeline_stage ? <span className="text-gray-300">{library.pipeline_stage}</span> : null}
              </div>
            </div>
            <div className="mt-3">
              <PipelineStepper supabase={supabase} libraryId={library.id} active={open} />
            </div>
            <div className="mt-3 border-t border-white/8 pt-2 text-xs text-gray-500">
              Created: {formatDate(library.created_at)} · Source: {library.source_type ?? "google_drive"}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
