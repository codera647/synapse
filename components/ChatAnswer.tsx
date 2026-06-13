"use client";

import { useMemo } from "react";
import ChatMarkdown, { type Citation } from "@/components/ChatMarkdown";
import { prettyTitle } from "@/components/ChatMessageSources";

export type ChatVisual = {
  visual_id: string;
  visual_key?: string | null;
  caption?: string | null;
  page?: number | null;
  kind?: string | null;
  doc_id?: string | null;
  doc_title?: string | null;
};

export type ChatCitation = {
  n: number;
  doc_id?: string | null;
  doc_title?: string | null;
  gdrive_file_id?: string | null;
  page?: number | null;
};

const MARKER = /\[\[VISUAL:[^\]]+\]\]/g;
const MARKER_ONE = /^\[\[VISUAL:([^\]]+)\]\]$/;

function VisualCard({ v }: { v: ChatVisual }) {
  if (!v.visual_key) return null;
  const url = `/api/visual?key=${encodeURIComponent(v.visual_key)}`;
  const kind = (v.kind || "Figure").replace(/^\w/, (c) => c.toUpperCase());
  return (
    <figure className="my-3 overflow-hidden rounded-xl border border-white/10 bg-black/20">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={v.caption || kind}
        loading="lazy"
        onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        className="max-h-[440px] w-full cursor-zoom-in bg-white object-contain"
        title="Open full image"
      />
      <figcaption className="px-3 py-2 text-[11px] leading-relaxed text-white/55">
        <span className="font-medium text-violet-300">{kind}</span>
        {v.caption ? ` — ${v.caption}` : ""}
        {v.doc_title ? (
          <span className="text-white/35">
            {" · "}
            {prettyTitle(v.doc_title)}
            {v.page != null ? `, p.${v.page}` : ""}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** Render an answer, replacing [[VISUAL:id]] markers with inline figure/table images. */
export default function ChatAnswer({
  content,
  visuals,
  citations,
}: {
  content: string;
  visuals?: ChatVisual[] | null;
  citations?: ChatCitation[] | null;
}) {
  // Build the inline-citation map (n -> chip label/title/url) for the renderer.
  const citeMap = useMemo(() => {
    const m: Record<string, Citation> = {};
    for (const c of citations || []) {
      const full = prettyTitle(c.doc_title || "") || "Source";
      const label = full.length > 18 ? `${full.slice(0, 17).trim()}…` : full;
      const id = String(c.gdrive_file_id || "").trim();
      const url = /^[a-zA-Z0-9_-]{10,}$/.test(id)
        ? `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
        : null;
      m[String(c.n)] = { label, title: full + (c.page != null ? `, p.${c.page}` : ""), url };
    }
    return m;
  }, [citations]);

  const list = visuals || [];
  if (!list.length) {
    // No visuals to place — hide any stray visual markers (e.g. while the answer is still typing).
    const cleaned = content.replace(MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
    return <ChatMarkdown content={cleaned} citations={citeMap} />;
  }

  const byId = new Map(list.map((v) => [String(v.visual_id), v]));
  const parts = content.split(/(\[\[VISUAL:[^\]]+\]\])/g);

  return (
    <div>
      {parts.map((part, i) => {
        const m = MARKER_ONE.exec(part);
        if (m) {
          const v = byId.get(m[1].trim());
          return v ? <VisualCard key={`v${i}`} v={v} /> : null;
        }
        if (!part.trim()) return null;
        return <ChatMarkdown key={`t${i}`} content={part} citations={citeMap} />;
      })}
    </div>
  );
}
