"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FcGoogle } from "react-icons/fc";
import { FiAlertCircle, FiCheckCircle, FiEye, FiEyeOff } from "react-icons/fi";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import {
    getAuthRedirectUrl,
    getFriendlyAuthError,
    resolvePostAuthRedirect,
} from "@/lib/auth";

export default function RegisterPage() {
    const router = useRouter();
    const supabase = createSupabaseBrowserClient();

    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [emailLoading, setEmailLoading] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    useEffect(() => {
        const routeAuthenticatedUsers = async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();

            if (!session) {
                return;
            }

            try {
                const destination = await resolvePostAuthRedirect(supabase);
                router.replace(destination);
            } catch {
                await supabase.auth.signOut();
            }
        };

        void routeAuthenticatedUsers();
    }, [router, supabase]);

    const handleGoogleSignup = async () => {
        setErrorMsg(null);
        setSuccessMsg(null);
        setGoogleLoading(true);

        const { error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: getAuthRedirectUrl("/auth/callback"),
            },
        });

        if (error) {
            setErrorMsg(getFriendlyAuthError(error.message));
            setGoogleLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrorMsg(null);
        setSuccessMsg(null);
        setEmailLoading(true);

        const cleanName = fullName.trim();
        const cleanEmail = email.trim().toLowerCase();

        try {
            if (!cleanName || !cleanEmail || !password) {
                throw new Error("Please fill all fields.");
            }

            if (password !== confirmPassword) {
                throw new Error("Passwords do not match.");
            }

            if (password.length < 6) {
                throw new Error("Password must be at least 6 characters.");
            }

            const { data, error } = await supabase.auth.signUp({
                email: cleanEmail,
                password,
                options: {
                    data: {
                        full_name: cleanName,
                    },
                    emailRedirectTo: getAuthRedirectUrl("/auth/callback"),
                },
            });

            if (error) {
                throw error;
            }

            if (data.session) {
                const destination = await resolvePostAuthRedirect(supabase);
                router.replace(destination);
                return;
            }

            setSuccessMsg("Account created. Check your email to confirm your address.");
            router.push(`/login?checkEmail=1&email=${encodeURIComponent(cleanEmail)}`);
        } catch (error) {
            setErrorMsg(
                getFriendlyAuthError(
                    error instanceof Error ? error.message : "Unable to create your account."
                )
            );
        } finally {
            setEmailLoading(false);
        }
    };

    const isBusy = emailLoading || googleLoading;

    return (
        <main
            className="min-h-screen flex items-start justify-center px-4 pt-16"
            style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
        >
            <div className="relative w-full max-w-md">
                <div className="pointer-events-none absolute -inset-24 -z-10 opacity-40">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(136,74,180,0.25),_transparent_60%)]" />
                </div>

                <div
                    className="rounded-3xl px-6 py-8 shadow-lg backdrop-blur-xl"
                    style={{
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border-color-subtle)",
                    }}
                >
                    <div className="flex items-center gap-2 mb-4">
                        <Image
                            src="/logo.png"
                            alt="Synapse Logo"
                            width={32}
                            height={32}
                            className="h-8 w-8"
                        />
                        <span className="font-semibold tracking-wide text-gray-200">
                            Synapse
                        </span>
                    </div>

                    <h1 className="text-xl font-semibold">Create your Synapse account</h1>
                    <p className="mt-1 text-sm text-gray-400">
                        Spin up a workspace for your team&apos;s documents and data.
                    </p>

                    {successMsg && (
                        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                            <FiCheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p>{successMsg}</p>
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={handleGoogleSignup}
                        disabled={isBusy}
                        className="mt-6 w-full flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-[var(--bg-primary)] px-4 py-2.5 text-sm font-medium text-gray-100 hover:border-[#b87fd9] hover:text-white transition-all duration-200 disabled:opacity-60"
                    >
                        <FcGoogle className="w-5 h-5" />
                        <span>{googleLoading ? "Opening Google..." : "Continue with Google"}</span>
                    </button>

                    <div className="mt-5 flex items-center gap-3 text-xs text-gray-500">
                        <div className="flex-1 h-px bg-white/10" />
                        <span>or</span>
                        <div className="flex-1 h-px bg-white/10" />
                    </div>

                    <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
                        <div>
                            <label className="block text-xs font-medium text-gray-300 mb-1">
                                Full name
                            </label>
                            <input
                                type="text"
                                required
                                className="w-full rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[#b87fd9]"
                                style={{
                                    backgroundColor: "var(--bg-primary)",
                                    border: "1px solid var(--border-color-subtle)",
                                    color: "var(--text-primary)",
                                }}
                                placeholder="Ayan Malik"
                                value={fullName}
                                onChange={(e) => setFullName(e.target.value)}
                                autoComplete="name"
                                disabled={isBusy}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-gray-300 mb-1">
                                Work email
                            </label>
                            <input
                                type="email"
                                required
                                className="w-full rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[#b87fd9]"
                                style={{
                                    backgroundColor: "var(--bg-primary)",
                                    border: "1px solid var(--border-color-subtle)",
                                    color: "var(--text-primary)",
                                }}
                                placeholder="you@org.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="email"
                                disabled={isBusy}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-gray-300 mb-1">
                                Password
                            </label>
                            <div className="relative">
                                <input
                                    type={showPassword ? "text" : "password"}
                                    required
                                    className="w-full rounded-xl px-3 py-2 pr-10 text-sm outline-none focus:ring-1 focus:ring-[#b87fd9]"
                                    style={{
                                        backgroundColor: "var(--bg-primary)",
                                        border: "1px solid var(--border-color-subtle)",
                                        color: "var(--text-primary)",
                                    }}
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    autoComplete="new-password"
                                    disabled={isBusy}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword((value) => !value)}
                                    className="absolute inset-y-0 right-3 text-gray-400 hover:text-white"
                                    aria-label={showPassword ? "Hide password" : "Show password"}
                                >
                                    {showPassword ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-gray-300 mb-1">
                                Confirm password
                            </label>
                            <div className="relative">
                                <input
                                    type={showConfirmPassword ? "text" : "password"}
                                    required
                                    className="w-full rounded-xl px-3 py-2 pr-10 text-sm outline-none focus:ring-1 focus:ring-[#b87fd9]"
                                    style={{
                                        backgroundColor: "var(--bg-primary)",
                                        border: "1px solid var(--border-color-subtle)",
                                        color: "var(--text-primary)",
                                    }}
                                    placeholder="••••••••"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    autoComplete="new-password"
                                    disabled={isBusy}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowConfirmPassword((value) => !value)}
                                    className="absolute inset-y-0 right-3 text-gray-400 hover:text-white"
                                    aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                                >
                                    {showConfirmPassword ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>

                        {errorMsg && (
                            <div className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-300">
                                <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{errorMsg}</p>
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={isBusy}
                            className="mt-2 w-full rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg transition-all duration-200 disabled:opacity-60"
                            style={{
                                background: "linear-gradient(135deg, #884ab4, #b87fd9)",
                                boxShadow: "0 10px 30px rgba(136,74,180,0.45)",
                            }}
                        >
                            {emailLoading ? "Creating..." : "Create workspace"}
                        </button>
                    </form>

                    <p className="mt-4 text-xs text-gray-400">
                        Already have an account?{" "}
                        <Link
                            href="/login"
                            className="text-[#d4a5e9] hover:text-[#b87fd9] font-medium"
                        >
                            Sign in
                        </Link>
                    </p>
                </div>
            </div>
        </main>
    );
}
