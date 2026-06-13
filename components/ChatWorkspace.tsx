"use client";

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiUser, FiUsers } from "react-icons/fi";
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
  const [scope, setScope] = useState<"personal" | "team">("personal");
  const [teamLibraries, setTeamLibraries] = useState<LibraryLite[]>([]);

  // In team scope, the library pool is whatever members have shared into this team — which may
  // belong to different members' orgs (so chat must retrieve cross-org).
  useEffect(() => {
    if (scope !== "team" || !organization?.id) {
      setTeamLibraries([]);
      return;
    }
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("team_library_shares")
        .select("library_id, libraries(id, name, pipeline_status)")
        .eq("organization_id", organization.id);
      if (!alive) return;
      if (error) {
        onLog?.({ level: "warn", message: "Team chat: failed to load shared libraries", details: error });
        setTeamLibraries([]);
        return;
      }
      const libs = ((data as unknown as Array<{ libraries: unknown }>) || [])
        .map((r) => (Array.isArray(r.libraries) ? r.libraries[0] : r.libraries) as Record<string, unknown> | null)
        .filter(Boolean)
        .map((l) => ({
          id: String((l as Record<string, unknown>).id),
          name: String((l as Record<string, unknown>).name || "Library"),
          pipeline_status: ((l as Record<string, unknown>).pipeline_status as string | null) ?? null,
        }));
      setTeamLibraries(libs);
    })();
    return () => {
      alive = false;
    };
  }, [scope, organization?.id, supabase, onLog]);

  const effectiveLibraries = scope === "team" ? teamLibraries : libraries;
  const readyLibraries = useMemo(
    () => effectiveLibraries.filter((l) => (l.pipeline_status ?? "").toLowerCase() === "completed"),
    [effectiveLibraries],
  );

  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  // Drop selections that don't belong to the current scope's libraries; default to the first ready.
  const validSelected = useMemo(() => {
    const ids = new Set(readyLibraries.map((l) => l.id));
    return selectedLibraryIds.filter((id) => ids.has(id));
  }, [selectedLibraryIds, readyLibraries]);
  const effectiveSelected =
    validSelected.length > 0 ? validSelected : readyLibraries[0]?.id ? [readyLibraries[0].id] : [];

  return (
    <div className="flex h-[calc(100vh-128px)] flex-col">
      {/* Personal ⇄ Team scope toggle */}
      <div className="mb-2 flex items-center gap-1 self-start rounded-xl border border-white/10 bg-white/5 p-1">
        {([
          { key: "personal", label: "Personal", icon: FiUser },
          { key: "team", label: "Team", icon: FiUsers },
        ] as const).map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setScope(s.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              scope === s.key ? "btn-grad text-white" : "text-white/55 hover:text-white"
            }`}
          >
            <s.icon className="h-3.5 w-3.5" />
            {s.label}
          </button>
        ))}
        {scope === "team" ? (
          <span className="ml-2 pr-1 text-[11px] text-white/40">Shared chats over your team&apos;s libraries</span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatPanel
          supabase={supabase}
          organization={organization}
          libraries={effectiveLibraries}
          selectedLibraryIds={effectiveSelected}
          onChangeSelectedLibraryIds={setSelectedLibraryIds}
          onLog={onLog}
          scope={scope}
        />
      </div>
    </div>
  );
}
