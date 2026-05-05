"use client";

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiCheck } from "react-icons/fi";

type LibraryLite = { id: string; name: string; pipeline_status?: string | null };

type ChatSource = {
  library_id: string;
  doc_id: string;
  doc_title?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  chunk_id?: string | null;
  score?: number | null;
  storage_path_raw?: string | null;
};

export default function ChatSourcesPanel({
  supabase,
  libraries,
  selectedLibraryIds,
  onChangeSelectedLibraryIds,
  sources,
  onLog,
}: {
  supabase: SupabaseClient;
  libraries: LibraryLite[];
  selectedLibraryIds: string[];
  onChangeSelectedLibraryIds: (ids: string[]) => void;
  sources?: ChatSource[];
  onLog?: (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;
}) {
  const [open, setOpen] = useState(false);

  const readyLibraries = useMemo(() => {
    return libraries
      .filter((l) => (l.pipeline_status ?? "").toLowerCase() === "completed")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [libraries]);

  useEffect(() => {
    if (selectedLibraryIds.length === 0 && readyLibraries.length > 0) {
      onChangeSelectedLibraryIds([readyLibraries[0].id]);
    }
  }, [selectedLibraryIds, readyLibraries, onChangeSelectedLibraryIds]);

  const selectedSet = useMemo(() => new Set(selectedLibraryIds), [selectedLibraryIds]);
  const selectedLabel = useMemo(() => {
    if (selectedLibraryIds.length === 0) return "Select libraries";
    if (selectedLibraryIds.length === 1) {
      const l = readyLibraries.find((x) => x.id === selectedLibraryIds[0]);
      return l?.name ?? "1 library selected";
    }
    return `${selectedLibraryIds.length} libraries selected`;
  }, [readyLibraries, selectedLibraryIds]);

  const toggleLibrary = (id: string) => {
    onChangeSelectedLibraryIds(
      selectedSet.has(id) ? selectedLibraryIds.filter((x) => x !== id) : [...selectedLibraryIds, id]
    );
  };

  // This panel is intentionally NOT a sources list.
  // Each assistant message shows its own referenced PDFs inline under the message.

  return (
    <aside className="h-full rounded-2xl border border-white/10 bg-[color:var(--bg-secondary)]/35 shadow-[0_18px_70px_rgba(0,0,0,0.30)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/20 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Libraries</div>
          <div className="mt-0.5 text-sm font-medium text-gray-100 truncate">
            Libraries used in this chat
          </div>
        </div>
      </div>

      <div className="px-4 pt-3">
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="w-full rounded-xl border border-white/10 bg-[radial-gradient(circle_at_25%_20%,rgba(184,127,217,0.10),transparent_55%)] px-3 py-2 text-left text-sm text-gray-100 shadow-inner hover:border-white/20 transition-colors"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate">{selectedLabel}</span>
              <span className="text-[11px] text-gray-500">{open ? "Hide" : "Choose"}</span>
            </div>
            <div className="mt-1 text-[11px] text-gray-500">
              Selected libraries are used as context for retrieval.
            </div>
          </button>

          {open ? (
            <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-white/10 bg-[#05060C] shadow-2xl shadow-black/60">
              <div className="max-h-64 overflow-auto p-2">
                {readyLibraries.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-gray-400">No processed libraries yet.</div>
                ) : (
                  readyLibraries.map((l) => {
                    const checked = selectedSet.has(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => toggleLibrary(l.id)}
                        className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                          checked ? "bg-white/10 text-gray-100" : "text-gray-300 hover:bg-white/5 hover:text-gray-100"
                        }`}
                      >
                        <span className="truncate">{l.name}</span>
                        {checked ? <FiCheck className="h-4 w-4 text-[#b87fd9]" /> : <span className="h-4 w-4" />}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="border-t border-white/10 bg-black/30 px-3 py-2 text-[11px] text-gray-500">
                Tip: pick multiple libraries to broaden context.
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 h-[calc(100%-112px)] overflow-auto px-4 pb-4">
        <div className="rounded-xl border border-white/10 bg-white/4 p-4 text-sm text-gray-300">
          Every answer shows its referenced PDFs directly under that message. Use this panel only to choose which libraries the agent is allowed to search.
        </div>
      </div>
    </aside>
  );
}
