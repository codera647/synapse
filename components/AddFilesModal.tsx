"use client";

import { useCallback, useRef, useState } from "react";
import {
  FiX, FiUploadCloud, FiFile, FiTrash2, FiHardDrive, FiRefreshCw, FiLoader, FiAlertTriangle,
} from "react-icons/fi";
import {
  openGoogleDriveFilePicker, downloadDriveFile, driveFileName, type PickedDriveFile,
} from "@/lib/googleDrivePicker";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import { countDocuments, sumStorageBytes, getUserOrgIds, getUserPlan } from "@/lib/usage";
import { planLimits } from "@/lib/planLimits";
import LimitReachedDialog, { type LimitInfo } from "@/components/LimitReachedDialog";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;
type StagedDrive = PickedDriveFile & { token: string };

export default function AddFilesModal({
  open,
  onClose,
  organizationId,
  library,
  currentUserId,
  allowDrivePicker = true,
  allowRescan = true,
  onStarted,
  onLog,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  library: { id: string; name: string };
  currentUserId?: string | null;
  allowDrivePicker?: boolean;
  allowRescan?: boolean;
  onStarted?: (libraryId: string) => void;
  onLog?: LogFn;
}) {
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [driveFiles, setDriveFiles] = useState<StagedDrive[]>([]);
  const [rescan, setRescan] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDuplicates, setPendingDuplicates] = useState<string[] | null>(null);
  const [limitInfo, setLimitInfo] = useState<LimitInfo | null>(null);
  const [limitPlanLabel, setLimitPlanLabel] = useState("Free");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const supabaseRef = useRef<ReturnType<typeof createSupabaseBrowserClient> | null>(null);
  if (!supabaseRef.current) supabaseRef.current = createSupabaseBrowserClient();

  const addLocal = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    setLocalFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }, []);

  const pickDrive = useCallback(async () => {
    try {
      await openGoogleDriveFilePicker((files, token) => {
        setDriveFiles((prev) => {
          const ids = new Set(prev.map((f) => f.id));
          return [...prev, ...files.filter((f) => !ids.has(f.id)).map((f) => ({ ...f, token }))];
        });
      });
    } catch (e) {
      onLog?.({ level: "warn", message: "Drive picker error", details: e });
      setError("Couldn't open the Google Drive picker.");
    }
  }, [onLog]);

  const total = localFiles.length + driveFiles.length + (rescan ? 1 : 0);

  // ---- the actual upload, given the user's duplicate decision ----
  const proceed = useCallback(
    async (choice: "none" | "replace" | "skip", duplicates: string[]) => {
      setPendingDuplicates(null);
      setSubmitting(true);
      setError(null);
      try {
        const replace = choice === "replace";
        const dupSet = new Set(choice === "skip" ? duplicates : []);
        const acting = currentUserId ?? null;

        // Build the file list for the local-upload endpoint (local + downloaded Drive files).
        const uploadFiles: File[] = localFiles.filter((f) => !dupSet.has(f.name));
        for (const d of driveFiles) {
          if (dupSet.has(driveFileName(d))) continue;
          uploadFiles.push(await downloadDriveFile(d, d.token));
        }

        const docIds: string[] = [];

        if (uploadFiles.length) {
          const fd = new FormData();
          fd.append("organization_id", organizationId);
          fd.append("library_id", library.id);
          if (currentUserId) {
            fd.append("created_by_user_id", currentUserId);
            fd.append("acting_user_id", currentUserId);
          }
          fd.append("replace", replace ? "true" : "false");
          uploadFiles.forEach((f) => fd.append("files", f));
          const res = await fetch("/api/library/add-files/upload", { method: "POST", body: fd });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || j.error) throw new Error(j.error || `Upload failed (HTTP ${res.status})`);
          docIds.push(...(j.doc_ids || []));
        }

        if (rescan && allowRescan) {
          const res = await fetch("/api/backend/library/add-files/drive", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              organization_id: organizationId,
              library_id: library.id,
              mode: "rescan",
              acting_user_id: acting,
              replace,
            }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || j.error) throw new Error(j.error || `Re-scan failed (HTTP ${res.status})`);
          docIds.push(...(j.doc_ids || []));
        }

        if (docIds.length === 0) {
          setError("No new files were added (they may already be in this library).");
          setSubmitting(false);
          return;
        }

        const commit = await fetch("/api/backend/library/add-files/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organization_id: organizationId, library_id: library.id, doc_ids: docIds, acting_user_id: acting }),
        });
        const cj = await commit.json().catch(() => ({}));
        if (!commit.ok || cj.error) throw new Error(cj.error || `Couldn't start processing (HTTP ${commit.status})`);

        onLog?.({ level: "success", message: `Added ${docIds.length} file(s) to "${library.name}" — processing started.` });
        onStarted?.(library.id);
        setLocalFiles([]); setDriveFiles([]); setRescan(false);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
        onLog?.({ level: "error", message: "Add files failed", details: e });
      } finally {
        setSubmitting(false);
      }
    },
    [localFiles, driveFiles, rescan, allowRescan, organizationId, library, currentUserId, onStarted, onClose, onLog],
  );

  // ---- click handler: duplicate pre-check, then proceed (or prompt) ----
  const onAddClick = useCallback(async () => {
    if (submitting || total === 0) return;
    setError(null);
    const candidateNames = [...localFiles.map((f) => f.name), ...driveFiles.map((d) => driveFileName(d))];

    // Enforce the org's plan limits before doing any work.
    const sb = supabaseRef.current;
    if (sb) {
      try {
        const orgIds = await getUserOrgIds(sb);
        const [plan, docs, used] = await Promise.all([
          getUserPlan(sb, orgIds),
          countDocuments(sb, orgIds),
          sumStorageBytes(sb, orgIds),
        ]);
        const lim = planLimits(plan);
        setLimitPlanLabel(lim.label);
        const adding = candidateNames.length; // re-scan count is unknown; counted server-side
        if (Number.isFinite(lim.documents) && docs + adding > lim.documents) {
          setLimitInfo({
            title: "Document limit reached",
            message: `Your ${lim.label} plan covers up to ${lim.documents.toLocaleString()} documents and you already have ${docs.toLocaleString()}. Remove some files or upgrade to add more.`,
            used: docs, limit: lim.documents, unit: "docs",
          });
          return;
        }
        const stagedBytes = localFiles.reduce((n, f) => n + (f.size || 0), 0);
        if (Number.isFinite(lim.storageBytes) && used + stagedBytes > lim.storageBytes) {
          setLimitInfo({
            title: "Storage limit reached",
            message: `Your ${lim.label} plan includes ${fmtBytes(lim.storageBytes)} of storage and you're using ${fmtBytes(used)}. Free up space or upgrade to add more.`,
            used, limit: lim.storageBytes, fmt: fmtBytes,
          });
          return;
        }
      } catch {
        /* if the usage check fails, don't block the user */
      }
    }

    if (candidateNames.length === 0) {
      // only a re-scan staged — nothing to pre-check
      void proceed("none", []);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/backend/library/add-files/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          library_id: library.id,
          filenames: candidateNames,
          acting_user_id: currentUserId ?? null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(j.error || `Check failed (HTTP ${res.status})`);
      const dups: string[] = j.duplicates || [];
      setSubmitting(false);
      if (dups.length > 0) {
        setPendingDuplicates(dups);
        return;
      }
      void proceed("none", []);
    } catch (e) {
      setSubmitting(false);
      setError(e instanceof Error ? e.message : "Couldn't check for duplicates.");
    }
  }, [submitting, total, localFiles, driveFiles, organizationId, library, currentUserId, proceed]);

  if (!open) return null;

  return (
    <>
    <LimitReachedDialog
      info={limitInfo}
      planLabel={limitPlanLabel}
      onClose={() => setLimitInfo(null)}
    />
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-[2px]"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
        style={{ backgroundColor: "rgba(20, 25, 37, 0.98)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold tracking-tight">Add files</h2>
            <p className="mt-0.5 text-xs text-white/45">
              to <span className="text-white/70">{library.name}</span> · only the new files are processed
            </p>
          </div>
          <button onClick={() => !submitting && onClose()} className="rounded-lg p-1.5 text-white/50 hover:text-white">
            <FiX className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* From your computer */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            if (e.dataTransfer.files?.length) addLocal(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`mt-3 cursor-pointer rounded-xl border border-dashed p-5 text-center transition ${
            dragOver ? "border-violet-400/60 bg-violet-500/10" : "border-white/15 bg-white/[0.02] hover:bg-white/[0.04]"
          }`}
        >
          <FiUploadCloud className="mx-auto h-6 w-6 text-violet-300" />
          <p className="mt-2 text-sm text-white/80">Drag files here, or <span className="text-violet-300">browse your computer</span></p>
          <p className="mt-0.5 text-[11px] text-white/35">PDF, Word, Excel, CSV, images, code files, and more</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files?.length) addLocal(e.target.files); e.target.value = ""; }}
          />
        </div>

        {/* Google Drive */}
        {(allowDrivePicker || allowRescan) ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {allowDrivePicker ? (
              <button
                type="button"
                onClick={() => void pickDrive()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:text-white"
              >
                <FiHardDrive className="h-3.5 w-3.5 text-violet-300" /> Pick Google Drive files
              </button>
            ) : null}
            {allowRescan ? (
              <button
                type="button"
                onClick={() => setRescan((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                  rescan ? "border-violet-400/50 bg-violet-500/15 text-white" : "border-white/10 bg-white/5 text-white/80 hover:text-white"
                }`}
              >
                <FiRefreshCw className="h-3.5 w-3.5" /> Re-scan connected folder
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Staged items */}
        {(localFiles.length > 0 || driveFiles.length > 0 || rescan) && (
          <div className="mt-3 max-h-40 space-y-1.5 overflow-auto rounded-xl border border-white/8 bg-white/[0.02] p-2">
            {localFiles.map((f, i) => (
              <StagedRow key={`l-${f.name}-${i}`} icon={<FiFile className="h-3.5 w-3.5 text-white/50" />}
                label={f.name} sub="from your computer"
                onRemove={() => setLocalFiles((p) => p.filter((_, j) => j !== i))} />
            ))}
            {driveFiles.map((f) => (
              <StagedRow key={`d-${f.id}`} icon={<FiHardDrive className="h-3.5 w-3.5 text-violet-300" />}
                label={f.name} sub="from Google Drive"
                onRemove={() => setDriveFiles((p) => p.filter((x) => x.id !== f.id))} />
            ))}
            {rescan && (
              <StagedRow icon={<FiRefreshCw className="h-3.5 w-3.5 text-violet-300" />}
                label="Scan connected Drive folder for new files" sub="re-scan"
                onRemove={() => setRescan(false)} />
            )}
          </div>
        )}

        {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}

        {/* Duplicate prompt */}
        {pendingDuplicates && pendingDuplicates.length > 0 ? (
          <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/10 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-amber-200">
              <FiAlertTriangle className="h-3.5 w-3.5" />
              {pendingDuplicates.length} file{pendingDuplicates.length > 1 ? "s" : ""} already exist in this library
            </div>
            <div className="mt-1.5 max-h-16 overflow-auto text-[11px] text-white/55">
              {pendingDuplicates.join(", ")}
            </div>
            <div className="mt-2.5 flex flex-wrap justify-end gap-2">
              <button onClick={() => setPendingDuplicates(null)} className="rounded-lg px-3 py-1.5 text-xs text-white/60 hover:text-white">
                Cancel
              </button>
              <button
                onClick={() => void proceed("skip", pendingDuplicates)}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:text-white"
              >
                Skip duplicates
              </button>
              <button
                onClick={() => void proceed("replace", pendingDuplicates)}
                className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/25"
              >
                Replace
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-end gap-2">
            <button onClick={() => !submitting && onClose()} className="rounded-lg px-3 py-2 text-xs text-white/60 hover:text-white">
              Cancel
            </button>
            <button
              onClick={() => void onAddClick()}
              disabled={submitting || total === 0}
              className="btn-grad inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {submitting ? <><FiLoader className="h-3.5 w-3.5 animate-spin" /> Adding…</> : "Add & process"}
            </button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

function StagedRow({ icon, label, sub, onRemove }: { icon: React.ReactNode; label: string; sub: string; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate text-xs text-white/85">{label}</span>
        <span className="shrink-0 text-[10px] text-white/35">· {sub}</span>
      </div>
      <button onClick={onRemove} className="shrink-0 rounded p-1 text-white/40 hover:text-rose-300">
        <FiTrash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
