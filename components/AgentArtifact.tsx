"use client";

import { useEffect, useRef, useState } from "react";
import { FiAlertTriangle, FiDownload, FiFileText } from "react-icons/fi";
import { VegaLite } from "react-vega";

export type AgentArtifactData = {
  artifact_id: string;
  kind?: string | null;
  format: "vega_lite" | "mermaid" | "document" | "pdf" | "image";
  title?: string | null;
  alt_text?: string | null;
  spec_key?: string | null;
  png_key?: string | null;
  mermaid_text?: string | null;
  markdown_text?: string | null;
  file_key?: string | null;
  render_status?: string | null;
  errors?: string[] | null;
};

function isDoc(f: string) {
  return f === "document" || f === "pdf";
}

function artifactUrl(key: string) {
  return `/api/agent-artifact?key=${encodeURIComponent(key)}`;
}

export default function AgentArtifact({ artifact }: { artifact: AgentArtifactData }) {
  const failed = (artifact.render_status || "ok") !== "ok";

  // Documents/PDFs render as a compact downloadable file card (no inline content).
  if (isDoc(artifact.format)) return <DocFileCard artifact={artifact} />;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white/90">{artifact.title || "Visual"}</div>
          {artifact.kind ? (
            <div className="text-[10px] uppercase tracking-wide text-white/35">{artifact.kind}</div>
          ) : null}
        </div>
        {!failed && (artifact.png_key || artifact.format === "mermaid") ? (
          <DownloadButton artifact={artifact} />
        ) : null}
      </div>

      {failed ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <FiAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {artifact.format === "image" ? "Couldn't generate this image" : "Couldn't render this visual"}
            {artifact.errors?.length ? `: ${artifact.errors.join("; ")}` : "."}
          </span>
        </div>
      ) : artifact.format === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={artifactUrl(artifact.png_key || artifact.file_key || "")}
          alt={artifact.title || "Generated image"}
          className="w-full rounded-lg"
        />
      ) : artifact.format === "mermaid" ? (
        <MermaidView text={artifact.mermaid_text || ""} id={artifact.artifact_id} />
      ) : (
        <VegaView specKey={artifact.spec_key || ""} />
      )}

      {artifact.alt_text ? <div className="mt-1 text-[11px] text-white/35">{artifact.alt_text}</div> : null}
    </div>
  );
}

// ── Document / PDF file card (name + download, no inline content) ──────────────────────────────
function DocFileCard({ artifact }: { artifact: AgentArtifactData }) {
  const isPdf = artifact.format === "pdf" && !!artifact.file_key;
  const ext = isPdf ? "pdf" : "md";
  const base = (artifact.title || "document").trim();

  const download = () => {
    const fname = base.replace(/[^a-z0-9]+/gi, "_").toLowerCase() || "document";
    if (isPdf && artifact.file_key) {
      const a = document.createElement("a");
      a.href = artifactUrl(artifact.file_key);
      a.download = `${fname}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    const blob = new Blob([artifact.markdown_text || ""], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fname}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <button
      type="button"
      onClick={download}
      title="Click to download"
      className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 text-violet-200">
        <FiFileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-white/90 group-hover:underline">
          {base}
          <span className="text-white/40">.{ext}</span>
        </span>
        <span className="block text-[11px] text-white/40">
          {isPdf ? "PDF document" : "Markdown document"} · click to download
        </span>
      </span>
      <FiDownload className="h-4 w-4 shrink-0 text-white/40 group-hover:text-white" />
    </button>
  );
}

// ── Vega-Lite (interactive) ────────────────────────────────────────────────────────────────
function VegaView({ specKey }: { specKey: string }) {
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!specKey) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(artifactUrl(specKey), { cache: "no-store" });
        if (!res.ok) throw new Error(`spec ${res.status}`);
        const j = (await res.json()) as Record<string, unknown>;
        if (alive) setSpec(j);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed to load spec");
      }
    })();
    return () => {
      alive = false;
    };
  }, [specKey]);

  if (err) return <div className="text-xs text-white/40">Chart unavailable ({err}).</div>;
  if (!spec) return <div className="h-40 animate-pulse rounded-lg bg-white/5" />;
  // Render at the spec's natural size, then CSS-scale the rendered canvas/svg to fit the card. This
  // avoids Vega's width:"container" measuring 0 in a grid cell / drawer (which renders a blank chart),
  // while still shrinking the chart so several fit per row. The download PNG stays full resolution.
  const safe: Record<string, unknown> = { ...spec };
  // Force a prominent fixed width (container-width measures 0 in grid cells -> blank; and CSS only
  // shrinks, so a small natural width left charts tiny). CSS max-w-full scales it down on narrow cells.
  const w = (safe as { width?: unknown }).width;
  if (typeof w !== "number" || w < 420) safe.width = 620;
  if (safe.autosize && typeof safe.autosize === "object") delete safe.autosize;
  return (
    <div className="w-full overflow-hidden rounded-lg bg-white p-3 text-center [&_canvas]:!mx-auto [&_canvas]:!h-auto [&_canvas]:!max-w-full [&_svg]:!mx-auto [&_svg]:!h-auto [&_svg]:!max-w-full">
      <VegaLite spec={safe as never} actions={false} renderer="canvas" />
    </div>
  );
}

// ── Mermaid (interactive-ish) ──────────────────────────────────────────────────────────────
function MermaidView({ text, id }: { text: string; id: string }) {
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!text) return;
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
        const { svg: out } = await mermaid.render(`m-${id.replace(/[^a-z0-9]/gi, "")}`, text);
        if (alive) setSvg(out);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "diagram error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [text, id]);

  if (err) return <div className="text-xs text-white/40">Diagram unavailable ({err}).</div>;
  if (!svg) return <div className="h-40 animate-pulse rounded-lg bg-white/5" />;
  return (
    <div
      className="max-h-[340px] w-full overflow-auto rounded-lg bg-white p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      data-mermaid-id={id}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ── Download ─────────────────────────────────────────────────────────────────────────────────
function DownloadButton({ artifact }: { artifact: AgentArtifactData }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const onDownload = async () => {
    const fname = (artifact.title || "visual").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    // PDF: download the rendered file from R2.
    if (artifact.format === "pdf" && artifact.file_key) {
      const a = document.createElement("a");
      a.href = artifactUrl(artifact.file_key);
      a.download = `${fname}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    // Document (or PDF without a rendered file): download the markdown.
    if (isDoc(artifact.format)) {
      const blob = new Blob([artifact.markdown_text || ""], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${fname}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    if ((artifact.format === "vega_lite" || artifact.format === "image") && (artifact.png_key || artifact.file_key)) {
      const a = document.createElement("a");
      a.href = artifactUrl(artifact.png_key || artifact.file_key || "");
      a.download = `${fname}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    // Mermaid: serialize the rendered SVG to a PNG client-side.
    const svgEl = document.querySelector(`[data-mermaid-id="${artifact.artifact_id}"] svg`) as SVGSVGElement | null;
    if (!svgEl) return;
    try {
      const xml = new XMLSerializer().serializeToString(svgEl);
      const svg64 = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
      const img = new Image();
      img.onload = () => {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = (svgEl.clientWidth || 800) * scale;
        canvas.height = (svgEl.clientHeight || 600) * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = `${fname}.png`;
        a.click();
      };
      img.src = svg64;
    } catch {
      /* ignore */
    }
  };

  const label = artifact.format === "pdf" && artifact.file_key ? "PDF" : isDoc(artifact.format) ? "MD" : "PNG";
  return (
    <div ref={wrapRef}>
      <button
        type="button"
        onClick={onDownload}
        title={`Download ${label}`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10 transition-colors"
      >
        <FiDownload className="h-3.5 w-3.5" />
        {label}
      </button>
    </div>
  );
}
