import type { SupabaseClient } from "@supabase/supabase-js";

// Live usage lookups used to ENFORCE plan limits at the point of action (create library, add files,
// chat query, agent run). Limits are PER-USER: they pool across every organization the user belongs
// to, so a user can't reset their allowance by spinning up a new org.

function monthStartISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

/** Every organization id the current user belongs to (owner or member). Empty if signed out. */
export async function getUserOrgIds(supabase: SupabaseClient): Promise<string[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const uid = user?.id;
  if (!uid) return [];
  const { data } = await supabase.from("organization_members").select("organization_id").eq("user_id", uid);
  const ids = ((data as Array<{ organization_id: string | null }>) || [])
    .map((r) => r.organization_id)
    .filter(Boolean) as string[];
  return Array.from(new Set(ids));
}

/** Count of organizations the current user OWNS (role = owner). Used to enforce the org-per-user limit. */
export async function countOwnedOrgs(supabase: SupabaseClient): Promise<number> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const uid = user?.id;
  if (!uid) return 0;
  const { count } = await supabase
    .from("organization_members")
    .select("*", { count: "exact", head: true })
    .eq("user_id", uid)
    .eq("role", "owner");
  return count ?? 0;
}

// The query builder is fluent; type it loosely so optional `.eq`/`.gte` refinements compose cleanly.
type AnyQuery = {
  eq: (c: string, v: unknown) => AnyQuery;
  gte: (c: string, v: unknown) => AnyQuery;
  in: (c: string, v: unknown[]) => AnyQuery;
};

async function countRows(
  supabase: SupabaseClient,
  table: string,
  orgIds: string[],
  extra?: (q: AnyQuery) => AnyQuery,
): Promise<number> {
  if (!orgIds.length) return 0;
  let q = supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .in("organization_id", orgIds) as unknown as AnyQuery;
  if (extra) q = extra(q);
  const { count } = (await (q as unknown as Promise<{ count: number | null }>)) as { count: number | null };
  return count ?? 0;
}

export const countDocuments = (s: SupabaseClient, orgIds: string[]) => countRows(s, "documents", orgIds);
export const countLibraries = (s: SupabaseClient, orgIds: string[]) => countRows(s, "libraries", orgIds);

export const countMonthQueries = (s: SupabaseClient, orgIds: string[]) =>
  countRows(s, "chat_messages", orgIds, (q) => q.eq("role", "user").gte("created_at", monthStartISO()));

export const countMonthAgentRuns = (s: SupabaseClient, orgIds: string[]) =>
  countRows(s, "agent_runs", orgIds, (q) => q.gte("created_at", monthStartISO()));

export async function sumStorageBytes(s: SupabaseClient, orgIds: string[]): Promise<number> {
  if (!orgIds.length) return 0;
  const { data } = await s.from("documents").select("file_size_bytes").in("organization_id", orgIds);
  return ((data as Array<{ file_size_bytes: number | null }>) || []).reduce((n, d) => n + (d.file_size_bytes || 0), 0);
}

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, enterprise: 2 };

/** The user's effective plan = the highest plan across the orgs they belong to (defaults to free). */
export async function getUserPlan(s: SupabaseClient, orgIds: string[]): Promise<string> {
  if (!orgIds.length) return "free";
  const { data } = await s.from("organizations").select("plan").in("id", orgIds);
  const plans = ((data as Array<{ plan?: string }>) || []).map((r) => (r.plan || "free").toLowerCase());
  return plans.reduce((best, p) => ((PLAN_RANK[p] ?? 0) > (PLAN_RANK[best] ?? 0) ? p : best), "free");
}
