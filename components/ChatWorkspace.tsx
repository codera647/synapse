"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiUser, FiUsers, FiChevronDown, FiCheck } from "react-icons/fi";
import ChatPanel, { isLibraryReady } from "@/components/ChatPanel";

type OrgLite = { id: string; name: string };
type LibraryLite = {
  id: string;
  name: string;
  pipeline_status?: string | null;
  status?: string | null;
  pipeline_progress_percent?: number | null;
  ownerLabel?: string | null;
};
type TeamOrg = { id: string; name: string; role: string };

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

type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default function ChatWorkspace({
  supabase,
  onLog,
}: {
  supabase: SupabaseClient;
  // organization/libraries props are accepted for compatibility but the chat now sources its own
  // org context (personal = your libraries; team = a team you pick in-panel).
  organization?: OrgLite | null;
  libraries?: LibraryLite[];
  onLog?: LogFn;
}) {
  const [me, setMe] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamOrg[]>([]);
  const [homeOrg, setHomeOrg] = useState<OrgLite | null>(null);
  const [myLibraries, setMyLibraries] = useState<LibraryLite[]>([]);

  const [scope, setScope] = useState<"personal" | "team">("personal");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamLibraries, setTeamLibraries] = useState<LibraryLite[]>([]);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [teamRefresh, setTeamRefresh] = useState(0);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [teamDebug, setTeamDebug] = useState<string | null>(null);

  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const teamMenuRef = useRef<HTMLDivElement | null>(null);

  // ── Load identity, the teams you belong to, your home org, and your own libraries.
  const loadBase = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const uid = user?.id;
    if (!uid) return;

    const { data: mems } = await supabase
      .from("organization_members")
      .select("organization_id, role, organizations(id, name)")
      .eq("user_id", uid);
    const orgs: TeamOrg[] = ((mems as unknown as Array<Record<string, unknown>>) || [])
      .map((m) => {
        const o = pickOne(m.organizations as Record<string, unknown> | Record<string, unknown>[]);
        return o ? { id: String(o.id), name: String(o.name || "Org"), role: String(m.role || "member") } : null;
      })
      .filter(Boolean) as TeamOrg[];

    const home = orgs.find((o) => o.role === "owner") || orgs[0] || null;

    // "Real teams" = orgs with more than one member OR with libraries shared into them.
    const orgIds = orgs.map((o) => o.id);
    const counts: Record<string, number> = {};
    const withShares = new Set<string>();
    if (orgIds.length) {
      const [{ data: allMems }, { data: sh }] = await Promise.all([
        supabase.from("organization_members").select("organization_id").in("organization_id", orgIds),
        supabase.from("team_library_shares").select("organization_id").in("organization_id", orgIds),
      ]);
      ((allMems as Array<{ organization_id?: string }>) || []).forEach((r) => {
        const k = String(r.organization_id);
        counts[k] = (counts[k] || 0) + 1;
      });
      ((sh as Array<{ organization_id?: string }>) || []).forEach((r) => withShares.add(String(r.organization_id)));
    }
    const realTeams = orgs.filter((o) => (counts[o.id] || 0) > 1 || withShares.has(o.id));

    const { data: libs } = await supabase
      .from("libraries")
      .select("id, name, pipeline_status, status, pipeline_progress_percent")
      .eq("created_by_user_id", uid)
      .order("created_at", { ascending: false });

    setMe(uid);
    setTeams(realTeams);
    setHomeOrg(home ? { id: home.id, name: home.name } : null);
    setMyLibraries(
      ((libs as Array<Record<string, unknown>>) || []).map((l) => ({
        id: String(l.id),
        name: String(l.name || "Library"),
        pipeline_status: (l.pipeline_status as string | null) ?? null,
        status: (l.status as string | null) ?? null,
        pipeline_progress_percent: (l.pipeline_progress_percent as number | null) ?? null,
      })),
    );
    setSelectedTeamId((prev) => (prev && realTeams.some((t) => t.id === prev) ? prev : realTeams[0]?.id ?? null));
  }, [supabase]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // ── Load the selected team's shared libraries (with owner labels).
  useEffect(() => {
    if (scope !== "team" || !selectedTeamId) {
      setTeamLibraries([]);
      return;
    }
    let alive = true;
    (async () => {
      const { data: shares, error: shErr } = await supabase
        .from("team_library_shares")
        .select("library_id")
        .eq("organization_id", selectedTeamId);
      if (!alive) return;
      if (shErr) {
        onLog?.({ level: "warn", message: "Team chat: failed to load shares", details: shErr });
        setTeamLibraries([]);
        return;
      }
      const ids = ((shares as Array<{ library_id?: string }>) || [])
        .map((s) => String(s.library_id || ""))
        .filter(Boolean);

      // DIAGNOSTIC: also pull EVERY share row the current user can see (no org filter),
      // so we can tell whether the share exists under a *different* org id than the one
      // the chat is querying — which is the only way the Team screen can show 1 while chat shows 0.
      const { data: allShares, error: allErr } = await supabase
        .from("team_library_shares")
        .select("organization_id, library_id");
      const allRows = (allShares as Array<{ organization_id?: string; library_id?: string }>) || [];
      const short = (v: string | null | undefined) => (v ? String(v).slice(0, 8) : "—");
      const dbg =
        `querying org ${short(selectedTeamId)} → ${ids.length} share(s). ` +
        `You can see ${allRows.length} share(s) total` +
        (allRows.length
          ? `: ${allRows.map((r) => `org ${short(r.organization_id)}`).join(", ")}`
          : allErr
            ? ` (read error: ${allErr.message || allErr.code || "RLS?"})`
            : "");
      setTeamDebug(dbg);
      onLog?.({
        level: "info",
        message: `Team chat diagnostic — ${dbg}`,
        details: { queriedOrg: selectedTeamId, hitCount: ids.length, allShares: allRows },
      });
      if (ids.length === 0) {
        setTeamLibraries([]);
        return;
      }
      const { data: libs, error: libErr } = await supabase
        .from("libraries")
        .select("id, name, pipeline_status, status, pipeline_progress_percent, created_by_user_id")
        .in("id", ids);
      const rows = (libs as Array<Record<string, unknown>>) || [];
      // DIAGNOSTIC step 2: did the shared library row come back, and what is its status?
      setTeamDebug(
        `${dbg} | libs fetched: ${rows.length}` +
          (rows.length
            ? ` → ${rows
                .map(
                  (l) =>
                    `"${l.name}" pipeline=${l.pipeline_status ?? "null"} status=${l.status ?? "null"} pct=${l.pipeline_progress_percent ?? "null"}`,
                )
                .join(", ")}`
            : libErr
              ? ` (read error: ${libErr.message || libErr.code})`
              : ` (library_id ${ids.map((i) => i.slice(0, 8)).join(",")} not found in libraries)`),
      );
      onLog?.({
        level: "info",
        message: `Team chat: ${rows.length} shared library(ies) loaded`,
        details: rows.map((l) => ({ name: l.name, pipeline_status: l.pipeline_status })),
      });
      const ownerIds = Array.from(
        new Set(rows.map((l) => String(l.created_by_user_id || "")).filter(Boolean)),
      );
      const ownerNames: Record<string, string> = {};
      if (ownerIds.length) {
        const { data: us } = await supabase.from("users").select("id, name, email").in("id", ownerIds);
        ((us as Array<Record<string, unknown>>) || []).forEach((u) => {
          ownerNames[String(u.id)] = String(u.name || u.email || "teammate");
        });
      }
      if (!alive) return;
      setTeamLibraries(
        rows.map((l) => {
          const owner = String(l.created_by_user_id || "");
          const label = owner && owner === me ? "by you" : `by ${ownerNames[owner] || "teammate"}`;
          return {
            id: String(l.id),
            name: String(l.name || "Library"),
            pipeline_status: (l.pipeline_status as string | null) ?? null,
            status: (l.status as string | null) ?? null,
            pipeline_progress_percent: (l.pipeline_progress_percent as number | null) ?? null,
            ownerLabel: label,
          };
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, [scope, selectedTeamId, supabase, me, onLog, teamRefresh]);

  // Close the team menu on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (teamMenuRef.current && !teamMenuRef.current.contains(e.target as Node)) setTeamMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const selectedTeam = useMemo(() => teams.find((t) => t.id === selectedTeamId) || null, [teams, selectedTeamId]);
  const activeOrg: OrgLite | null = scope === "team" ? (selectedTeam ? { id: selectedTeam.id, name: selectedTeam.name } : null) : homeOrg;
  const effectiveLibraries = scope === "team" ? teamLibraries : myLibraries;

  const readyLibraries = useMemo(
    () => effectiveLibraries.filter(isLibraryReady),
    [effectiveLibraries],
  );

  // Your own processed libraries that aren't yet shared into the selected team —
  // shown in the team `+` picker so you can share them right here (no Team-screen round-trip).
  const shareableLibraries = useMemo(() => {
    if (scope !== "team") return [];
    const already = new Set(teamLibraries.map((l) => l.id));
    return myLibraries.filter(
      (l) => isLibraryReady(l) && !already.has(l.id),
    );
  }, [scope, myLibraries, teamLibraries]);

  const shareToTeam = useCallback(
    async (libraryId: string) => {
      if (scope !== "team" || !selectedTeamId || !me) return;
      setSharingId(libraryId);
      try {
        const { error } = await supabase.from("team_library_shares").insert({
          organization_id: selectedTeamId,
          library_id: libraryId,
          shared_by_user_id: me,
        });
        if (error) {
          onLog?.({ level: "error", message: "Couldn't share that library with the team", details: error });
          return;
        }
        onLog?.({ level: "success", message: "Library shared with the team" });
        setTeamRefresh((k) => k + 1);
      } finally {
        setSharingId(null);
      }
    },
    [scope, selectedTeamId, me, supabase, onLog],
  );
  const validSelected = useMemo(() => {
    const ids = new Set(readyLibraries.map((l) => l.id));
    return selectedLibraryIds.filter((id) => ids.has(id));
  }, [selectedLibraryIds, readyLibraries]);
  const effectiveSelected = validSelected.length > 0 ? validSelected : readyLibraries[0]?.id ? [readyLibraries[0].id] : [];

  return (
    <div className="flex h-[calc(100vh-128px)] flex-col">
      {/* Scope toggle + (team mode) team selector */}
      <div className="mb-2 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1">
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
        </div>

        {scope === "team" && teams.length > 0 ? (
          <div className="relative" ref={teamMenuRef}>
            <button
              type="button"
              onClick={() => setTeamMenuOpen((v) => !v)}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/80 hover:text-white"
            >
              <FiUsers className="h-3.5 w-3.5 text-violet-300" />
              <span className="max-w-[12rem] truncate">{selectedTeam?.name || "Select a team"}</span>
              <FiChevronDown className={`h-3.5 w-3.5 text-white/40 transition-transform ${teamMenuOpen ? "rotate-180" : ""}`} />
            </button>
            {teamMenuOpen ? (
              <div className="surface-menu absolute left-0 top-11 z-30 w-60 rounded-xl p-1.5 shadow-2xl shadow-black/50">
                <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-white/35">Your teams</div>
                {teams.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setSelectedTeamId(t.id);
                      setTeamMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      t.id === selectedTeamId ? "bg-violet-500/20 text-white" : "text-white/70 hover:bg-white/6"
                    }`}
                  >
                    <span className="truncate">{t.name}</span>
                    {t.id === selectedTeamId ? <FiCheck className="h-3.5 w-3.5 shrink-0 text-violet-300" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {scope === "team" && teams.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="max-w-sm">
              <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
                <FiUsers className="h-6 w-6 text-white" />
              </span>
              <div className="text-sm font-medium text-white/85">You&apos;re not in any teams yet</div>
              <p className="mt-1 text-xs text-white/45">
                Invite teammates or get invited from the <span className="text-violet-300">Team</span> tab, then share
                libraries to chat together here.
              </p>
            </div>
          </div>
        ) : (
          <ChatPanel
            supabase={supabase}
            organization={activeOrg}
            libraries={effectiveLibraries}
            selectedLibraryIds={effectiveSelected}
            onChangeSelectedLibraryIds={setSelectedLibraryIds}
            onLog={onLog}
            scope={scope}
            shareableLibraries={shareableLibraries}
            onShareLibrary={shareToTeam}
            sharingLibraryId={sharingId}
            teamDebug={scope === "team" ? teamDebug : null}
          />
        )}
      </div>
    </div>
  );
}
