"use client";

import { Fragment, useMemo } from "react";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "code"; lang: string | null; code: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "math"; latex: string };

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(text: string) {
  // Minimal, dependency-free inline formatting:
  // - inline code: `x`
  // - bold: **x**
  // - italic: *x*  (best-effort)
  // - inline math: $x$
  // - links: [label](url)
  //
  // We build HTML and render via dangerouslySetInnerHTML (content is from your own backend,
  // but still treat it as untrusted: we escape everything first, then selectively unescape
  // only our own tags).
  let html = escapeHtml(text);

  // Links
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => {
    const safeLabel = escapeHtml(String(label));
    const safeUrl = escapeHtml(String(url));
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer noopener">${safeLabel}</a>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(String(code))}</code>`);

  // Inline math
  html = html.replace(/\$([^$\n]+)\$/g, (_m, latex) => {
    return `<span class="synapse-math-inline">${escapeHtml(String(latex))}</span>`;
  });

  // Bold and italic (simple, non-nested)
  html = html.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${escapeHtml(String(bold))}</strong>`);
  html = html.replace(/\*([^*\n]+)\*/g, (_m, ital) => `<em>${escapeHtml(String(ital))}</em>`);

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function parseBlocks(content: string): Block[] {
  // Hide backend-internal citation formats from the UI (we still keep structured sources separately).
  // Examples seen: "(chunk_id=..., doc_id=...)" or "[chunk_id=... doc_id=... pages=...]"
  const cleaned = (content || "")
    .replace(/\(\s*chunk_id=[^)]*\)/gi, "")
    .replace(/\(\s*chunk_id=[^,]+,\s*doc_id=[^)]+\)/gi, "")
    .replace(/\[\s*chunk_id=[^\]]*\]/gi, "");

  const lines = cleaned.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let i = 0;
  const flushParagraph = (buf: string[]) => {
    const text = buf.join("\n").trimEnd();
    if (!text.trim()) return;
    blocks.push({ type: "paragraph", text });
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code blocks ```lang
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ? String(fence[1]) : null;
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      // consume closing fence if present
      if (i < lines.length && /^```/.test(lines[i] ?? "")) i += 1;
      blocks.push({ type: "code", lang, code: buf.join("\n") });
      continue;
    }

    // Display math blocks $$ ... $$ (single-line or multi-line)
    if (/^\s*\$\$\s*$/.test(line)) {
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length && /^\s*\$\$\s*$/.test(lines[i] ?? "")) i += 1;
      const latex = buf.join("\n").trim();
      if (latex) blocks.push({ type: "math", latex });
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.+)\s*$/.exec(line);
    if (h) {
      const level = h[1].length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: h[2] ?? "" });
      i += 1;
      continue;
    }

    // Blockquote (single or multi-line contiguous)
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", text: buf.join("\n").trimEnd() });
      continue;
    }

    // Lists (contiguous)
    const ul = /^\s*[-*]\s+(.+)\s*$/.exec(line);
    const ol = /^\s*(\d+)\.\s+(.+)\s*$/.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const u = /^\s*[-*]\s+(.+)\s*$/.exec(l);
        const o = /^\s*(\d+)\.\s+(.+)\s*$/.exec(l);
        if (ordered) {
          if (!o) break;
          items.push(o[2] ?? "");
        } else {
          if (!u) break;
          items.push(u[1] ?? "");
        }
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraphs (aggregate until blank line)
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      // stop if next is a structural block
      const l = lines[i] ?? "";
      if (/^```/.test(l) || /^\s*\$\$\s*$/.test(l) || /^(#{1,3})\s+/.test(l) || /^\s*>\s?/.test(l)) break;
      buf.push(l);
      i += 1;
    }
    flushParagraph(buf);
  }

  return blocks;
}

export default function ChatMarkdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseBlocks(content || ""), [content]);

  return (
    <div className="synapse-markdown">
      {blocks.map((b, idx) => {
        if (b.type === "heading") {
          const Tag: "h1" | "h2" | "h3" = b.level === 1 ? "h1" : b.level === 2 ? "h2" : "h3";
          return (
            <Tag key={idx} className="synapse-md-heading">
              {renderInline(b.text)}
            </Tag>
          );
        }

        if (b.type === "blockquote") {
          return (
            <blockquote key={idx}>
              {b.text.split("\n").map((ln, i) => (
                <Fragment key={i}>
                  {renderInline(ln)}
                  {i < b.text.split("\n").length - 1 ? <br /> : null}
                </Fragment>
              ))}
            </blockquote>
          );
        }

        if (b.type === "code") {
          return (
            <div key={idx} className="relative">
              {b.lang ? (
                <div className="pointer-events-none absolute right-3 top-2 text-[10px] uppercase tracking-[0.22em] text-gray-500">
                  {b.lang}
                </div>
              ) : null}
              <pre>
                <code>{b.code}</code>
              </pre>
            </div>
          );
        }

        if (b.type === "math") {
          return (
            <div key={idx} className="katex-display">
              <pre className="m-0 p-0 bg-transparent border-0 overflow-auto">
                <code>{b.latex}</code>
              </pre>
            </div>
          );
        }

        if (b.type === "list") {
          const ListTag = b.ordered ? "ol" : "ul";
          return (
            <ListTag key={idx}>
              {b.items.map((it, i) => (
                <li key={i}>{renderInline(it)}</li>
              ))}
            </ListTag>
          );
        }

        // paragraph
        return (
          <p key={idx}>
            {b.text.split("\n").map((ln, i) => (
              <Fragment key={i}>
                {renderInline(ln)}
                {i < b.text.split("\n").length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
