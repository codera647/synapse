"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import AgentPanel from "@/components/AgentPanel";
import { isLibraryReady } from "@/components/ChatPanel";

type OrgLite = { id: string; name: string };
type LibraryLite = {
  id: string;
  name: string;
  pipeline_status?: string | null;
  status?: string | null;
  pipeline_progress_percent?: number | null;
};
type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

export default function AgentWorkspace({
  supabase,
  organization,
  onLog,
}: {
  supabase: SupabaseClient;
  organization?: OrgLite | null;
  libraries?: LibraryLite[];
  onLog?: LogFn;
}) {
  const [me, setMe] = useState<string | null>(null);
  const [homeOrg, setHomeOrg] = useState<OrgLite | null>(organization ?? null);
  const [myLibraries, setMyLibraries] = useState<LibraryLite[]>([]);

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
    const orgs = ((mems as unknown as Array<Record<string, unknown>>) || [])
      .map((m) => {
        const oRaw = m.organizations as Record<string, unknown> | Record<string, unknown>[] | null;
        const o = Array.isArray(oRaw) ? oRaw[0] : oRaw;
        return o ? { id: String(o.id), name: String(o.name || "Org"), role: String(m.role || "member") } : null;
      })
      .filter(Boolean) as Array<{ id: string; name: string; role: string }>;
    const home = orgs.find((o) => o.role === "owner") || orgs[0] || null;

    const { data: libs } = await supabase
      .from("libraries")
      .select("id, name, pipeline_status, status, pipeline_progress_percent")
      .eq("created_by_user_id", uid)
      .order("created_at", { ascending: false });

    setMe(uid);
    setHomeOrg(home ? { id: home.id, name: home.name } : organization ?? null);
    setMyLibraries(
      ((libs as Array<Record<string, unknown>>) || []).map((l) => ({
        id: String(l.id),
        name: String(l.name || "Library"),
        pipeline_status: (l.pipeline_status as string | null) ?? null,
        status: (l.status as string | null) ?? null,
        pipeline_progress_percent: (l.pipeline_progress_percent as number | null) ?? null,
      })),
    );
  }, [supabase, organization]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  const readyLibraries = useMemo(() => myLibraries.filter(isLibraryReady), [myLibraries]);

  return (
    <div className="flex h-[calc(100vh-5.25rem)] flex-col">
      <div className="mb-2 flex items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">
          <span className="gradient-text">Agent</span>
          <span className="ml-2 text-[11px] font-normal text-white/40">
            Turn your libraries &amp; files into visuals
          </span>
        </h1>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentPanel
          supabase={supabase}
          organization={homeOrg}
          libraries={readyLibraries}
          currentUserId={me}
          onLog={onLog}
        />
      </div>
    </div>
  );
}
