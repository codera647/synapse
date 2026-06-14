import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

// POST /api/team/accept  { token, action?: "accept" | "decline" }   (Authorization: Bearer ...)
// Accepts (adds caller to the org) or declines a pending invitation. Runs server-side with the
// admin client because the invitee isn't yet a member, so RLS would block a client-side update.
// Used by the email accept-link page and the in-app Accept/Decline buttons.

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing access token." }, { status: 401 });
  }
  const accessToken = auth.slice("Bearer ".length).trim();
  const admin = createSupabaseAdminClient();

  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(accessToken);
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { token?: string; action?: string };
  const inviteToken = String(body.token || "").trim();
  const action = String(body.action || "accept").toLowerCase() === "decline" ? "decline" : "accept";
  if (!inviteToken) {
    return NextResponse.json({ error: "Missing invitation token." }, { status: 400 });
  }

  const { data: inv } = await admin
    .from("organization_invitations")
    .select("id, organization_id, email, role, status, expires_at")
    .eq("token", inviteToken)
    .maybeSingle();

  if (!inv) {
    return NextResponse.json({ error: "This invitation is invalid." }, { status: 404 });
  }
  if (inv.status !== "pending") {
    return NextResponse.json({ error: "This invitation is no longer active." }, { status: 410 });
  }
  if (inv.expires_at && new Date(String(inv.expires_at)).getTime() < Date.now()) {
    return NextResponse.json({ error: "This invitation has expired." }, { status: 410 });
  }
  // Only the invited email may respond.
  if ((user.email || "").toLowerCase() !== String(inv.email || "").toLowerCase()) {
    return NextResponse.json(
      { error: `This invitation was sent to ${inv.email}. Sign in with that email to accept.` },
      { status: 403 },
    );
  }

  if (action === "decline") {
    await admin.from("organization_invitations").update({ status: "revoked" }).eq("id", inv.id);
    return NextResponse.json({ ok: true, declined: true });
  }

  // Add membership (ignore if already a member).
  const { error: memErr } = await admin.from("organization_members").insert({
    organization_id: inv.organization_id,
    user_id: user.id,
    role: inv.role || "member",
  });
  if (memErr && !String(memErr.message || "").toLowerCase().includes("duplicate")) {
    console.error("accept invite membership error:", memErr);
    return NextResponse.json({ error: "Couldn't join the team." }, { status: 500 });
  }

  await admin
    .from("organization_invitations")
    .update({ status: "accepted", accepted_by_user_id: user.id, accepted_at: new Date().toISOString() })
    .eq("id", inv.id);

  return NextResponse.json({ ok: true, organization_id: inv.organization_id });
}
