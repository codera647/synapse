"use client";

import { Fragment, useMemo } from "react";

export type Citation = { label: string; title: string; url: string | null };

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "code"; lang: string | null; code: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "math"; latex: string };

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(text: string, citations?: Record<string, Citation>) {
  // Minimal, dependency-free inline formatting. Content comes from our own backend but is still
  // treated as untrusted: everything is escaped first, then only our own tags are injected.
  let html = escapeHtml(text);

  // Inline source-reference chips: [[CITE:n]] -> a small clickable pill.
  html = html.replace(/\[\[CITE:([^\]]+)\]\]/g, (_m, raw) => {
    const key = String(raw).trim();
    const c = citations?.[key];
    if (!c) return "";
    const label = escapeHtml(c.label || key);
    const title = escapeHtml(c.title || c.label || "");
    if (c.url) {
      const url = escapeHtml(c.url);
      return `<a class="synapse-cite" href="${url}" target="_blank" rel="noreferrer noopener" title="${title}">📄 ${label}</a>`;
    }
    return `<span class="synapse-cite" title="${title}">📄 ${label}</span>`;
  });

  // Links [label](url)
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

function splitRow(line: string): string[] {
  // Split a markdown table row on unescaped pipes, dropping the leading/trailing pipe.
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  // e.g. | --- | :---: | ---: |
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line) || /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line);
}

function parseBlocks(content: string): Block[] {
  // Hide backend-internal citation formats from the UI (we keep structured sources separately).
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
      if (i < lines.length && /^```/.test(lines[i] ?? "")) i += 1;
      blocks.push({ type: "code", lang, code: buf.join("\n") });
      continue;
    }

    // Display math blocks $$ ... $$
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

    // Tables: a header row of pipes followed by a separator row.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        rows.push(splitRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Headings (#..####)
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 4) as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, text: h[2] ?? "" });
      i += 1;
      continue;
    }

    // Blockquote (contiguous)
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

    // Paragraphs (aggregate until blank line / structural block)
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      const l = lines[i] ?? "";
      if (
        /^```/.test(l) ||
        /^\s*\$\$\s*$/.test(l) ||
        /^(#{1,6})\s+/.test(l) ||
        /^\s*>\s?/.test(l) ||
        (/^\s*\|.*\|\s*$/.test(l) && isTableSeparator(lines[i + 1] ?? ""))
      )
        break;
      buf.push(l);
      i += 1;
    }
    flushParagraph(buf);
  }

  return blocks;
}

export default function ChatMarkdown({
  content,
  citations,
}: {
  content: string;
  citations?: Record<string, Citation>;
}) {
  const blocks = useMemo(() => parseBlocks(content || ""), [content]);

  return (
    <div className="synapse-markdown">
      {blocks.map((b, idx) => {
        if (b.type === "heading") {
          const Tag = (`h${b.level}` as unknown) as "h1" | "h2" | "h3" | "h4";
          return (
            <Tag key={idx} className="synapse-md-heading">
              {renderInline(b.text, citations)}
            </Tag>
          );
        }

        if (b.type === "blockquote") {
          const parts = b.text.split("\n");
          return (
            <blockquote key={idx}>
              {parts.map((ln, i) => (
                <Fragment key={i}>
                  {renderInline(ln, citations)}
                  {i < parts.length - 1 ? <br /> : null}
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

        if (b.type === "table") {
          return (
            <div key={idx} className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    {b.headers.map((h, ci) => (
                      <th key={ci}>{renderInline(h, citations)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>
                      {b.headers.map((_h, ci) => (
                        <td key={ci}>{renderInline(r[ci] ?? "", citations)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
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
                <li key={i}>{renderInline(it, citations)}</li>
              ))}
            </ListTag>
          );
        }

        // paragraph
        const parts = b.text.split("\n");
        return (
          <p key={idx}>
            {parts.map((ln, i) => (
              <Fragment key={i}>
                {renderInline(ln, citations)}
                {i < parts.length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
