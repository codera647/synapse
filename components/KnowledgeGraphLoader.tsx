"use client";

// A glowing constellation that "forms" while the knowledge graph builds — nodes pulse, edges draw in,
// the whole thing slowly rotates. Shows the live stage + progress so the wait feels alive.

const NODES = [
  { x: 200, y: 200, r: 10 },
  { x: 110, y: 120, r: 7 }, { x: 300, y: 120, r: 7 }, { x: 320, y: 250, r: 6 },
  { x: 250, y: 320, r: 7 }, { x: 120, y: 300, r: 6 }, { x: 70, y: 210, r: 5 },
  { x: 180, y: 90, r: 5 }, { x: 340, y: 180, r: 5 }, { x: 90, y: 80, r: 4 },
  { x: 330, y: 330, r: 5 }, { x: 60, y: 300, r: 4 }, { x: 260, y: 60, r: 4 },
  { x: 150, y: 360, r: 4 }, { x: 360, y: 90, r: 4 },
];
const EDGES = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 7], [1, 9], [2, 8], [2, 12],
  [3, 8], [3, 10], [4, 13], [5, 11], [6, 5], [2, 14], [4, 3], [1, 0],
];

export default function KnowledgeGraphLoader({
  stage,
  current,
  total,
}: {
  stage?: string;
  current?: number;
  total?: number;
}) {
  const pct = total && total > 0 ? Math.min(100, Math.round(((current || 0) / total) * 100)) : null;
  return (
    <div className="grid h-full place-items-center text-center">
      <div className="flex flex-col items-center">
        <div className="relative h-72 w-72">
          <div className="absolute inset-0 rounded-full bg-violet-600/10 blur-3xl" />
          <svg viewBox="0 0 400 400" className="relative h-full w-full">
            <defs>
              <radialGradient id="kg-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#c4b5fd" />
                <stop offset="100%" stopColor="#7c3aed" />
              </radialGradient>
            </defs>
            <g className="kg-rotate" style={{ transformOrigin: "200px 200px" }}>
              {EDGES.map(([a, b], i) => (
                <line
                  key={i}
                  x1={NODES[a].x}
                  y1={NODES[a].y}
                  x2={NODES[b].x}
                  y2={NODES[b].y}
                  stroke="#8b5cf6"
                  strokeWidth={1.2}
                  className="kg-edge"
                  style={{ animationDelay: `${(i % 6) * 0.35}s` }}
                />
              ))}
              {NODES.map((n, i) => (
                <circle
                  key={i}
                  cx={n.x}
                  cy={n.y}
                  r={n.r}
                  fill="url(#kg-glow)"
                  className="kg-node"
                  style={{ animationDelay: `${(i % 7) * 0.3}s` }}
                />
              ))}
            </g>
          </svg>
        </div>

        <div className="mt-2 text-sm font-medium text-white/85">Building the knowledge graph…</div>
        <div className="mt-1 text-xs text-violet-200/80">{stage || "Reading your documents"}</div>

        {pct !== null ? (
          <div className="mt-4 w-64">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-white/40">
              {current}/{total} passages · {pct}%
            </div>
          </div>
        ) : (
          <div className="mt-4 flex gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-2 w-2 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
