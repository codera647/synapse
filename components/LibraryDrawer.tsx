"use client";

import { useEffect, useMemo, useState } from "react";
import { FiX, FiRefreshCcw, FiDatabase, FiLayers, FiTrash2 } from "react-icons/fi";
import type { SupabaseClient } from "@supabase/supabase-js";

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

export default function LibraryDrawer({ open, onClose, library, organizationId, supabase, onLog, onDeleted }: Props) {
  const [docsCount, setDocsCount] = useState<number | null>(null);
  const [embedCount, setEmbedCount] = useState<number | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
        supabase.from("libraries").select("last_synced_at").eq("id", libId).single(),
      ]);

      setDocsCount(typeof docs.count === "number" ? docs.count : null);
      setEmbedCount(typeof embeds.count === "number" ? embeds.count : null);
      const meta = libMeta.data;
      const last =
        meta && typeof meta === "object" && "last_synced_at" in meta
          ? (meta as { last_synced_at: string | null }).last_synced_at
          : null;
      setLastSyncedAt(last);

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
        className={`fixed right-0 top-14 z-50 h-[calc(100vh-56px)] w-[420px] max-w-[92vw] border-l border-white/10 transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          background:
            "linear-gradient(180deg, rgba(18,24,39,0.96) 0%, rgba(15,19,32,0.98) 55%, rgba(11,15,26,0.99) 100%)",
          boxShadow: "-20px 0 80px rgba(0,0,0,0.35)",
        }}
      >
        <div className="h-full overflow-auto px-5 pb-6 pt-5">
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
                <div className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  {library.pipeline_error}
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
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

          <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full"
              style={{
                width: `${pct(library.pipeline_progress_percent)}%`,
                background:
                  "linear-gradient(90deg, rgba(184,127,217,0.95) 0%, rgba(136,74,180,0.92) 55%, rgba(59,130,246,0.65) 100%)",
                boxShadow: "0 0 0 1px rgba(255,255,255,0.06) inset",
              }}
            />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <StatCard label="Documents" value={docsCount === null ? "—" : String(docsCount)} hint="Indexed in Supabase" icon={<FiDatabase className="h-4 w-4" />} />
            <StatCard label="Last Synced" value={formatDate(lastSyncedAt ?? library.last_synced_at ?? null)} hint="From Drive to R2" icon={<FiLayers className="h-4 w-4" />} />
            <StatCard label="Embeddings" value={embedCount === null ? "—" : String(embedCount)} hint="Chunks embedded" />
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/4 p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Pipeline</div>
            <div className="mt-2 text-sm text-gray-200">
              Stage: <span className="text-gray-100">{library.pipeline_stage ?? "—"}</span>
            </div>
            <div className="mt-1 text-xs text-gray-500">
              Created: {formatDate(library.created_at)} · Source: {library.source_type ?? "google_drive"}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
