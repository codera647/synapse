"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FiX } from "react-icons/fi";

// react-force-graph touches window/canvas — load client-only.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

export type KGNode = {
  id: string;
  name: string;
  type?: string | null;
  description?: string | null;
  mention_count?: number | null;
  source_chunk_ids?: string[] | null;
};
export type KGEdge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relation: string;
  description?: string | null;
  weight?: number | null;
  source_chunk_ids?: string[] | null;
};

const TYPE_COLORS: Record<string, string> = {
  person: "#60a5fa", organization: "#f472b6", concept: "#a78bfa", method: "#34d399",
  system: "#fbbf24", product: "#fb923c", metric: "#22d3ee", place: "#f87171",
};
function colorFor(type?: string | null) {
  return TYPE_COLORS[(type || "").toLowerCase()] || "#a78bfa";
}

export default function KnowledgeGraphView({
  nodes,
  edges,
  onNodeChunks,
}: {
  nodes: KGNode[];
  edges: KGEdge[];
  onNodeChunks?: (chunkIds: string[]) => Promise<Array<{ chunk_id: string; text: string; doc_title?: string }>>;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [selected, setSelected] = useState<KGNode | null>(null);
  const [passages, setPassages] = useState<Array<{ chunk_id: string; text: string; doc_title?: string }> | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    const maxM = Math.max(1, ...nodes.map((n) => n.mention_count || 1));
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        val: 1 + 5 * Math.sqrt((n.mention_count || 1) / maxM),
        color: colorFor(n.type),
        _node: n,
      })),
      links: edges.map((e) => ({ source: e.source_node_id, target: e.target_node_id, relation: e.relation })),
    };
  }, [nodes, edges]);

  const openNode = async (n: KGNode) => {
    setSelected(n);
    setPassages(null);
    if (onNodeChunks && n.source_chunk_ids?.length) {
      try {
        setPassages(await onNodeChunks(n.source_chunk_ids.slice(0, 6)));
      } catch {
        setPassages([]);
      }
    } else {
      setPassages([]);
    }
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-[#07060f]">
      {/* @ts-expect-error react-force-graph dynamic types */}
      <ForceGraph2D
        width={size.w}
        height={size.h}
        graphData={data}
        backgroundColor="#07060f"
        nodeRelSize={4}
        nodeVal={(n: { val?: number }) => n.val || 1}
        nodeLabel={(n: { name?: string; type?: string }) => `${n.name}${n.type ? ` (${n.type})` : ""}`}
        nodeColor={(n: { color?: string }) => n.color || "#a78bfa"}
        linkColor={() => "rgba(255,255,255,0.12)"}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkWidth={0.6}
        onNodeClick={(n: { _node?: KGNode }) => n._node && void openNode(n._node)}
        cooldownTicks={120}
        nodeCanvasObjectMode={() => "after"}
        nodeCanvasObject={(n: { x?: number; y?: number; name?: string; val?: number }, ctx: CanvasRenderingContext2D, scale: number) => {
          if (scale < 1.4 || !n.x || !n.y) return; // labels only when zoomed in (declutter)
          const label = n.name || "";
          ctx.font = `${11 / scale}px sans-serif`;
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          ctx.textAlign = "center";
          ctx.fillText(label.length > 24 ? label.slice(0, 24) + "…" : label, n.x, n.y + (n.val || 4) + 9 / scale);
        }}
      />

      {/* Legend */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2 rounded-lg bg-black/30 px-2 py-1.5 text-[10px] text-white/60 backdrop-blur">
        {Object.entries(TYPE_COLORS).slice(0, 6).map(([t, c]) => (
          <span key={t} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: c }} /> {t}
          </span>
        ))}
      </div>

      {/* Node detail panel */}
      {selected ? (
        <div className="absolute right-0 top-0 h-full w-80 max-w-[80%] overflow-auto border-l border-white/10 bg-[#0d0b1a]/95 p-4 backdrop-blur">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-white/90">{selected.name}</div>
              {selected.type ? (
                <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-[10px]" style={{ background: `${colorFor(selected.type)}33`, color: colorFor(selected.type) }}>
                  {selected.type}
                </span>
              ) : null}
            </div>
            <button onClick={() => setSelected(null)} className="rounded-lg p-1 text-white/50 hover:bg-white/10 hover:text-white">
              <FiX className="h-4 w-4" />
            </button>
          </div>
          {selected.description ? <p className="text-xs leading-relaxed text-white/70">{selected.description}</p> : null}
          <div className="mt-3 text-[10px] uppercase tracking-wide text-white/35">Source passages</div>
          {passages === null ? (
            <div className="mt-2 space-y-2">
              {[0, 1].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />)}
            </div>
          ) : passages.length === 0 ? (
            <div className="mt-2 text-xs text-white/40">No source passages.</div>
          ) : (
            <div className="mt-2 space-y-2">
              {passages.map((p) => (
                <div key={p.chunk_id} className="rounded-lg border border-white/8 bg-white/[0.03] p-2 text-[11px] text-white/70">
                  {p.doc_title ? <div className="mb-1 text-[10px] text-violet-200/70">{p.doc_title}</div> : null}
                  {p.text.length > 320 ? p.text.slice(0, 320) + "…" : p.text}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
