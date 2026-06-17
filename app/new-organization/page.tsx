"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import GradientBackground from "@/components/GradientBackground";
import LimitReachedDialog, { type LimitInfo } from "@/components/LimitReachedDialog";
import { countOwnedOrgs, getUserOrgIds, getUserPlan } from "@/lib/usage";
import { planLimits } from "@/lib/planLimits";
import { FiChevronDown } from "react-icons/fi";

export default function NewOrganizationPage() {
    const router = useRouter();
    const supabase = createSupabaseBrowserClient();

    const [name, setName] = useState("");
    const [orgType, setOrgType] = useState("personal");
    const [plan, setPlan] = useState("free");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [limitInfo, setLimitInfo] = useState<LimitInfo | null>(null);
    const [limitPlanLabel, setLimitPlanLabel] = useState("Free");

    const handleCreate = async () => {
        if (!name.trim()) {
            setError("Organization name is required");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // Get current user
            const { data: { user }, error: userError } = await supabase.auth.getUser();

            if (userError || !user) {
                setError("You must be logged in to create an organization");
                setLoading(false);
                return;
            }

            // Enforce the per-user organization limit (free = 1).
            try {
                const orgIds = await getUserOrgIds(supabase);
                const [userPlan, owned] = await Promise.all([
                    getUserPlan(supabase, orgIds),
                    countOwnedOrgs(supabase),
                ]);
                const lim = planLimits(userPlan);
                if (Number.isFinite(lim.organizations) && owned >= lim.organizations) {
                    setLimitPlanLabel(lim.label);
                    setLimitInfo({
                        title: "Organization limit reached",
                        message: `Your ${lim.label} plan includes ${lim.organizations} organization${lim.organizations === 1 ? "" : "s"}. Delete one from Account preferences to make room, or upgrade for more.`,
                        used: owned,
                        limit: lim.organizations,
                        unit: "orgs",
                    });
                    setLoading(false);
                    return;
                }
            } catch {
                /* if the usage check fails, don't block creation */
            }

            // Generate slug from name
            const slug = name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "");

            // Insert organization
            const { data: org, error: orgError } = await supabase
                .from("organizations")
                .insert({
                    name: name.trim(),
                    slug: slug + "-" + Date.now().toString(36),
                    created_by_user_id: user.id,
                    plan: plan,
                    metadata: { type: orgType },
                })
                .select("id")
                .single();

            if (orgError) {
                console.error("Error creating organization:", orgError);
                setError(orgError.message);
                setLoading(false);
                return;
            }

            // Add user as owner/admin of the organization
            const { error: memberError } = await supabase
                .from("organization_members")
                .insert({
                    organization_id: org.id,
                    user_id: user.id,
                    role: "owner",
                });

            if (memberError) {
                console.error("Error adding membership:", memberError);
                setError(memberError.message);
                setLoading(false);
                return;
            }

            // Redirect to dashboard
            router.push("/dashboard");
        } catch (err) {
            console.error("Unexpected error:", err);
            setError("An unexpected error occurred");
            setLoading(false);
        }
    };

    return (
        <div className="relative min-h-screen flex flex-col overflow-hidden">
            <GradientBackground />
            <LimitReachedDialog
                info={limitInfo}
                planLabel={limitPlanLabel}
                onClose={() => setLimitInfo(null)}
                onManage={() => {
                    setLimitInfo(null);
                    router.push("/dashboard");
                }}
            />

            {/* Simple header */}
            <header className="w-full surface-app border-b border-white/10 flex items-center justify-between px-6 h-14 backdrop-blur-xl">
                <div className="flex items-center gap-2.5">
                    <Image src="/logo.png" alt="Synapse" width={28} height={28} className="h-7 w-7" />
                    <span className="text-white/25 font-light">/</span>
                    <span className="text-white/85 text-sm font-medium">New organization</span>
                </div>
            </header>

            {/* Main content */}
            <main className="flex-1 flex items-start justify-center pt-16 px-4">
                <div className="relative w-full max-w-xl">
                    <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-violet-600/20 via-fuchsia-500/12 to-blue-500/15 blur-2xl" />
                    <div className="relative w-full rounded-3xl glass-strong glass-hi p-8 shadow-2xl shadow-black/50">
                        <h1 className="text-2xl font-bold tracking-tight text-white">
                            Create a new <span className="gradient-text">organization</span>
                        </h1>
                        <p className="mt-2 text-sm text-white/55">
                            Organizations group your projects, team members, and billing.
                        </p>

                        {/* Form */}
                        <div className="mt-8 space-y-6">
                            {/* Name */}
                            <div>
                                <label className="block text-sm font-medium text-white/75 mb-2">Name</label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Organization name"
                                    className="w-full rounded-xl bg-white/5 border border-white/12 px-4 py-3 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                />
                                <p className="mt-1.5 text-xs text-white/40">
                                    The name of your company or team. You can change this later.
                                </p>
                            </div>

                            {/* Type */}
                            <div>
                                <label className="block text-sm font-medium text-white/75 mb-2">Type</label>
                                <div className="relative">
                                    <select
                                        value={orgType}
                                        onChange={(e) => setOrgType(e.target.value)}
                                        style={{ colorScheme: "dark" }}
                                        className="w-full rounded-xl bg-white/5 border border-white/12 px-4 py-3 text-sm text-white outline-none appearance-none cursor-pointer transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20"
                                    >
                                        <option value="personal" className="bg-[#13112a] text-white">Personal</option>
                                        <option value="team" className="bg-[#13112a] text-white">Team</option>
                                        <option value="enterprise" className="bg-[#13112a] text-white">Enterprise</option>
                                    </select>
                                    <FiChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                                </div>
                                <p className="mt-1.5 text-xs text-white/40">What best describes your organization?</p>
                            </div>

                            {/* Plan */}
                            <div>
                                <label className="block text-sm font-medium text-white/75 mb-2">Plan</label>
                                <div className="relative">
                                    <select
                                        value={plan}
                                        onChange={(e) => setPlan(e.target.value)}
                                        style={{ colorScheme: "dark" }}
                                        className="w-full rounded-xl bg-white/5 border border-white/12 px-4 py-3 text-sm text-white outline-none appearance-none cursor-pointer transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20"
                                    >
                                        <option value="free" className="bg-[#13112a] text-white">Free - $0/month</option>
                                        <option value="pro" className="bg-[#13112a] text-white">Pro - $20/month</option>
                                        <option value="enterprise" className="bg-[#13112a] text-white">Enterprise - Contact us</option>
                                    </select>
                                    <FiChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                                </div>
                                <p className="mt-1.5 text-xs text-white/40">
                                    Which plan fits best?{" "}
                                    <a href="#" className="text-violet-300 hover:underline">Learn more</a>.
                                </p>
                            </div>

                            {error && <p className="text-sm text-rose-400">{error}</p>}

                            {/* Buttons */}
                            <div className="flex items-center gap-3 pt-4">
                                <button
                                    onClick={() => router.back()}
                                    className="rounded-xl glass hover-glow px-5 py-2.5 text-sm font-medium text-white/80 transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleCreate}
                                    disabled={loading}
                                    className="btn-grad rounded-xl px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60"
                                >
                                    {loading ? "Creating..." : "Create organization"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
