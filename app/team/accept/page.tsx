"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";

function AcceptInvite() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("Accepting your invitation…");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setMessage("This invitation link is invalid.");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          // Not signed in — keep the token so we can finish after login, and send them to sign in.
          try {
            sessionStorage.setItem("pending_invite_token", token);
          } catch {
            /* ignore */
          }
          router.replace("/login");
          return;
        }
        const res = await fetch("/api/team/accept", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ token }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!alive) return;
        if (res.ok) {
          setStatus("ok");
          setMessage("You're in! Taking you to your team…");
          setTimeout(() => router.replace("/dashboard?tab=team"), 1000);
        } else {
          setStatus("error");
          setMessage(String(j?.error || "Couldn't accept this invitation."));
        }
      } catch {
        if (alive) {
          setStatus("error");
          setMessage("Something went wrong. Please try again.");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [params, router]);

  return (
    <div className="grid min-h-screen place-items-center px-6 text-center">
      <div className="w-full max-w-sm rounded-2xl surface-panel p-8">
        {status === "working" ? (
          <span className="mx-auto mb-4 block h-7 w-7 animate-spin rounded-full border-2 border-violet-300/40 border-t-violet-300" />
        ) : status === "ok" ? (
          <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">✓</div>
        ) : (
          <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-full bg-rose-500/15 text-rose-300">!</div>
        )}
        <div className="text-sm text-white/80">{message}</div>
        {status === "error" ? (
          <button
            type="button"
            onClick={() => router.replace("/dashboard?tab=team")}
            className="mt-4 inline-flex rounded-lg btn-grad px-4 py-2 text-xs font-medium text-white"
          >
            Go to Team
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-sm text-white/50">Loading…</div>}>
      <AcceptInvite />
    </Suspense>
  );
}
