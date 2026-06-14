import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

// GET /api/team/members?org=<id>   (Authorization: Bearer <access_token>)
// Returns the org's members with their profile (name, email, avatar_url), resolved with the
// service role so it works regardless of users-table RLS, and falls back to auth.users for email
// when public.users is sparse. The caller must be a member of the org.

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing access token." }, { status: 401 });
  }
  const admin = createSupabaseAdminClient();
  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(auth.slice("Bearer ".length).trim());
  if (authError || !user) {
    return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
  }

  const orgId = new URL(req.url).searchParams.get("org");
  if (!orgId) return NextResponse.json({ error: "Missing org." }, { status: 400 });

  // Authorize: the caller must belong to this org.
  const { data: self } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!self) return NextResponse.json({ error: "Not a member of this team." }, { status: 403 });

  const { data: rows } = await admin
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", orgId);
  const memberRows = (rows as Array<{ user_id: string; role: string }>) || [];
  const ids = memberRows.map((r) => String(r.user_id));

  // Profiles from public.users (service role bypasses RLS).
  const profiles: Record<string, { name: string | null; email: string | null; avatar_url: string | null }> = {};
  if (ids.length) {
    const { data: us } = await admin.from("users").select("id, name, email, avatar_url").in("id", ids);
    ((us as Array<Record<string, unknown>>) || []).forEach((u) => {
      profiles[String(u.id)] = {
        name: (u.name as string | null) ?? null,
        email: (u.email as string | null) ?? null,
        avatar_url: (u.avatar_url as string | null) ?? null,
      };
    });
  }

  // Fall back to auth.users for anyone missing an email or name.
  await Promise.all(
    ids.map(async (id) => {
      const p = profiles[id];
      if (p?.email && p?.name) return;
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        const au = data?.user;
        if (!au) return;
        const meta = (au.user_metadata || {}) as Record<string, unknown>;
        profiles[id] = {
          name: p?.name || (meta.full_name as string) || (meta.name as string) || null,
          email: p?.email || au.email || null,
          avatar_url: p?.avatar_url || (meta.avatar_url as string) || null,
        };
      } catch {
        /* ignore */
      }
    }),
  );

  const members = memberRows.map((r) => {
    const p = profiles[String(r.user_id)] || { name: null, email: null, avatar_url: null };
    return {
      userId: String(r.user_id),
      role: String(r.role || "member"),
      name: p.name,
      email: p.email || "",
      avatarUrl: p.avatar_url,
    };
  });

  return NextResponse.json({ members });
}
