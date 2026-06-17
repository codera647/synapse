"use client";

import { FiX, FiZap, FiArrowUpRight } from "react-icons/fi";

export type LimitInfo = {
  title: string;
  message: string;
  /** optional usage context shown as a maxed-out bar */
  used?: number;
  limit?: number;
  unit?: string;
  fmt?: (n: number) => string;
};

/**
 * A humble, friendly "you've reached your plan limit" dialog. Controlled — render when `info` is set.
 */
export default function LimitReachedDialog({
  info,
  planLabel = "Free",
  onClose,
  onManage,
}: {
  info: LimitInfo | null;
  planLabel?: string;
  onClose: () => void;
  onManage?: () => void;
}) {
  if (!info) return null;
  const fmt = info.fmt ?? ((n: number) => n.toLocaleString());
  const hasBar = typeof info.used === "number" && typeof info.limit === "number" && Number.isFinite(info.limit);
  const pct = hasBar ? Math.min(100, (info.used! / Math.max(1, info.limit!)) * 100) : 100;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 p-6 text-center shadow-[0_20px_70px_rgba(0,0,0,0.6)] animate-[scaleIn_.16s_ease-out]"
        style={{ backgroundColor: "rgba(20, 25, 37, 0.98)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute right-3 top-3 rounded-lg p-1.5 text-white/40 hover:text-white">
          <FiX className="h-4 w-4" />
        </button>

        <div className="relative mx-auto mb-4 grid h-14 w-14 place-items-center">
          <span className="gen-orb-halo absolute h-14 w-14 rounded-full bg-violet-500/30 blur-md" />
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/30">
            <FiZap className="h-6 w-6 text-white" />
          </span>
        </div>

        <h2 className="text-lg font-bold tracking-tight text-white">{info.title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/65">{info.message}</p>

        {hasBar ? (
          <div className="mx-auto mt-4 max-w-xs">
            <div className="mb-1 flex items-center justify-between text-[11px] text-white/45">
              <span>{planLabel} plan</span>
              <span>
                {fmt(info.used!)}{info.unit ? ` ${info.unit}` : ""}
                <span className="text-white/25"> / {fmt(info.limit!)}{info.unit ? ` ${info.unit}` : ""}</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
              <div className="h-full rounded-full bg-gradient-to-r from-rose-400 to-rose-500" style={{ width: `${Math.max(6, pct)}%` }} />
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-center gap-2">
          {onManage ? (
            <button
              onClick={onManage}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 hover:border-violet-400/40 hover:text-white"
            >
              View usage <FiArrowUpRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button onClick={onClose} className="btn-grad rounded-xl px-5 py-2 text-xs font-medium text-white">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
