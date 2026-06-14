import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

// POST /api/user/preferences   (Authorization: Bearer <access_token>)
// Body: { name?: string | null, avatar_url?: string | null, prefs?: {...} }
// Saves the caller's profile (name, avatar_url on public.users) + personalization
// (public.user_preferences). Runs server-side with the admin client so the write never
// depends on browser-side RLS for these tables; the user_id is taken from the verified
// token, never from the client body.

const PREF_KEYS = [
  "nickname",
  "occupation",
  "about_me",
  "base_tone",
  "char_warmth",
  "char_enthusiasm",
  "char_headers_lists",
  "char_emoji",
] as const;

async function verify(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return { error: "Missing access token.", status: 401 as const };
  const admin = createSupabaseAdminClient();
  const {
    data: { user },
    error,
  } = await admin.auth.getUser(auth.slice("Bearer ".length).trim());
  if (error || !user) return { error: "Invalid or expired session.", status: 401 as const };
  return { admin, user };
}

// GET — return the caller's profile + personalization (admin client, no RLS dependency).
export async function GET(req: Request) {
  const v = await verify(req);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: v.status });
  const { admin, user } = v;
  const [{ data: profile }, { data: prefs }] = await Promise.all([
    admin.from("users").select("name, avatar_url").eq("id", user.id).maybeSingle(),
    admin.from("user_preferences").select("*").eq("user_id", user.id).maybeSingle(),
  ]);
  return NextResponse.json({
    user_id: user.id,
    email: user.email ?? null,
    name: profile?.name ?? null,
    avatar_url: profile?.avatar_url ?? null,
    prefs: prefs ?? null,
  });
}

export async function POST(req: Request) {
  const v = await verify(req);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: v.status });
  const { admin, user } = v;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string | null;
    avatar_url?: string | null;
    prefs?: Record<string, unknown>;
  };

  // Profile fields on public.users.
  const profileUpdate: Record<string, unknown> = {};
  if (body.name !== undefined) profileUpdate.name = body.name ? String(body.name).slice(0, 200) : null;
  if (body.avatar_url !== undefined)
    profileUpdate.avatar_url = body.avatar_url ? String(body.avatar_url).slice(0, 1000) : null;

  // Personalization row (whitelist keys; user_id from the verified token).
  const prefRow: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  const src = body.prefs || {};
  for (const k of PREF_KEYS) {
    if (src[k] !== undefined) prefRow[k] = src[k] === null ? null : String(src[k]).slice(0, 2000);
  }

  const [{ error: uErr }, { error: pErr }] = await Promise.all([
    Object.keys(profileUpdate).length
      ? admin.from("users").update(profileUpdate).eq("id", user.id)
      : Promise.resolve({ error: null }),
    admin.from("user_preferences").upsert(prefRow, { onConflict: "user_id" }),
  ]);

  if (uErr || pErr) {
    console.error("save preferences error:", uErr || pErr);
    return NextResponse.json({ error: "Couldn't save your settings." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
