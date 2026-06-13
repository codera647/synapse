"use client";

import { useMemo, useState } from "react";
import { FiChevronDown, FiChevronUp, FiExternalLink, FiFileText } from "react-icons/fi";

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
  // Verbatim cited passage + a little surrounding context (for the hover preview + PDF highlight).
  snippet?: string | null;
  context_before?: string | null;
  context_after?: string | null;
};

/** Turn a raw dataset filename into a readable title.
 *  "00099_852efb70fc6e_Gradient_boosting_machines__a_tutorial.pdf" -> "Gradient boosting machines — a tutorial" */
export function prettyTitle(raw?: string | null): string {
  let t = String(raw || "").trim();
  if (!t) return "Document";
  t = t.split("/").pop() || t; // basename
  t = t.replace(/\.[a-z0-9]{2,4}$/i, ""); // drop extension
  t = t.replace(/^\d+[_-][0-9a-f]{6,}[_-]/i, ""); // drop "00099_852efb70fc6e_" dataset prefix
  t = t.replace(/^\d+[_-]/, ""); // drop a leading bare index if still present
  t = t.replace(/__+/g, " — "); // double underscore -> em-dash separator
  t = t.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return t || "Document";
}

function extractDriveFileId(gdriveFileId?: string | null, storageKey?: string | null) {
  const candidates = [gdriveFileId || "", storageKey || ""];
  for (const s of candidates) {
    const text = String(s || "").trim();
    if (!text) continue;
    let m = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/i.exec(text);
    if (m?.[1]) return m[1];
    m = /[?&]id=([a-zA-Z0-9_-]{10,})/i.exec(text);
    if (m?.[1]) return m[1];
    if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text;
  }
  return null;
}

function SourcePreview({ s }: { s: ChatSource }) {
  const before = (s.context_before || "").trim();
  const after = (s.context_after || "").trim();
  const snippet = (s.snippet || "").trim();
  if (!snippet) return null;
  return (
    <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-[min(380px,80vw)] opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <div className="surface-menu rounded-xl p-3 text-left shadow-2xl shadow-black/50">
        <div className="mb-1.5 flex items-center gap-2 text-[10px] text-white/45">
          <FiFileText className="h-3 w-3 text-violet-300" />
          <span className="truncate">{prettyTitle(s.doc_title || s.storage_path_raw)}</span>
          {typeof s.page_start === "number" ? (
            <span className="ml-auto shrink-0 rounded bg-white/8 px-1.5 py-0.5">p.{s.page_start}</span>
          ) : null}
        </div>
        <p className="max-h-44 overflow-hidden text-[11px] leading-relaxed text-white/55">
          {before ? <span className="text-white/35">…{before} </span> : null}
          <span className="rounded bg-violet-400/20 px-0.5 text-white/90">{snippet}</span>
          {after ? <span className="text-white/35"> {after}…</span> : null}
        </p>
        <div className="mt-2 text-[9px] uppercase tracking-wide text-white/30">Click to open in viewer</div>
      </div>
    </div>
  );
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
      // Dedupe duplicate copies of the same paper: prefer a content key (pretty title) so two
      // dataset entries of the same PDF (different doc_id, same content) collapse into one.
      const k = `${prettyTitle(s.doc_title || s.storage_path_raw)}::${s.page_start ?? ""}`;
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
          const title = prettyTitle(s.doc_title || s.path_in_source || s.storage_path_raw || s.doc_id);
          const page =
            typeof s.page_start === "number" && typeof s.page_end === "number"
              ? s.page_start === s.page_end
                ? `p.${s.page_start}`
                : `p.${s.page_start}-${s.page_end}`
              : null;

          const driveId = extractDriveFileId(s.gdrive_file_id ?? null, s.storage_path_raw ?? null);
          const driveHref = driveId ? `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/view` : null;

          return (
            <div key={`${s.doc_id}:${s.chunk_id ?? i}`} className="group relative">
              <SourcePreview s={s} />
              <button
                type="button"
                onClick={() => onClickSource?.(s)}
                className="block w-full rounded-xl border border-white/10 bg-black/10 px-2.5 py-2 text-left hover:bg-white/5 hover:border-violet-400/30 transition-colors"
                title="Open in viewer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold text-gray-100">{title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                      {page ? <span>{page}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {driveHref ? (
                      <a
                        href={driveHref}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={(e) => e.stopPropagation()}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                        title="Open in Google Drive"
                      >
                        <FiExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                    <span className="grid h-8 w-8 place-items-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-200">
                      <FiFileText className="h-4 w-4" />
                    </span>
                  </div>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
