"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiUser, FiUsers, FiChevronDown, FiCheck } from "react-icons/fi";
import AgentPanel from "@/components/AgentPanel";
import { isLibraryReady } from "@/components/ChatPanel";

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
type TeamMember = { userId: string; name: string | null; email: string; avatarUrl: string | null };
type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default function AgentWorkspace({
  supabase,
  organization,
  libraries,
  onLog,
}: {
  supabase: SupabaseClient;
  // Personal agent follows the org selected in the dashboard navbar; team agent is a team picked in-panel.
  organization?: OrgLite | null;
  libraries?: LibraryLite[];
  onLog?: LogFn;
}) {
  const [me, setMe] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamOrg[]>([]);
  const [homeOrg, setHomeOrg] = useState<OrgLite | null>(organization ?? null);

  const [scope, setScope] = useState<"personal" | "team">("personal");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamLibraries, setTeamLibraries] = useState<LibraryLite[]>([]);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const teamMenuRef = useRef<HTMLDivElement | null>(null);

  // ── Identity, teams you belong to, home org.
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

    setMe(uid);
    setTeams(realTeams);
    setHomeOrg(home ? { id: home.id, name: home.name } : organization ?? null);
    setSelectedTeamId((prev) => (prev && realTeams.some((t) => t.id === prev) ? prev : realTeams[0]?.id ?? null));
  }, [supabase, organization]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // ── Selected team's shared libraries.
  useEffect(() => {
    if (scope !== "team" || !selectedTeamId) {
      setTeamLibraries([]);
      return;
    }
    let alive = true;
    (async () => {
      const { data: shares } = await supabase
        .from("team_library_shares")
        .select("library_id")
        .eq("organization_id", selectedTeamId);
      if (!alive) return;
      const ids = ((shares as Array<{ library_id?: string }>) || [])
        .map((s) => String(s.library_id || ""))
        .filter(Boolean);
      if (ids.length === 0) {
        setTeamLibraries([]);
        return;
      }
      const { data: libs } = await supabase
        .from("libraries")
        .select("id, name, pipeline_status, status, pipeline_progress_percent, created_by_user_id")
        .in("id", ids);
      const rows = (libs as Array<Record<string, unknown>>) || [];
      const ownerIds = Array.from(new Set(rows.map((l) => String(l.created_by_user_id || "")).filter(Boolean)));
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
  }, [scope, selectedTeamId, supabase, me]);

  // ── Selected team's members (for contributor avatars).
  useEffect(() => {
    if (scope !== "team" || !selectedTeamId) {
      setTeamMembers([]);
      return;
    }
    let alive = true;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      const res = await fetch(`/api/team/members?org=${encodeURIComponent(selectedTeamId)}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!alive || !res.ok) return;
      const j = (await res.json()) as { members?: TeamMember[] };
      setTeamMembers(j.members || []);
    })();
    return () => {
      alive = false;
    };
  }, [scope, selectedTeamId, supabase]);

  // Close the team menu on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (teamMenuRef.current && !teamMenuRef.current.contains(e.target as Node)) setTeamMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const selectedTeam = useMemo(() => teams.find((t) => t.id === selectedTeamId) || null, [teams, selectedTeamId]);
  const personalOrg: OrgLite | null = organization ?? homeOrg;
  const personalLibraries = useMemo<LibraryLite[]>(() => (libraries ?? []).filter(isLibraryReady), [libraries]);
  const activeOrg: OrgLite | null = scope === "team" ? (selectedTeam ? { id: selectedTeam.id, name: selectedTeam.name } : null) : personalOrg;
  const effectiveLibraries = useMemo(
    () => (scope === "team" ? teamLibraries.filter(isLibraryReady) : personalLibraries),
    [scope, teamLibraries, personalLibraries],
  );

  return (
    <div className="flex h-[calc(100vh-5.25rem)] flex-col">
      {/* Scope toggle + (team mode) team selector */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h1 className="mr-1 text-lg font-semibold tracking-tight">
          <span className="gradient-text">Agent</span>
          <span className="ml-2 hidden text-[11px] font-normal text-white/40 sm:inline">
            Turn your libraries &amp; files into visuals
          </span>
        </h1>
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
              <div className="surface-menu absolute left-0 top-11 z-30 w-60 max-w-[calc(100vw-1.5rem)] rounded-xl p-1.5 shadow-2xl shadow-black/50">
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

        {scope === "team" && teamMembers.length > 0 ? (
          <div className="flex items-center pl-1">
            <div className="flex items-center -space-x-2">
              {teamMembers.slice(0, 6).map((m) => (
                <span
                  key={m.userId}
                  title={m.name || m.email}
                  className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[10px] font-semibold text-white ring-2 ring-[var(--bg-primary)]"
                >
                  {m.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    (m.name || m.email || "?").slice(0, 1).toUpperCase()
                  )}
                </span>
              ))}
              {teamMembers.length > 6 ? (
                <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-[10px] font-medium text-white/70 ring-2 ring-[var(--bg-primary)]">
                  +{teamMembers.length - 6}
                </span>
              ) : null}
            </div>
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
                libraries to build visuals together here.
              </p>
            </div>
          </div>
        ) : (
          <AgentPanel
            key={`${scope}:${activeOrg?.id ?? "none"}`}
            supabase={supabase}
            organization={activeOrg}
            libraries={effectiveLibraries}
            currentUserId={me}
            scope={scope}
            onLog={onLog}
          />
        )}
      </div>
    </div>
  );
}
