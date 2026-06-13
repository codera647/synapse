"use client";

/**
 * ContextMeter — a small circular gauge showing how full the chat context window is,
 * like the Claude VS Code extension. Fills as the conversation grows; turns amber as it
 * fills and rose (pulsing) when it's about to auto-summarize.
 *
 * Pure SVG (no deps), styled to the Synapse violet→indigo→fuchsia palette.
 */
export default function ContextMeter({
  used,
  budget,
  size = 32,
}: {
  used: number;
  budget: number;
  size?: number;
}) {
  const pct = Math.max(0, Math.min(100, budget > 0 ? Math.round((used / budget) * 100) : 0));

  const stroke = 3;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct / 100);

  const state = pct >= 90 ? "critical" : pct >= 75 ? "warn" : "ok";
  const progressStroke =
    state === "critical" ? "#fb7185" /* rose-400 */
      : state === "warn" ? "#fbbf24" /* amber-400 */
        : "url(#ctxMeterGrad)";
  const numberClass =
    state === "critical" ? "text-rose-200"
      : state === "warn" ? "text-amber-200"
        : "text-white/70";

  const note =
    pct >= 90 ? "Context almost full — older turns will be summarized soon"
      : pct >= 75 ? "Context window filling up"
        : "Context window usage";

  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Context window ${pct}% used`}
      title={`${note}: ${used.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%)`}
    >
      <svg width={size} height={size} className={state === "critical" ? "animate-pulse" : ""}>
        <defs>
          <linearGradient id="ctxMeterGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="50%" stopColor="#818cf8" />
            <stop offset="100%" stopColor="#e879f9" />
          </linearGradient>
        </defs>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={stroke}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={progressStroke}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.3s ease" }}
        />
      </svg>
      <span
        className={`absolute font-semibold tabular-nums ${numberClass}`}
        style={{ fontSize: Math.max(8, Math.round(size * 0.28)) }}
      >
        {pct}
      </span>
    </div>
  );
}
