"use client";

import { useCallback, useRef, useState } from "react";
import {
  FiX, FiUploadCloud, FiFile, FiTrash2, FiHardDrive, FiRefreshCw, FiLoader,
} from "react-icons/fi";
import { openGoogleDriveFilePicker, type PickedDriveFile } from "@/lib/googleDrivePicker";

type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

export default function AddFilesModal({
  open,
  onClose,
  organizationId,
  library,
  currentUserId,
  allowDrive = true,
  onStarted,
  onLog,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  library: { id: string; name: string };
  currentUserId?: string | null;
  allowDrive?: boolean;
  onStarted?: (libraryId: string) => void;
  onLog?: LogFn;
}) {
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [driveFiles, setDriveFiles] = useState<PickedDriveFile[]>([]);
  const [rescan, setRescan] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addLocal = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    setLocalFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }, []);

  const pickDrive = useCallback(async () => {
    try {
      await openGoogleDriveFilePicker((files) => {
        setDriveFiles((prev) => {
          const ids = new Set(prev.map((f) => f.id));
          return [...prev, ...files.filter((f) => !ids.has(f.id))];
        });
      });
    } catch (e) {
      onLog?.({ level: "warn", message: "Drive picker error", details: e });
      setError("Couldn't open the Google Drive picker.");
    }
  }, [onLog]);

  const total = localFiles.length + driveFiles.length + (rescan ? 1 : 0);

  const submit = useCallback(async () => {
    if (submitting || total === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const docIds: string[] = [];

      if (localFiles.length) {
        const fd = new FormData();
        fd.append("organization_id", organizationId);
        fd.append("library_id", library.id);
        if (currentUserId) {
          fd.append("created_by_user_id", currentUserId);
          fd.append("acting_user_id", currentUserId);
        }
        localFiles.forEach((f) => fd.append("files", f));
        const res = await fetch("/api/library/add-files/upload", { method: "POST", body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.error) throw new Error(j.error || `Upload failed (HTTP ${res.status})`);
        docIds.push(...(j.doc_ids || []));
      }

      const driveCall = async (body: Record<string, unknown>) => {
        const res = await fetch("/api/backend/library/add-files/drive", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.error) throw new Error(j.error || `Drive add failed (HTTP ${res.status})`);
        docIds.push(...(j.doc_ids || []));
      };

      if (driveFiles.length) {
        await driveCall({
          organization_id: organizationId,
          library_id: library.id,
          mode: "files",
          file_ids: driveFiles.map((f) => f.id),
          acting_user_id: currentUserId ?? null,
        });
      }
      if (rescan) {
        await driveCall({
          organization_id: organizationId,
          library_id: library.id,
          mode: "rescan",
          acting_user_id: currentUserId ?? null,
        });
      }

      if (docIds.length === 0) {
        setError("No new files were found to add (they may already be in this library).");
        setSubmitting(false);
        return;
      }

      const commit = await fetch("/api/backend/library/add-files/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, library_id: library.id, doc_ids: docIds, acting_user_id: currentUserId ?? null }),
      });
      const cj = await commit.json().catch(() => ({}));
      if (!commit.ok || cj.error) throw new Error(cj.error || `Couldn't start processing (HTTP ${commit.status})`);

      onLog?.({ level: "success", message: `Added ${docIds.length} file(s) to "${library.name}" — processing started.` });
      onStarted?.(library.id);
      // reset + close
      setLocalFiles([]); setDriveFiles([]); setRescan(false);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      setError(msg);
      onLog?.({ level: "error", message: "Add files failed", details: e });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, total, localFiles, driveFiles, rescan, organizationId, library, currentUserId, onStarted, onClose, onLog]);

  if (!open) return null;

  return (
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
          <p className="mt-0.5 text-[11px] text-white/35">PDF, Word, Excel, CSV, images, and more</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files?.length) addLocal(e.target.files); e.target.value = ""; }}
          />
        </div>

        {/* Google Drive (owner only — members can't use the owner's Drive connection) */}
        {allowDrive ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void pickDrive()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:text-white"
            >
              <FiHardDrive className="h-3.5 w-3.5 text-violet-300" /> Pick Google Drive files
            </button>
            <button
              type="button"
              onClick={() => setRescan((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                rescan ? "border-violet-400/50 bg-violet-500/15 text-white" : "border-white/10 bg-white/5 text-white/80 hover:text-white"
              }`}
            >
              <FiRefreshCw className="h-3.5 w-3.5" /> Re-scan connected folder
            </button>
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

        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={() => !submitting && onClose()} className="rounded-lg px-3 py-2 text-xs text-white/60 hover:text-white">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting || total === 0}
            className="btn-grad inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {submitting ? <><FiLoader className="h-3.5 w-3.5 animate-spin" /> Adding…</> : "Add & process"}
          </button>
        </div>
      </div>
    </div>
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
