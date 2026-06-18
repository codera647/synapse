// Bridge to the Electron desktop shell (see /desktop). On the web this is all no-ops; in the desktop
// app `window.synapseDesktop` is injected by the preload script, which lets the dashboard create
// libraries from LOCAL folders instead of Google Drive — reusing the same upload + processing pipeline.

export type DesktopFile = { name: string; path: string; relPath: string; size: number };

export type SynapseDesktop = {
  isDesktop: true;
  platform: string;
  pickFolder: () => Promise<{ path: string; name: string } | null>;
  listFolder: (folderPath: string) => Promise<{ files: DesktopFile[]; error?: string }>;
  readFile: (filePath: string) => Promise<Uint8Array>;
};

declare global {
  interface Window {
    synapseDesktop?: SynapseDesktop;
  }
}

export function getDesktop(): SynapseDesktop | null {
  if (typeof window === "undefined") return null;
  return window.synapseDesktop ?? null;
}

export const isDesktop = (): boolean => !!getDesktop();

/**
 * Upload the chosen local folder's files into a (freshly created) library and kick off processing —
 * the same path the web "Add files from your computer" flow uses, so only the new files are processed.
 */
// Upload requests are proxied through a Cloudflare Worker, which buffers the whole multipart body in
// memory — so a full folder in ONE request can 503. Send small batches instead.
const MAX_BATCH_BYTES = 12 * 1024 * 1024; // keep each request well under the Worker limit
const MAX_BATCH_FILES = 8;

function batchFiles(files: DesktopFile[]): DesktopFile[][] {
  const batches: DesktopFile[][] = [];
  let cur: DesktopFile[] = [];
  let curBytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= MAX_BATCH_FILES || curBytes + (f.size || 0) > MAX_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size || 0;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export async function uploadLocalFolder(opts: {
  api: SynapseDesktop;
  organizationId: string;
  libraryId: string;
  userId: string | null;
  files: DesktopFile[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ docIds: string[] }> {
  const { api, organizationId, libraryId, userId, files, onProgress } = opts;

  const docIds: string[] = [];
  let done = 0;

  for (const batch of batchFiles(files)) {
    const fd = new FormData();
    fd.append("organization_id", organizationId);
    fd.append("library_id", libraryId);
    if (userId) {
      fd.append("created_by_user_id", userId);
      fd.append("acting_user_id", userId);
    }
    fd.append("replace", "false");
    for (const f of batch) {
      const bytes = await api.readFile(f.path);
      // Cast to BlobPart — a Uint8Array is a valid BlobPart at runtime.
      fd.append("files", new File([bytes as BlobPart], f.name));
    }

    const res = await fetch("/api/library/add-files/upload", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) {
      const detail = j.error || (res.status === 503 ? "the server was busy" : `HTTP ${res.status}`);
      throw new Error(`Upload failed (${detail}). ${done} of ${files.length} files were sent.`);
    }
    docIds.push(...(j.doc_ids || []));
    done += batch.length;
    onProgress?.(done, files.length);
  }

  if (docIds.length > 0) {
    const commit = await fetch("/api/backend/library/add-files/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organization_id: organizationId,
        library_id: libraryId,
        doc_ids: docIds,
        acting_user_id: userId,
      }),
    });
    const cj = await commit.json().catch(() => ({}));
    if (!commit.ok || cj.error) throw new Error(cj.error || `Couldn't start processing (HTTP ${commit.status})`);
  }

  return { docIds };
}
