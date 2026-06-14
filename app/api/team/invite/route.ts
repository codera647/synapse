import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

// POST /api/team/invite  { organization_id, email }   (Authorization: Bearer <supabase token>)
// Creates a pending invitation (server-side, server-generated token) and emails the invitee via
// Cloudflare Email Service. Email is best-effort: if no sending domain is configured the invite
// still exists in-app (the invitee sees it in the Team screen on login).

function emailHtml(inviterName: string, orgName: string, acceptUrl: string) {
  return `<!doctype html><html><body style="margin:0;background:#0b0a14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e9e7f5;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="font-size:20px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#e879f9);-webkit-background-clip:text;background-clip:text;color:transparent;">Synapse</div>
    <h1 style="font-size:20px;margin:24px 0 8px;color:#fff;">${inviterName} invited you to <span style="color:#c4b5fd;">${orgName}</span></h1>
    <p style="font-size:14px;line-height:1.6;color:#b9b4d0;margin:0 0 24px;">
      Join the team to chat over shared document libraries together on Synapse.
    </p>
    <a href="${acceptUrl}" style="display:inline-block;background:linear-gradient(90deg,#8b5cf6,#d946ef);color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:10px;">Accept invitation</a>
    <p style="font-size:12px;color:#7c768f;margin:24px 0 0;">Or paste this link into your browser:<br/><a href="${acceptUrl}" style="color:#a78bfa;word-break:break-all;">${acceptUrl}</a></p>
    <p style="font-size:11px;color:#5c5670;margin:24px 0 0;">If you didn't expect this, you can ignore this email. The invitation expires in 14 days.</p>
  </div></body></html>`;
}

function emailText(inviterName: string, orgName: string, acceptUrl: string) {
  return `${inviterName} invited you to join ${orgName} on Synapse.\n\nAccept the invitation:\n${acceptUrl}\n\nIf you didn't expect this, you can ignore this email. The invitation expires in 14 days.`;
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing access token." }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  const admin = createSupabaseAdminClient();

  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { organization_id?: string; email?: string };
  const orgId = String(body.organization_id || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  if (!orgId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "organization_id and a valid email are required." }, { status: 400 });
  }

  // The inviter must be a member of the team.
  const { data: mem } = await admin
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!mem) {
    return NextResponse.json({ error: "You are not a member of this team." }, { status: 403 });
  }

  // Already a member?
  const { data: existingUser } = await admin.from("users").select("id").eq("email", email).maybeSingle();
  if (existingUser) {
    const { data: existingMem } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgId)
      .eq("user_id", existingUser.id)
      .maybeSingle();
    if (existingMem) {
      return NextResponse.json({ error: "That person is already a member." }, { status: 409 });
    }
  }

  // Inviter + org details for the email.
  const [{ data: org }, { data: inviter }] = await Promise.all([
    admin.from("organizations").select("name").eq("id", orgId).maybeSingle(),
    admin.from("users").select("name, email").eq("id", user.id).maybeSingle(),
  ]);
  const orgName = (org?.name as string) || "a team";
  const inviterEmail = (inviter?.email as string) || user.email || "";
  const inviterName = (inviter?.name as string) || inviterEmail || "A teammate";

  // Create (or reuse) the pending invitation. A unique index allows one pending invite per (org,email).
  const newToken = crypto.randomUUID();
  let inviteToken: string | null = null;
  const { data: inv, error: invErr } = await admin
    .from("organization_invitations")
    .insert({ organization_id: orgId, email, invited_by_user_id: user.id, role: "member", token: newToken, status: "pending" })
    .select("token")
    .single();
  if (!invErr && inv?.token) {
    inviteToken = String(inv.token);
  } else {
    const { data: existingInv } = await admin
      .from("organization_invitations")
      .select("token")
      .eq("organization_id", orgId)
      .eq("email", email)
      .eq("status", "pending")
      .maybeSingle();
    inviteToken = existingInv?.token ? String(existingInv.token) : null;
  }
  if (!inviteToken) {
    return NextResponse.json({ error: "Couldn't create the invitation." }, { status: 500 });
  }

  // Send the email (best-effort).
  let emailed = false;
  try {
    const fromAddr = (process.env.TEAM_INVITE_FROM || "").trim();
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = getCloudflareContext();
    const EMAIL = (ctx?.env as unknown as { EMAIL?: { send: (m: unknown) => Promise<unknown> } })?.EMAIL;
    if (EMAIL && fromAddr) {
      const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
      const acceptUrl = `${origin}/team/accept?token=${encodeURIComponent(inviteToken)}`;
      await EMAIL.send({
        to: email,
        from: { email: fromAddr, name: "Synapse" },
        replyTo: inviterEmail || undefined,
        subject: `${inviterName} invited you to ${orgName} on Synapse`,
        html: emailHtml(inviterName, orgName, acceptUrl),
        text: emailText(inviterName, orgName, acceptUrl),
      });
      emailed = true;
    }
  } catch (err) {
    console.error("team invite email failed:", err);
  }

  return NextResponse.json({ ok: true, emailed });
}
