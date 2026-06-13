"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FiUsers,
  FiMail,
  FiTrash2,
  FiCheck,
  FiX,
  FiShare2,
  FiBox,
  FiUserPlus,
  FiClock,
} from "react-icons/fi";

type OrgLite = { id: string; name: string };
type Member = { userId: string; role: string; email: string; name: string | null; avatarUrl: string | null };
type SentInvite = { id: string; email: string; role: string; createdAt: string };
type MyInvite = { id: string; orgId: string; orgName: string; role: string; invitedBy: string | null };
type SharedLib = { shareId: string; libraryId: string; name: string; ownerId: string | null };
type MyLib = { id: string; name: string; pipelineStatus: string | null };

type LogFn = (e: { level: "info" | "success" | "warn" | "error"; message: string; details?: unknown }) => void;

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default function TeamWorkspace({
  supabase,
  organization,
  onLog,
}: {
  supabase: SupabaseClient;
  organization: OrgLite | null;
  onLog?: LogFn;
}) {
  const [me, setMe] = useState<{ id: string; email: string } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [sentInvites, setSentInvites] = useState<SentInvite[]>([]);
  const [myInvites, setMyInvites] = useState<MyInvite[]>([]);
  const [sharedLibs, setSharedLibs] = useState<SharedLib[]>([]);
  const [myLibs, setMyLibs] = useState<MyLib[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const myRole = useMemo(() => members.find((m) => m.userId === me?.id)?.role ?? "member", [members, me]);
  const isOwner = myRole === "owner" || myRole === "admin";

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes?.user?.id ?? null;
      const email = (userRes?.user?.email ?? "").toLowerCase();
      if (!uid) {
        setLoading(false);
        return;
      }
      setMe({ id: uid, email });

      // Invitations addressed to me (across all orgs) — so an invitee sees them anywhere.
      const invP = supabase
        .from("organization_invitations")
        .select("id, organization_id, role, invited_by_user_id, organizations(name)")
        .eq("email", email)
        .eq("status", "pending");

      // My libraries (any org) — to share into a team.
      const myLibP = supabase
        .from("libraries")
        .select("id, name, pipeline_status")
        .eq("created_by_user_id", uid)
        .order("created_at", { ascending: false });

      const orgId = organization?.id;
      const memP = orgId
        ? supabase
            .from("organization_members")
            .select("role, user_id, users(id, email, name, avatar_url)")
            .eq("organization_id", orgId)
        : Promise.resolve({ data: [], error: null });
      const sentP = orgId
        ? supabase
            .from("organization_invitations")
            .select("id, email, role, created_at")
            .eq("organization_id", orgId)
            .eq("status", "pending")
        : Promise.resolve({ data: [], error: null });
      const sharedP = orgId
        ? supabase
            .from("team_library_shares")
            .select("id, library_id, shared_by_user_id, libraries(id, name, created_by_user_id)")
            .eq("organization_id", orgId)
        : Promise.resolve({ data: [], error: null });

      const [inv, myLib, mem, sent, shared] = await Promise.all([invP, myLibP, memP, sentP, sharedP]);

      setMyInvites(
        ((inv.data as unknown as Array<Record<string, unknown>>) || []).map((r) => {
          const org = pickOne(r.organizations as { name?: string } | { name?: string }[]);
          return {
            id: String(r.id),
            orgId: String(r.organization_id),
            orgName: String(org?.name || "a team"),
            role: String(r.role || "member"),
            invitedBy: r.invited_by_user_id ? String(r.invited_by_user_id) : null,
          };
        }),
      );

      setMyLibs(
        ((myLib.data as unknown as Array<Record<string, unknown>>) || []).map((r) => ({
          id: String(r.id),
          name: String(r.name || "Library"),
          pipelineStatus: r.pipeline_status ? String(r.pipeline_status) : null,
        })),
      );

      setMembers(
        ((mem.data as unknown as Array<Record<string, unknown>>) || []).map((r) => {
          const u = pickOne(r.users as Record<string, unknown> | Record<string, unknown>[]);
          return {
            userId: String(r.user_id),
            role: String(r.role || "member"),
            email: String(u?.email || ""),
            name: u?.name ? String(u.name) : null,
            avatarUrl: u?.avatar_url ? String(u.avatar_url) : null,
          };
        }),
      );

      setSentInvites(
        ((sent.data as unknown as Array<Record<string, unknown>>) || []).map((r) => ({
          id: String(r.id),
          email: String(r.email || ""),
          role: String(r.role || "member"),
          createdAt: String(r.created_at || ""),
        })),
      );

      setSharedLibs(
        ((shared.data as unknown as Array<Record<string, unknown>>) || []).map((r) => {
          const lib = pickOne(r.libraries as Record<string, unknown> | Record<string, unknown>[]);
          return {
            shareId: String(r.id),
            libraryId: String(r.library_id),
            name: String(lib?.name || "Library"),
            ownerId: lib?.created_by_user_id ? String(lib.created_by_user_id) : null,
          };
        }),
      );
    } catch (err) {
      onLog?.({ level: "error", message: "Team: failed to load", details: err });
    } finally {
      setLoading(false);
    }
  }, [supabase, organization?.id, onLog]);

  useEffect(() => {
    void load();
  }, [load]);

  const sharedLibIds = useMemo(() => new Set(sharedLibs.map((s) => s.libraryId)), [sharedLibs]);
  const shareableLibs = useMemo(() => myLibs.filter((l) => !sharedLibIds.has(l.id)), [myLibs, sharedLibIds]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const invite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!organization?.id || !me) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      flash("err", "Enter a valid email address.");
      return;
    }
    if (members.some((m) => m.email.toLowerCase() === email)) {
      flash("err", "That person is already a member.");
      return;
    }
    setBusy(true);
    try {
      const token =
        typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`;
      const { error } = await supabase.from("organization_invitations").insert({
        organization_id: organization.id,
        email,
        invited_by_user_id: me.id,
        role: "member",
        token,
        status: "pending",
      });
      if (error) throw error;
      setInviteEmail("");
      flash("ok", `Invitation sent to ${email}. They'll see it when they sign in.`);
      await load();
    } catch (err) {
      onLog?.({ level: "error", message: "Team: invite failed", details: err });
      flash("err", "Couldn't send the invite (maybe already invited).");
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (id: string) => {
    setBusy(true);
    try {
      await supabase.from("organization_invitations").update({ status: "revoked" }).eq("id", id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const acceptInvite = async (inv: MyInvite) => {
    if (!me) return;
    setBusy(true);
    try {
      const { error: mErr } = await supabase.from("organization_members").insert({
        organization_id: inv.orgId,
        user_id: me.id,
        role: inv.role || "member",
        invited_by_user_id: inv.invitedBy,
      });
      if (mErr && !String(mErr.message || "").toLowerCase().includes("duplicate")) throw mErr;
      await supabase
        .from("organization_invitations")
        .update({ status: "accepted", accepted_by_user_id: me.id, accepted_at: new Date().toISOString() })
        .eq("id", inv.id);
      flash("ok", `You joined ${inv.orgName}. Reloading…`);
      window.setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      onLog?.({ level: "error", message: "Team: accept failed", details: err });
      flash("err", "Couldn't accept the invitation.");
      setBusy(false);
    }
  };

  const declineInvite = async (id: string) => {
    setBusy(true);
    try {
      await supabase.from("organization_invitations").update({ status: "revoked" }).eq("id", id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    if (!organization?.id) return;
    setBusy(true);
    try {
      await supabase
        .from("organization_members")
        .delete()
        .eq("organization_id", organization.id)
        .eq("user_id", userId);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const shareLib = async (libraryId: string) => {
    if (!organization?.id || !me) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("team_library_shares").insert({
        organization_id: organization.id,
        library_id: libraryId,
        shared_by_user_id: me.id,
      });
      if (error) throw error;
      await load();
    } catch (err) {
      onLog?.({ level: "error", message: "Team: share failed", details: err });
      flash("err", "Couldn't share that library.");
    } finally {
      setBusy(false);
    }
  };

  const unshareLib = async (shareId: string) => {
    setBusy(true);
    try {
      await supabase.from("team_library_shares").delete().eq("id", shareId);
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-6 flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/25">
          <FiUsers className="h-5 w-5 text-white" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="gradient-text">{organization?.name || "Team"}</span>
          </h1>
          <p className="text-sm text-white/50">Invite teammates, share libraries, and chat together.</p>
        </div>
      </div>

      {notice ? (
        <div
          className={`mb-4 rounded-xl border px-3.5 py-2.5 text-sm ${
            notice.kind === "ok"
              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
              : "border-rose-400/30 bg-rose-500/10 text-rose-100"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* Invitations addressed to me */}
      {myInvites.length > 0 ? (
        <section className="mb-6 rounded-2xl border border-violet-400/30 bg-violet-500/10 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-violet-100">
            <FiMail className="h-4 w-4" /> Invitations to you
          </h2>
          <div className="space-y-2">
            {myInvites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2.5">
                <div className="min-w-0 text-sm">
                  You've been invited to join <span className="font-semibold text-white">{inv.orgName}</span>.
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void acceptInvite(inv)}
                    className="inline-flex items-center gap-1.5 rounded-lg btn-grad px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    <FiCheck className="h-3.5 w-3.5" /> Accept
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void declineInvite(inv.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-60"
                  >
                    <FiX className="h-3.5 w-3.5" /> Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Members */}
      <section className="mb-6 rounded-2xl surface-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white/85">
            <FiUsers className="h-4 w-4 text-violet-300" /> Members
            <span className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-white/50">{members.length}</span>
          </h2>
        </div>

        {/* Invite form */}
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-1.5">
          <FiUserPlus className="ml-2 h-4 w-4 shrink-0 text-white/40" />
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void invite();
            }}
            placeholder="Invite a teammate by email…"
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-white placeholder:text-white/35 outline-none"
          />
          <button
            type="button"
            disabled={busy || !inviteEmail.trim()}
            onClick={() => void invite()}
            className="shrink-0 rounded-lg btn-grad px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            Invite
          </button>
        </div>

        <div className="space-y-1.5">
          {loading ? (
            <div className="px-1 py-3 text-sm text-white/40">Loading…</div>
          ) : (
            members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/5">
                <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-xs font-semibold text-white">
                  {m.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    (m.name || m.email || "?").slice(0, 1).toUpperCase()
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white/90">
                    {m.name || m.email || "Member"}
                    {m.userId === me?.id ? <span className="text-white/40"> (you)</span> : null}
                  </div>
                  <div className="truncate text-[11px] text-white/40">{m.email}</div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    m.role === "owner" || m.role === "admin"
                      ? "bg-violet-500/20 text-violet-200"
                      : "bg-white/8 text-white/50"
                  }`}
                >
                  {m.role}
                </span>
                {isOwner && m.userId !== me?.id && m.role !== "owner" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeMember(m.userId)}
                    className="shrink-0 rounded-lg p-1.5 text-white/30 hover:bg-rose-500/12 hover:text-rose-300 disabled:opacity-50"
                    title="Remove member"
                  >
                    <FiTrash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>

        {/* Pending invites I've sent */}
        {sentInvites.length > 0 ? (
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-white/35">Pending invites</div>
            <div className="space-y-1.5">
              {sentInvites.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2 rounded-lg bg-black/15 px-2.5 py-2 text-sm">
                  <FiClock className="h-3.5 w-3.5 shrink-0 text-amber-300/70" />
                  <span className="min-w-0 flex-1 truncate text-white/70">{inv.email}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeInvite(inv.id)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-white/45 hover:bg-white/8 hover:text-white"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Shared libraries */}
      <section className="rounded-2xl surface-panel p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
          <FiShare2 className="h-4 w-4 text-violet-300" /> Shared libraries
          <span className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-white/50">{sharedLibs.length}</span>
        </h2>
        <p className="mb-3 text-[12px] text-white/45">
          Libraries shared here are usable by the whole team in Team chat. Only the owner can unshare.
        </p>

        {sharedLibs.length > 0 ? (
          <div className="mb-4 space-y-1.5">
            {sharedLibs.map((s) => (
              <div key={s.shareId} className="flex items-center gap-3 rounded-xl bg-black/15 px-3 py-2">
                <FiBox className="h-4 w-4 shrink-0 text-violet-300" />
                <span className="min-w-0 flex-1 truncate text-sm text-white/85">{s.name}</span>
                {s.ownerId === me?.id ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void unshareLib(s.shareId)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-white/45 hover:bg-white/8 hover:text-white"
                  >
                    Unshare
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-white/35">shared by teammate</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mb-4 rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-sm text-white/40">
            No libraries shared with this team yet.
          </div>
        )}

        {shareableLibs.length > 0 ? (
          <div className="border-t border-white/10 pt-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-white/35">Share one of your libraries</div>
            <div className="flex flex-wrap gap-2">
              {shareableLibs.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void shareLib(l.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/75 hover:border-violet-400/30 hover:text-white disabled:opacity-50"
                >
                  <FiShare2 className="h-3 w-3" /> {l.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
