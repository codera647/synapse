"use client";

import Link from "next/link";
import Image from "next/image";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FcGoogle } from "react-icons/fc";
import { FiAlertCircle, FiCheckCircle, FiEye, FiEyeOff } from "react-icons/fi";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import GradientBackground from "@/components/GradientBackground";
import {
    getAuthRedirectUrl,
    getFriendlyAuthError,
    resolvePostAuthRedirect,
} from "@/lib/auth";

function LoginPageInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const supabase = createSupabaseBrowserClient();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [emailLoading, setEmailLoading] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const noticeMsg = useMemo(() => {
        if (searchParams.get("checkEmail") === "1") {
            return "Check your email to confirm your account, then sign in.";
        }

        return null;
    }, [searchParams]);

    useEffect(() => {
        const routeError = searchParams.get("error");
        if (routeError) {
            setErrorMsg(routeError);
        }
    }, [searchParams]);

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

    const handleGoogleLogin = async () => {
        setErrorMsg(null);
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
        setEmailLoading(true);

        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email: email.trim().toLowerCase(),
                password,
            });

            if (error) {
                throw error;
            }

            if (!data.session) {
                throw new Error("Login failed. Please try again.");
            }

            const destination = await resolvePostAuthRedirect(supabase);
            router.replace(destination);
        } catch (error) {
            setErrorMsg(
                getFriendlyAuthError(
                    error instanceof Error ? error.message : "Unexpected error during login."
                )
            );
        } finally {
            setEmailLoading(false);
        }
    };

    const isBusy = emailLoading || googleLoading;

    return (
        <main className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden">
            <GradientBackground />
            <div className="relative w-full max-w-md">
                {/* glow behind card */}
                <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-violet-600/25 via-fuchsia-500/15 to-blue-500/20 blur-2xl" />

                <div className="relative rounded-3xl glass-strong glass-hi px-7 py-8 shadow-2xl shadow-black/50">
                    <Link href="/" className="flex items-center gap-2.5 mb-6">
                        <Image src="/logo.png" alt="Synapse" width={32} height={32} className="h-8 w-8" />
                        <span className="text-lg font-semibold tracking-tight text-white">Synapse</span>
                    </Link>

                    <h1 className="text-2xl font-bold tracking-tight text-white">Welcome back</h1>
                    <p className="mt-1.5 text-sm text-white/55">
                        Sign in to your libraries, workspaces, and chats.
                    </p>

                    {noticeMsg && (
                        <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                            <FiCheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p>{noticeMsg}</p>
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={handleGoogleLogin}
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
                            <label className="block text-xs font-medium text-white/70 mb-1.5">Email</label>
                            <input
                                type="email"
                                className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                placeholder="you@org.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="email"
                                required
                                disabled={isBusy}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-white/70 mb-1.5">Password</label>
                            <div className="relative">
                                <input
                                    type={showPassword ? "text" : "password"}
                                    className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 pr-10 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    autoComplete="current-password"
                                    required
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

                        {errorMsg && (
                            <div className="flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                                <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{errorMsg}</p>
                            </div>
                        )}

                        <button
                            type="submit"
                            className="btn-grad mt-2 w-full rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
                            disabled={isBusy}
                        >
                            {emailLoading ? "Signing in..." : "Sign in"}
                        </button>
                    </form>

                    <p className="mt-5 text-sm text-white/55 text-center">
                        New to Synapse?{" "}
                        <Link href="/register" className="text-violet-300 hover:text-violet-200 font-medium transition-colors">
                            Create an account
                        </Link>
                    </p>
                </div>
            </div>
        </main>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginPageInner />
        </Suspense>
    );
}
