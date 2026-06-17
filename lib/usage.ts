import type { SupabaseClient } from "@supabase/supabase-js";

// Live usage lookups used to ENFORCE plan limits at the point of action (create library, add files,
// chat query, agent run). Cheap count queries scoped to the organization.

function monthStartISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// The query builder is fluent; type it loosely so optional `.eq`/`.gte` refinements compose cleanly.
type AnyQuery = { eq: (c: string, v: unknown) => AnyQuery; gte: (c: string, v: unknown) => AnyQuery };

async function countRows(
  supabase: SupabaseClient,
  table: string,
  orgId: string,
  extra?: (q: AnyQuery) => AnyQuery,
): Promise<number> {
  let q = supabase.from(table).select("*", { count: "exact", head: true }).eq("organization_id", orgId) as unknown as AnyQuery;
  if (extra) q = extra(q);
  const { count } = (await (q as unknown as Promise<{ count: number | null }>)) as { count: number | null };
  return count ?? 0;
}

export const countDocuments = (s: SupabaseClient, orgId: string) => countRows(s, "documents", orgId);
export const countLibraries = (s: SupabaseClient, orgId: string) => countRows(s, "libraries", orgId);

export const countMonthQueries = (s: SupabaseClient, orgId: string) =>
  countRows(s, "chat_messages", orgId, (q) => q.eq("role", "user").gte("created_at", monthStartISO()));

export const countMonthAgentRuns = (s: SupabaseClient, orgId: string) =>
  countRows(s, "agent_runs", orgId, (q) => q.gte("created_at", monthStartISO()));

export async function sumStorageBytes(s: SupabaseClient, orgId: string): Promise<number> {
  const { data } = await s.from("documents").select("file_size_bytes").eq("organization_id", orgId);
  return ((data as Array<{ file_size_bytes: number | null }>) || []).reduce((n, d) => n + (d.file_size_bytes || 0), 0);
}

/** Resolve the current org's plan from `organizations.plan` (defaults to "free"). */
export async function getOrgPlan(s: SupabaseClient, orgId: string): Promise<string> {
  const rows = (await s.from("organizations").select("plan").eq("id", orgId).limit(1)).data as Array<{ plan?: string }> | null;
  return (rows && rows[0]?.plan) || "free";
}
