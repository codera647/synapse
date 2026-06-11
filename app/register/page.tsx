"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FcGoogle } from "react-icons/fc";
import { FiAlertCircle, FiCheckCircle, FiEye, FiEyeOff } from "react-icons/fi";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import GradientBackground from "@/components/GradientBackground";
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
        <main className="relative min-h-screen flex items-center justify-center px-4 py-16 overflow-hidden">
            <GradientBackground />
            <div className="relative w-full max-w-md">
                <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-violet-600/25 via-fuchsia-500/15 to-blue-500/20 blur-2xl" />

                <div className="relative rounded-3xl glass-strong glass-hi px-7 py-8 shadow-2xl shadow-black/50">
                    <Link href="/" className="flex items-center gap-2.5 mb-6">
                        <Image src="/logo.png" alt="Synapse" width={32} height={32} className="h-8 w-8" />
                        <span className="text-lg font-semibold tracking-tight text-white">Synapse</span>
                    </Link>

                    <h1 className="text-2xl font-bold tracking-tight text-white">Create your account</h1>
                    <p className="mt-1.5 text-sm text-white/55">
                        Spin up a workspace for your team&apos;s documents and data.
                    </p>

                    {successMsg && (
                        <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                            <FiCheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p>{successMsg}</p>
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={handleGoogleSignup}
                        disabled={isBusy}
                        className="mt-6 w-full flex items-center justify-center gap-2.5 rounded-xl glass hover-glow px-4 py-3 text-sm font-medium text-white/90 transition-all disabled:opacity-60"
                    >
                        <FcGoogle className="w-5 h-5" />
                        <span>{googleLoading ? "Opening Google..." : "Continue with Google"}</span>
                    </button>

                    <div className="mt-5 flex items-center gap-3 text-xs text-white/40">
                        <div className="flex-1 h-px bg-white/10" />
                        <span>or</span>
                        <div className="flex-1 h-px bg-white/10" />
                    </div>

                    <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
                        <div>
                            <label className="block text-xs font-medium text-white/70 mb-1.5">Full name</label>
                            <input
                                type="text"
                                required
                                className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                placeholder="Ayan Malik"
                                value={fullName}
                                onChange={(e) => setFullName(e.target.value)}
                                autoComplete="name"
                                disabled={isBusy}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-white/70 mb-1.5">Work email</label>
                            <input
                                type="email"
                                required
                                className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                placeholder="you@org.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="email"
                                disabled={isBusy}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-white/70 mb-1.5">Password</label>
                            <div className="relative">
                                <input
                                    type={showPassword ? "text" : "password"}
                                    required
                                    className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 pr-10 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    autoComplete="new-password"
                                    disabled={isBusy}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword((value) => !value)}
                                    className="absolute inset-y-0 right-3 text-white/40 hover:text-white transition-colors"
                                    aria-label={showPassword ? "Hide password" : "Show password"}
                                >
                                    {showPassword ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-white/70 mb-1.5">Confirm password</label>
                            <div className="relative">
                                <input
                                    type={showConfirmPassword ? "text" : "password"}
                                    required
                                    className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 pr-10 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                    placeholder="••••••••"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    autoComplete="new-password"
                                    disabled={isBusy}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowConfirmPassword((value) => !value)}
                                    className="absolute inset-y-0 right-3 text-white/40 hover:text-white transition-colors"
                                    aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                                >
                                    {showConfirmPassword ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>

                        {errorMsg && (
                            <div className="flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                                <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{errorMsg}</p>
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={isBusy}
                            className="btn-grad mt-2 w-full rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
                        >
                            {emailLoading ? "Creating..." : "Create workspace"}
                        </button>
                    </form>

                    <p className="mt-5 text-sm text-white/55 text-center">
                        Already have an account?{" "}
                        <Link href="/login" className="text-violet-300 hover:text-violet-200 font-medium transition-colors">
                            Sign in
                        </Link>
                    </p>
                </div>
            </div>
        </main>
    );
}
