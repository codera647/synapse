"use client";

import { FiGrid, FiList, FiPlus, FiSearch, FiFilter } from "react-icons/fi";

/**
 * Loading state for the dashboard / libraries view. Mirrors the real library page so the
 * transition to loaded content is seamless — skeleton cards with a live sweeping progress bar
 * (the same `shimmer` used by real processing cards) make it feel like the workspace is spinning up.
 */
export default function LibrariesSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      {/* Title row */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Your <span className="gradient-text">libraries</span>
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-white/45">
            <span className="gen-shimmer-text">Spinning up your workspace…</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center rounded-xl glass p-1">
            <span className="grid h-7 w-7 place-items-center rounded-lg text-white/25">
              <FiGrid className="h-3.5 w-3.5" />
            </span>
            <span className="grid h-7 w-7 place-items-center rounded-lg text-white/15">
              <FiList className="h-3.5 w-3.5" />
            </span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-xl bg-white/8 px-4 py-2 text-sm text-white/30">
            <FiPlus className="h-4 w-4" /> New library
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="mb-8 flex items-center gap-2">
        <div className="relative w-full max-w-[450px]">
          <FiSearch className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/25" />
          <div className="h-[42px] w-full animate-pulse rounded-xl bg-white/[0.06]" />
        </div>
        <div className="grid h-[42px] w-[42px] place-items-center rounded-xl glass text-white/20">
          <FiFilter className="h-4 w-4" />
        </div>
      </div>

      {/* Skeleton cards */}
      <div className="grid max-w-[920px] gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonLibraryCard key={i} delay={i * 120} />
        ))}
      </div>
    </div>
  );
}

function SkeletonLibraryCard({ delay }: { delay: number }) {
  return (
    <div className="flex w-full items-center justify-between gap-4 rounded-2xl glass glass-hi px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex w-full min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="h-4 w-32 animate-pulse rounded bg-white/12" style={{ animationDelay: `${delay}ms` }} />
          <div className="h-3 w-12 animate-pulse rounded bg-white/8" style={{ animationDelay: `${delay + 80}ms` }} />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-36 overflow-hidden rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/[0.06] sm:w-48">
            <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 shimmer" />
          </div>
          <div className="h-3 w-8 animate-pulse rounded bg-white/8" style={{ animationDelay: `${delay + 120}ms` }} />
        </div>
      </div>
      <div className="h-8 w-20 shrink-0 animate-pulse rounded-lg bg-white/8" style={{ animationDelay: `${delay}ms` }} />
    </div>
  );
}
