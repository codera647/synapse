"use client";

import { useMemo, useState } from "react";
import { FiChevronDown, FiChevronUp, FiExternalLink } from "react-icons/fi";

export type ChatSource = {
  library_id: string;
  doc_id: string;
  doc_title?: string | null;
  path_in_source?: string | null;
  gdrive_file_id?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  chunk_id?: string | null;
  score?: number | null;
  storage_path_raw?: string | null;
};

function extractDriveFileId(gdriveFileId?: string | null, storageKey?: string | null) {
  const candidates = [gdriveFileId || "", storageKey || ""];
  for (const s of candidates) {
    const text = String(s || "").trim();
    if (!text) continue;

    // Full Google Drive URL
    let m = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/i.exec(text);
    if (m?.[1]) return m[1];
    m = /[?&]id=([a-zA-Z0-9_-]{10,})/i.exec(text);
    if (m?.[1]) return m[1];

    // Raw file id
    if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text;

    // Common sync key pattern: "...raw_<fileId>-<filename>.pdf" but fileId itself may contain '-',
    // so use a heuristic on the basename.
    const base = text.split("/").pop() || text;
    const rawIdx = base.toLowerCase().indexOf("raw_");
    if (rawIdx >= 0) {
      const after = base.slice(rawIdx + 4);
      const parts = after.split("-");
      const idParts: string[] = [];
      for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
        idParts.push(parts[i] || "");
        const candidate = idParts.join("-");
        const next = parts[i + 1] || "";
        if (candidate.length >= 25 && /\\.pdf$/i.test(next)) return candidate;
        if (candidate.length >= 25 && /\\.[a-z0-9]{2,4}$/i.test(next)) return candidate;
      }
      const fallback = after.match(/[a-zA-Z0-9_-]{25,}/)?.[0];
      if (fallback) return fallback;
    }
  }
  return null;
}

export default function ChatMessageSources({
  sources,
  onClickSource,
}: {
  sources: ChatSource[];
  onClickSource?: (s: ChatSource) => void;
}) {
  const [open, setOpen] = useState(false);

  const uniq = useMemo(() => {
    const out: ChatSource[] = [];
    const seen = new Set<string>();
    for (const s of sources || []) {
      // Deduplicate at the PDF-level for display.
      const k = String(s.doc_id || s.storage_path_raw || "").trim();
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  }, [sources]);

  if (!uniq.length) return null;

  const list = open ? uniq : uniq.slice(0, 4);

  return (
    <div className="mt-3 border-t border-white/10 pt-2 text-[11px] text-gray-300/90">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-[0.18em] text-gray-500">Sources</span>
          <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-gray-400">
            {uniq.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          {open ? "Less" : "More"}
          {open ? <FiChevronUp className="h-3 w-3" /> : <FiChevronDown className="h-3 w-3" />}
        </button>
      </div>

      <div className="mt-2 space-y-1.5">
        {list.map((s, i) => {
          const title =
            s.doc_title ||
            s.path_in_source?.split("/").pop() ||
            s.storage_path_raw?.split("/").pop() ||
            s.doc_id;
          const page =
            typeof s.page_start === "number" && typeof s.page_end === "number"
              ? s.page_start === s.page_end
                ? `p.${s.page_start}`
                : `p.${s.page_start}-${s.page_end}`
              : null;

          const fileId = extractDriveFileId(s.gdrive_file_id ?? null, s.storage_path_raw ?? null);
          const href = fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : null;

          return (
            <a
              key={`${s.doc_id}:${s.chunk_id ?? i}`}
              href={href || "#"}
              target={href ? "_blank" : undefined}
              rel={href ? "noreferrer noopener" : undefined}
              className="block w-full rounded-xl border border-white/10 bg-black/10 px-2.5 py-2 text-left hover:bg-white/5 transition-colors"
              onClick={(e) => {
                if (href) return;
                e.preventDefault();
                onClickSource?.(s);
              }}
              title={href ? "Open PDF" : "Open PDF (unavailable)"}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-gray-100">{title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                    {page ? <span>{page}</span> : null}
                  </div>
                </div>
                <div className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-gray-300">
                  <FiExternalLink className="h-4 w-4" />
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
