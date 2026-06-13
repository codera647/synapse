// On-demand fetch of a chunk's verbatim text + neighbour context, by chunk_id.
// Used by the source hover preview and the in-app PDF highlight so they work for any message —
// including reloaded threads where the snippet wasn't persisted. Results are cached per chunk_id.

export type ChunkContext = { text: string; before: string; after: string };

const cache = new Map<string, ChunkContext | null>();
const inflight = new Map<string, Promise<ChunkContext | null>>();

export async function fetchChunkContext(chunkId?: string | null): Promise<ChunkContext | null> {
  const id = String(chunkId || "").trim();
  if (!id) return null;
  if (cache.has(id)) return cache.get(id) ?? null;
  if (inflight.has(id)) return inflight.get(id)!;

  const p = (async () => {
    try {
      const res = await fetch(`/api/backend/document/chunk?chunk_id=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        cache.set(id, null);
        return null;
      }
      const j = (await res.json()) as Partial<ChunkContext>;
      const out: ChunkContext = {
        text: String(j.text || ""),
        before: String(j.before || ""),
        after: String(j.after || ""),
      };
      cache.set(id, out.text ? out : null);
      return out.text ? out : null;
    } catch {
      cache.set(id, null);
      return null;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, p);
  return p;
}
