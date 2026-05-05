"use client";

import { useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import ChatPanel from "@/components/ChatPanel";

type OrgLite = { id: string; name: string };
type LibraryLite = { id: string; name: string; pipeline_status?: string | null };

export type ChatSource = {
  library_id: string;
  doc_id: string;
  doc_title?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  chunk_id?: string | null;
  score?: number | null;
  storage_path_raw?: string | null;
};

export default function ChatWorkspace({
  supabase,
  organization,
  libraries,
  onLog,
}: {
  supabase: SupabaseClient;
  organization: OrgLite | null;
  libraries: LibraryLite[];
  onLog?: (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;
}) {
  const readyLibraries = useMemo(() => {
    return libraries.filter((l) => (l.pipeline_status ?? "").toLowerCase() === "completed");
  }, [libraries]);

  // Default selection is derived (no setState in effects).
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>(() =>
    readyLibraries[0]?.id ? [readyLibraries[0].id] : []
  );
  const effectiveSelected = selectedLibraryIds.length > 0 ? selectedLibraryIds : (readyLibraries[0]?.id ? [readyLibraries[0].id] : []);

  return (
    <div className="h-[calc(100vh-128px)] overflow-hidden">
      <ChatPanel
        supabase={supabase}
        organization={organization}
        libraries={libraries}
        selectedLibraryIds={effectiveSelected}
        onChangeSelectedLibraryIds={setSelectedLibraryIds}
        onLog={onLog}
      />
    </div>
  );
}
