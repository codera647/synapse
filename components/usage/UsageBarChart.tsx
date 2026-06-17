"use client";

import { useState } from "react";

export type UsagePoint = { date: string; value: number };

/**
 * Self-contained daily bar chart (SVG) for the Usage dashboard.
 * - variant "full": axis labels (first/last date) + value gridline + hover tooltip.
 * - variant "spark": compact sparkline (no labels) for the capability cards.
 * Hand-built so it matches the dark/violet theme exactly with no chart-lib overhead.
 */
export default function UsageBarChart({
  data,
  height = 220,
  variant = "full",
  color = "#a78bfa",
  formatValue = (n: number) => n.toLocaleString(),
}: {
  data: UsagePoint[];
  height?: number;
  variant?: "full" | "spark";
  color?: string;
  formatValue?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 1000; // viewBox width; scales to container via preserveAspectRatio
  const H = height;
  const padTop = variant === "full" ? 14 : 4;
  const padBottom = variant === "full" ? 22 : 4;
  const plotH = H - padTop - padBottom;
  const gap = n > 1 ? Math.min(6, (W / n) * 0.25) : 0;
  const bw = n > 0 ? (W - gap * (n - 1)) / n : W;

  const total = data.reduce((s, d) => s + d.value, 0);
  const empty = total === 0;

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label="usage over time"
      >
        {variant === "full" && (
          <line
            x1={0}
            x2={W}
            y1={padTop}
            y2={padTop}
            stroke="rgba(255,255,255,0.10)"
            strokeDasharray="4 5"
            strokeWidth={1}
          />
        )}
        {data.map((d, i) => {
          const h = empty ? 2 : Math.max(2, (d.value / max) * plotH);
          const x = i * (bw + gap);
          const y = padTop + (plotH - h);
          const active = hover === i;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={bw}
              height={h}
              rx={Math.min(3, bw / 3)}
              fill={color}
              opacity={empty ? 0.18 : active ? 1 : 0.82}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      {variant === "full" && n > 0 && (
        <div className="mt-1 flex justify-between text-[11px] text-white/35">
          <span>{data[0]?.date}</span>
          <span>{data[n - 1]?.date}</span>
        </div>
      )}

      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-lg border border-white/10 bg-[#1a1326]/95 px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: `${((hover + 0.5) / Math.max(1, n)) * 100}%`, transform: "translate(-50%,-100%)" }}
        >
          <div className="font-semibold text-white/90">{formatValue(data[hover].value)}</div>
          <div className="text-white/45">{data[hover].date}</div>
        </div>
      )}
    </div>
  );
}
