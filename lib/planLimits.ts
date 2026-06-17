// Plan limits for the Usage dashboard. Synapse has no billing; "limits" here are
// soft usage allowances shown as progress bars. Tune these values freely — they are
// the single source of truth for what each plan allows.

export type Plan = "free" | "pro" | "enterprise";

export type PlanLimits = {
  label: string;
  /** cumulative resources */
  organizations: number;
  libraries: number;
  documents: number;
  storageBytes: number;
  /** per calendar month */
  monthlyQueries: number;
  monthlyAgentRuns: number;
  monthlyGraphs: number;
};

const GB = 1024 ** 3;

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    label: "Free",
    organizations: 1,
    libraries: 5,
    documents: 150,
    storageBytes: 1 * GB,
    monthlyQueries: 500,
    monthlyAgentRuns: 100,
    monthlyGraphs: 20,
  },
  pro: {
    label: "Pro",
    organizations: 10,
    libraries: 50,
    documents: 5_000,
    storageBytes: 50 * GB,
    monthlyQueries: 20_000,
    monthlyAgentRuns: 5_000,
    monthlyGraphs: 500,
  },
  enterprise: {
    label: "Enterprise",
    organizations: Infinity,
    libraries: Infinity,
    documents: Infinity,
    storageBytes: Infinity,
    monthlyQueries: Infinity,
    monthlyAgentRuns: Infinity,
    monthlyGraphs: Infinity,
  },
};

/** Resolve a plan string (case-insensitive) to its limits, defaulting to Free. */
export function planLimits(plan?: string | null): PlanLimits {
  const key = (plan || "free").toLowerCase();
  return PLAN_LIMITS[(key in PLAN_LIMITS ? key : "free") as Plan];
}
