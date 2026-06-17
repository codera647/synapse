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
export async function uploadLocalFolder(opts: {
  api: SynapseDesktop;
  organizationId: string;
  libraryId: string;
  userId: string | null;
  files: DesktopFile[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ docIds: string[] }> {
  const { api, organizationId, libraryId, userId, files, onProgress } = opts;

  const fd = new FormData();
  fd.append("organization_id", organizationId);
  fd.append("library_id", libraryId);
  if (userId) {
    fd.append("created_by_user_id", userId);
    fd.append("acting_user_id", userId);
  }
  fd.append("replace", "false");

  let done = 0;
  for (const f of files) {
    const bytes = await api.readFile(f.path);
    // Cast to BlobPart — a Uint8Array is a valid BlobPart at runtime.
    fd.append("files", new File([bytes as BlobPart], f.name));
    onProgress?.(++done, files.length);
  }

  const res = await fetch("/api/library/add-files/upload", { method: "POST", body: fd });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `Upload failed (HTTP ${res.status})`);
  const docIds: string[] = j.doc_ids || [];

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
