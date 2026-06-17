"use client";

import KnowledgeGraphLoader from "@/components/KnowledgeGraphLoader";

// Per-tab loading skeletons shown while the dashboard boots, so each page shows a layout that
// matches what's about to load (instead of the libraries grid everywhere). Uses the shared
// `usage-bar` / `animate-pulse` / `gen-shimmer-text` animations.

const bar = "animate-pulse rounded bg-white/10";
const soft = "animate-pulse rounded bg-white/[0.06]";

function Caption({ label }: { label: string }) {
  return <span className="gen-shimmer-text text-xs">{label}</span>;
}

function SkelBars({ count, h, gap = "gap-1.5" }: { count: number; h: string; gap?: string }) {
  return (
    <div className={`flex items-end ${gap} ${h}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="usage-bar flex-1 rounded-t bg-gradient-to-t from-violet-500/30 to-fuchsia-400/20"
          style={{ height: `${22 + ((i * 37) % 78)}%`, animationDelay: `${(i % 12) * 70}ms` }}
        />
      ))}
    </div>
  );
}

function ChatBubble({ side, w, lines }: { side: "left" | "right"; w: string; lines: number }) {
  return (
    <div className={`flex ${side === "right" ? "justify-end" : "justify-start"}`}>
      <div className="space-y-1.5" style={{ width: w }}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`h-4 ${soft} ${side === "right" ? "ml-auto" : ""}`}
            style={{ width: i === lines - 1 ? "70%" : "100%", animationDelay: `${i * 100}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="h-[calc(100vh-5.25rem)] px-4 pb-4 pt-3 sm:px-6 md:pr-10">
      <div className="flex h-full overflow-hidden rounded-2xl surface-panel shadow-[0_18px_70px_rgba(0,0,0,0.35)]">
        {/* history rail */}
        <aside className="hidden w-64 shrink-0 flex-col gap-2 border-r border-white/10 bg-black/15 p-3 lg:flex">
          <div className={`h-10 w-full ${bar}`} />
          <div className={`h-9 w-full ${soft}`} />
          <div className="mt-2 space-y-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className={`h-8 w-full ${soft}`} style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        </aside>
        {/* conversation */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div className={`h-5 w-40 ${bar}`} />
            <div className={`h-7 w-28 rounded-lg ${bar}`} />
          </div>
          <div className="flex-1 overflow-hidden px-3 py-8 sm:px-5">
            <div className="mx-auto w-full max-w-3xl space-y-6">
              <ChatBubble side="right" w="60%" lines={1} />
              <ChatBubble side="left" w="85%" lines={3} />
              <ChatBubble side="right" w="45%" lines={1} />
              <ChatBubble side="left" w="72%" lines={2} />
            </div>
          </div>
          <div className="px-3 pb-5 sm:px-5">
            <div className="mx-auto w-full max-w-3xl">
              <div className={`h-12 w-full rounded-2xl ${bar}`} />
              <div className="mt-2 flex justify-center">
                <Caption label="Loading chat…" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentSkeleton() {
  return (
    <div className="h-[calc(100vh-5.25rem)] px-4 pb-4 pt-3 sm:px-6 md:pr-10">
      <div className="flex h-full flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className={`h-9 w-40 rounded-xl ${bar}`} />
          <div className={`h-9 w-28 rounded-xl ${bar}`} />
          <div className={`h-9 w-24 rounded-xl ${soft}`} />
        </div>
        <div className="flex-1 overflow-hidden rounded-2xl surface-panel p-6 shadow-[0_18px_70px_rgba(0,0,0,0.35)]">
          <div className="mx-auto w-full max-w-3xl space-y-6">
            <ChatBubble side="right" w="55%" lines={1} />
            <ChatBubble side="left" w="90%" lines={4} />
            <ChatBubble side="right" w="40%" lines={1} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className={`h-32 rounded-xl ${soft}`} />
              <div className={`h-32 rounded-xl ${soft}`} style={{ animationDelay: "120ms" }} />
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-col items-center">
          <div className={`h-12 w-full max-w-3xl rounded-2xl ${bar}`} />
          <div className="mt-2">
            <Caption label="Loading agent…" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function GraphSkeleton() {
  return (
    <div className="h-[calc(100vh-5.25rem)] px-4 pb-4 pt-3 sm:px-6 md:pr-10">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className={`h-5 w-64 ${bar}`} />
        <div className={`h-9 w-40 rounded-xl ${bar}`} />
      </div>
      <div className="relative h-[calc(100%-2.75rem)] overflow-hidden rounded-2xl surface-panel shadow-[0_18px_70px_rgba(0,0,0,0.35)]">
        <KnowledgeGraphLoader title="Loading knowledge graph…" subtitle="Preparing your graph" />
      </div>
    </div>
  );
}

export function UsageSkeleton() {
  return (
    <div className="h-[calc(100vh-5.25rem)] overflow-y-auto px-4 pb-8 pt-3 sm:px-6 md:pr-10">
      <div className="mb-5 flex items-center justify-between">
        <div className={`h-7 w-28 ${bar}`} />
        <div className={`h-7 w-44 rounded-full ${soft}`} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="rounded-2xl glass glass-hi p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="space-y-2">
                <div className={`h-3 w-28 ${bar}`} />
                <div className={`h-7 w-24 ${bar}`} />
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className={`h-6 w-16 rounded-full ${soft}`} style={{ animationDelay: `${i * 90}ms` }} />
                ))}
              </div>
            </div>
            <SkelBars count={28} h="h-[240px]" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl glass glass-hi p-4">
                <div className="flex items-baseline justify-between">
                  <div className={`h-3.5 w-20 ${bar}`} />
                  <div className={`h-4 w-10 ${bar}`} />
                </div>
                <div className={`mt-1.5 h-2.5 w-28 ${soft}`} />
                <div className="mt-3">
                  <SkelBars count={16} h="h-[52px]" gap="gap-1" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-5">
          <div className="space-y-3.5 rounded-2xl glass glass-hi p-5">
            <div className={`h-3.5 w-28 ${bar}`} />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-between">
                  <div className={`h-2.5 w-24 ${soft}`} />
                  <div className={`h-2.5 w-12 ${soft}`} />
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
                  <div className="h-full animate-pulse rounded-full bg-white/15" style={{ width: `${28 + i * 13}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl glass glass-hi p-5">
            <div className={`mb-3 h-3.5 w-16 ${bar}`} />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl border border-white/8 bg-white/[0.03]" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
