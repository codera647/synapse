"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import { FiChevronDown } from "react-icons/fi";

export default function NewOrganizationPage() {
    const router = useRouter();
    const supabase = createSupabaseBrowserClient();

    const [name, setName] = useState("");
    const [orgType, setOrgType] = useState("personal");
    const [plan, setPlan] = useState("free");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
        <div
            className="min-h-screen flex flex-col"
            style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
        >
            {/* Simple header */}
            <header
                className="w-full border-b border-white/10 flex items-center justify-between px-6 h-14"
                style={{ backgroundColor: "var(--bg-secondary)" }}
            >
                <div className="flex items-center gap-2">
                    <Image
                        src="/logo.png"
                        alt="Synapse logo"
                        width={28}
                        height={28}
                        className="rounded-md"
                    />
                    <span className="text-gray-400 mx-2">/</span>
                    <span className="text-gray-100 text-sm font-medium">New organization</span>
                </div>
            </header>

            {/* Main content */}
            <main className="flex-1 flex items-start justify-center pt-16 px-4">
                <div
                    className="w-full max-w-xl rounded-2xl p-8"
                    style={{
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border-color-subtle)",
                    }}
                >
                    <h1 className="text-xl font-semibold text-gray-100">
                        Create a new organization
                    </h1>
                    <p className="mt-2 text-sm text-gray-400">
                        Organizations are a way to group your projects. Each organization can be
                        configured with different team members and billing settings.
                    </p>

                    {/* Form */}
                    <div className="mt-8 space-y-6">
                        {/* Name */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Name
                            </label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Organization name"
                                className="w-full rounded-lg px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-[#b87fd9]"
                                style={{
                                    backgroundColor: "var(--bg-primary)",
                                    border: "1px solid var(--border-color-subtle)",
                                    color: "var(--text-primary)",
                                }}
                            />
                            <p className="mt-1.5 text-xs text-gray-500">
                                What's the name of your company or team? You can change this later.
                            </p>
                        </div>

                        {/* Type */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Type
                            </label>
                            <div className="relative">
                                <select
                                    value={orgType}
                                    onChange={(e) => setOrgType(e.target.value)}
                                    className="w-full rounded-lg px-4 py-3 text-sm outline-none appearance-none cursor-pointer focus:ring-1 focus:ring-[#b87fd9]"
                                    style={{
                                        backgroundColor: "var(--bg-primary)",
                                        border: "1px solid var(--border-color-subtle)",
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <option value="personal">Personal</option>
                                    <option value="team">Team</option>
                                    <option value="enterprise">Enterprise</option>
                                </select>
                                <FiChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500">
                                What best describes your organization?
                            </p>
                        </div>

                        {/* Plan */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Plan
                            </label>
                            <div className="relative">
                                <select
                                    value={plan}
                                    onChange={(e) => setPlan(e.target.value)}
                                    className="w-full rounded-lg px-4 py-3 text-sm outline-none appearance-none cursor-pointer focus:ring-1 focus:ring-[#b87fd9]"
                                    style={{
                                        backgroundColor: "var(--bg-primary)",
                                        border: "1px solid var(--border-color-subtle)",
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <option value="free">Free - $0/month</option>
                                    <option value="pro">Pro - $20/month</option>
                                    <option value="enterprise">Enterprise - Contact us</option>
                                </select>
                                <FiChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500">
                                Which plan fits your organization's needs best?{" "}
                                <a href="#" className="text-[#b87fd9] hover:underline">
                                    Learn more
                                </a>
                                .
                            </p>
                        </div>

                        {/* Error message */}
                        {error && (
                            <p className="text-sm text-red-400">{error}</p>
                        )}

                        {/* Buttons */}
                        <div className="flex items-center gap-3 pt-4">
                            <button
                                onClick={() => router.back()}
                                className="rounded-lg border border-white/20 bg-transparent px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreate}
                                disabled={loading}
                                className="rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] px-4 py-2 text-sm font-medium text-white shadow-md transition-all disabled:opacity-60"
                            >
                                {loading ? "Creating..." : "Create organization"}
                            </button>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
