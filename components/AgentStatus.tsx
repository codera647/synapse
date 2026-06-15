"use client";

import { useEffect, useRef, useState } from "react";
import { FiCheck, FiChevronDown, FiZap } from "react-icons/fi";

// Reveal a string character-by-character; restarts whenever `text` changes. Also reports whether
// it's still typing, so the caller can show a cursor ONLY during typing (Claude-style: the cursor
// types out the line, vanishes when it settles, then reappears on the next status).
function useTypewriter(text: string, speed = 26): { value: string; typing: boolean } {
  const [shown, setShown] = useState(text);
  const [typing, setTyping] = useState(false);
  const prev = useRef<string>("");
  useEffect(() => {
    if (text === prev.current) return;
    prev.current = text;
    let i = 0;
    setShown("");
    setTyping(true);
    const id = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        setTyping(false);
      }
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return { value: shown || text, typing };
}

// Seconds elapsed since `startedAt`, ticking once per second.
function useElapsed(startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
}

/**
 * Live "what the agent is doing" line shown while generating: a pulsing dot, the current stage
 * typed out character-by-character, a ticking elapsed timer, and a faint trail of the last few
 * completed stages.
 */
export function AgentStatusLine({
  stage,
  startedAt,
  steps,
}: {
  stage: string;
  startedAt?: number;
  steps?: string[];
}) {
  const { value: typed, typing } = useTypewriter(stage || "Thinking");
  const elapsed = useElapsed(startedAt);
  const prior = (steps || []).slice(0, -1).slice(-3); // last few completed (excludes the current)

  return (
    <div className="rounded-2xl rounded-tl-md glass px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="relative grid h-5 w-5 shrink-0 place-items-center">
          <span className="absolute h-5 w-5 rounded-full bg-violet-400/20 animate-ping" />
          <span className="h-2 w-2 rounded-full bg-gradient-to-br from-violet-300 to-fuchsia-300" />
        </span>
        <span className="text-sm text-white/85">
          {typed}
          {typing ? (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] rounded-full bg-violet-300 align-middle" />
          ) : null}
        </span>
        {elapsed > 0 ? (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-white/35">{elapsed}s</span>
        ) : null}
      </div>
      {prior.length ? (
        <div className="mt-2 space-y-1 pl-[3px]">
          {prior.map((s, i) => (
            <div key={`${s}-${i}`} className="flex items-center gap-2 text-[11px] text-white/35">
              <FiCheck className="h-3 w-3 shrink-0 text-emerald-400/70" />
              <span className="truncate">{s}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * After the answer is written, a collapsed "Answered in N steps" disclosure that expands to the
 * full activity trail — the trust/transparency view for the agentic pipeline.
 */
export function AgentStepsTrail({ steps }: { steps?: string[] }) {
  const [open, setOpen] = useState(false);
  const list = steps || [];
  if (list.length === 0) return null;
  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-white/40 hover:bg-white/5 hover:text-white/70 transition-colors"
      >
        <FiZap className="h-3 w-3 text-violet-300/70" />
        Answered in {list.length} step{list.length === 1 ? "" : "s"}
        <FiChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5">
          {list.map((s, i) => (
            <div key={`${s}-${i}`} className="flex items-center gap-2 text-[11px] text-white/60">
              <FiCheck className="h-3 w-3 shrink-0 text-emerald-400" />
              <span>{s}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
