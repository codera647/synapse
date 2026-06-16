"use client";

import { useEffect, useRef, useState } from "react";
import { FiAlertTriangle, FiDownload } from "react-icons/fi";
import { VegaLite } from "react-vega";

export type AgentArtifactData = {
  artifact_id: string;
  kind?: string | null;
  format: "vega_lite" | "mermaid";
  title?: string | null;
  alt_text?: string | null;
  spec_key?: string | null;
  png_key?: string | null;
  mermaid_text?: string | null;
  render_status?: string | null;
  errors?: string[] | null;
};

function artifactUrl(key: string) {
  return `/api/agent-artifact?key=${encodeURIComponent(key)}`;
}

export default function AgentArtifact({ artifact }: { artifact: AgentArtifactData }) {
  const failed = (artifact.render_status || "ok") !== "ok";

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
          <span>Couldn&apos;t render this visual{artifact.errors?.length ? `: ${artifact.errors.join("; ")}` : "."}</span>
        </div>
      ) : artifact.format === "mermaid" ? (
        <MermaidView text={artifact.mermaid_text || ""} id={artifact.artifact_id} />
      ) : (
        <VegaView specKey={artifact.spec_key || ""} />
      )}

      {artifact.alt_text ? <div className="mt-1 text-[11px] text-white/35">{artifact.alt_text}</div> : null}
    </div>
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
  if (safe.width === "container") delete safe.width; // container width needs measurement -> blank in cells
  if (safe.autosize && typeof safe.autosize === "object") delete safe.autosize;
  return (
    <div className="w-full overflow-hidden rounded-lg bg-white p-2 text-center [&_canvas]:!mx-auto [&_canvas]:!h-auto [&_canvas]:!max-w-full [&_svg]:!mx-auto [&_svg]:!h-auto [&_svg]:!max-w-full">
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
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
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
      className="max-h-[340px] w-full overflow-auto rounded-lg bg-[#0d0b1a] p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
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
    if (artifact.format === "vega_lite" && artifact.png_key) {
      const a = document.createElement("a");
      a.href = artifactUrl(artifact.png_key);
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
        ctx.fillStyle = "#0d0b1a";
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

  return (
    <div ref={wrapRef}>
      <button
        type="button"
        onClick={onDownload}
        title="Download PNG"
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10 transition-colors"
      >
        <FiDownload className="h-3.5 w-3.5" />
        PNG
      </button>
    </div>
  );
}
