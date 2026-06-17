"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FiBell, FiUserPlus, FiCheck, FiInbox } from "react-icons/fi";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";

type NotifKind = "invite_received" | "invite_accepted";
type Notif = {
  id: string;
  kind: NotifKind;
  title: string;
  body: string;
  ts: string; // ISO
  orgId: string;
};

function orgName(o: unknown): string {
  const x = Array.isArray(o) ? o[0] : o;
  const name = (x as { name?: string } | null)?.name;
  return name || "a team";
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function NotificationsBell() {
  const router = useRouter();
  const supabase = useRef(createSupabaseBrowserClient()).current;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const uidRef = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The "last seen" value captured at the moment the panel opened — drives per-row highlight
  // so freshly-read items still look new for this viewing while the badge clears.
  const openSnapshot = useRef<string | null>(null);

  const seenKey = (uid: string) => `synapse:notifs:seen:${uid}`;

  const load = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const uid = user?.id ?? null;
      const email = (user?.email ?? "").toLowerCase();
      uidRef.current = uid;
      if (!uid) {
        setNotifs([]);
        setLoading(false);
        return;
      }

      if (typeof window !== "undefined") {
        setSeenAt(window.localStorage.getItem(seenKey(uid)));
      }

      const [recvR, accR] = await Promise.all([
        // Invitations addressed to me, still pending.
        email
          ? supabase
              .from("organization_invitations")
              .select("id, organization_id, created_at, organizations(name)")
              .eq("email", email)
              .eq("status", "pending")
          : Promise.resolve({ data: [], error: null }),
        // Invitations I sent that someone accepted.
        supabase
          .from("organization_invitations")
          .select("id, organization_id, email, accepted_at, organizations(name)")
          .eq("invited_by_user_id", uid)
          .eq("status", "accepted")
          .not("accepted_at", "is", null)
          .order("accepted_at", { ascending: false })
          .limit(30),
      ]);

      const received: Notif[] = ((recvR.data as Array<Record<string, unknown>>) || []).map((r) => ({
        id: `recv-${String(r.id)}`,
        kind: "invite_received",
        title: "Team invitation",
        body: `You've been invited to join ${orgName(r.organizations)}.`,
        ts: String(r.created_at || new Date().toISOString()),
        orgId: String(r.organization_id),
      }));

      const accepted: Notif[] = ((accR.data as Array<Record<string, unknown>>) || []).map((r) => ({
        id: `acc-${String(r.id)}`,
        kind: "invite_accepted",
        title: "Invitation accepted",
        body: `${String(r.email || "A teammate")} joined ${orgName(r.organizations)}.`,
        ts: String(r.accepted_at || new Date().toISOString()),
        orgId: String(r.organization_id),
      }));

      const merged = [...received, ...accepted].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 40);
      setNotifs(merged);
    } catch {
      /* non-fatal — leave whatever we had */
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  // Initial load + light polling + refresh on focus.
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 45000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Click outside closes.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const unread = notifs.filter((n) => !seenAt || n.ts > seenAt).length;

  const markAllRead = useCallback(() => {
    const uid = uidRef.current;
    const now = new Date().toISOString();
    if (uid && typeof window !== "undefined") window.localStorage.setItem(seenKey(uid), now);
    setSeenAt(now);
  }, []);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next) {
        openSnapshot.current = seenAt; // remember what was unread for highlight
        void load();
        // Clear the badge shortly after opening (lets the unread highlight register first).
        setTimeout(markAllRead, 400);
      }
      return next;
    });
  };

  const onRowClick = () => {
    setOpen(false);
    router.push("/dashboard?tab=team");
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={toggle}
        aria-label="Notifications"
        className="relative grid h-9 w-9 place-items-center rounded-lg text-white/50 transition-colors hover:bg-white/8 hover:text-white"
      >
        <FiBell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-gradient-to-br from-rose-500 to-fuchsia-500 px-1 text-[9px] font-bold text-white ring-2 ring-[#0b0e16]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl surface-menu z-[60] animate-[scaleIn_.14s_ease-out]">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <span className="text-sm font-semibold text-white/90">Notifications</span>
            {notifs.length > 0 && unread > 0 ? (
              <button onClick={markAllRead} className="text-[11px] font-medium text-violet-300 transition-colors hover:text-violet-200">
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="synapse-scroll max-h-[22rem] overflow-auto">
            {loading && notifs.length === 0 ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-white/8" />
                    <div className="flex-1 space-y-1.5 py-0.5">
                      <div className="h-3 w-3/4 animate-pulse rounded bg-white/8" />
                      <div className="h-2.5 w-1/2 animate-pulse rounded bg-white/8" />
                    </div>
                  </div>
                ))}
              </div>
            ) : notifs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-white/5 text-white/30">
                  <FiInbox className="h-5 w-5" />
                </span>
                <p className="text-sm font-medium text-white/70">You&apos;re all caught up</p>
                <p className="text-xs text-white/40">Invitations and team activity will show up here.</p>
              </div>
            ) : (
              notifs.map((n) => {
                const isUnread = openSnapshot.current ? n.ts > openSnapshot.current : true;
                const accepted = n.kind === "invite_accepted";
                return (
                  <button
                    key={n.id}
                    onClick={onRowClick}
                    className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 ${
                      isUnread ? "bg-violet-500/[0.07]" : ""
                    }`}
                  >
                    <span
                      className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white shadow-lg ${
                        accepted
                          ? "bg-gradient-to-br from-emerald-500 to-teal-500 shadow-emerald-500/25"
                          : "bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-violet-500/25"
                      }`}
                    >
                      {accepted ? <FiCheck className="h-4 w-4" /> : <FiUserPlus className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white/90">{n.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-white/55">{n.body}</p>
                      <p className="mt-1 text-[10px] text-white/35">{timeAgo(n.ts)}</p>
                    </div>
                    {isUnread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-violet-400" />}
                  </button>
                );
              })
            )}
          </div>

          {notifs.some((n) => n.kind === "invite_received") ? (
            <div className="border-t border-white/10 p-1.5">
              <button
                onClick={() => {
                  setOpen(false);
                  router.push("/dashboard?tab=team");
                }}
                className="w-full rounded-lg px-3 py-2 text-center text-xs font-medium text-white/80 transition-colors hover:bg-white/8"
              >
                Review invitations
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
