"use client";

import Link from "next/link";
import Image from "next/image";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FiAlertCircle, FiEye, FiEyeOff, FiLock } from "react-icons/fi";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import GradientBackground from "@/components/GradientBackground";
import { getFriendlyAuthError, parseOtpType } from "@/lib/auth";

type Phase = "verifying" | "ready" | "invalid" | "saving" | "done";

function ResetPasswordInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const supabase = createSupabaseBrowserClient();

    const [phase, setPhase] = useState<Phase>("verifying");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Establish the recovery session from the email link, then show the form.
    useEffect(() => {
        let cancelled = false;

        const establish = async () => {
            const errorDescription = searchParams.get("error_description") || searchParams.get("error");
            if (errorDescription) {
                setPhase("invalid");
                setErrorMsg(getFriendlyAuthError(errorDescription));
                return;
            }

            // Recovery links may arrive as a hashed OTP (?token_hash=...&type=recovery) — verify it.
            const tokenHash = searchParams.get("token_hash");
            const type = parseOtpType(searchParams.get("type"));
            try {
                if (tokenHash && type) {
                    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
                    if (error) throw error;
                }
            } catch {
                if (!cancelled) {
                    setPhase("invalid");
                    setErrorMsg("This reset link is invalid or has expired. Request a new one.");
                }
                return;
            }

            // Otherwise the SSR client auto-exchanges a ?code= / #access_token (detectSessionInUrl).
            // Either way, wait for a session to appear.
            const startedAt = Date.now();
            while (!cancelled && Date.now() - startedAt < 6000) {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                if (session) {
                    if (!cancelled) setPhase("ready");
                    return;
                }
                await new Promise((r) => window.setTimeout(r, 250));
            }
            if (!cancelled) {
                setPhase("invalid");
                setErrorMsg("This reset link is invalid or has expired. Request a new one.");
            }
        };

        void establish();
        return () => {
            cancelled = true;
        };
    }, [searchParams, supabase]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrorMsg(null);
        if (password.length < 6) {
            setErrorMsg("Use at least 6 characters.");
            return;
        }
        if (password !== confirm) {
            setErrorMsg("Passwords don't match.");
            return;
        }
        setPhase("saving");
        try {
            const { error } = await supabase.auth.updateUser({ password });
            if (error) throw error;
            setPhase("done");
            // Sign out the recovery session so they sign in fresh with the new password.
            await supabase.auth.signOut();
            window.setTimeout(() => router.replace("/login?reset=1"), 900);
        } catch (error) {
            setPhase("ready");
            setErrorMsg(getFriendlyAuthError(error instanceof Error ? error.message : "Couldn't update your password."));
        }
    };

    const busy = phase === "saving" || phase === "done";

    return (
        <main className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden">
            <GradientBackground />
            <div className="relative w-full max-w-md">
                <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-violet-600/25 via-fuchsia-500/15 to-blue-500/20 blur-2xl" />

                <div className="relative rounded-3xl glass-strong glass-hi px-7 py-8 shadow-2xl shadow-black/50">
                    <Link href="/" className="flex items-center gap-2.5 mb-6">
                        <Image src="/logo.png" alt="Synapse" width={32} height={32} className="h-8 w-8" />
                        <span className="text-lg font-semibold tracking-tight text-white">Synapse</span>
                    </Link>

                    {phase === "verifying" ? (
                        <div className="py-6 text-center">
                            <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-[#b87fd9]" />
                            <p className="mt-4 text-sm text-white/55">Verifying your reset link…</p>
                        </div>
                    ) : phase === "invalid" ? (
                        <>
                            <h1 className="text-2xl font-bold tracking-tight text-white">Link expired</h1>
                            <div className="mt-4 flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                                <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{errorMsg || "This reset link is invalid or has expired."}</p>
                            </div>
                            <Link
                                href="/forgot-password"
                                className="btn-grad mt-6 inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-medium text-white"
                            >
                                Request a new link
                            </Link>
                        </>
                    ) : (
                        <>
                            <h1 className="text-2xl font-bold tracking-tight text-white">Set a new password</h1>
                            <p className="mt-1.5 text-sm text-white/55">Choose a strong password you don&apos;t use elsewhere.</p>

                            <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                                <div>
                                    <label className="block text-xs font-medium text-white/70 mb-1.5">New password</label>
                                    <div className="relative">
                                        <input
                                            type={showPassword ? "text" : "password"}
                                            className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 pr-10 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                            placeholder="••••••••"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            autoComplete="new-password"
                                            required
                                            disabled={busy}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword((v) => !v)}
                                            className="absolute inset-y-0 right-3 text-white/40 hover:text-white transition-colors"
                                            aria-label={showPassword ? "Hide password" : "Show password"}
                                        >
                                            {showPassword ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-white/70 mb-1.5">Confirm password</label>
                                    <input
                                        type={showPassword ? "text" : "password"}
                                        className="w-full rounded-xl bg-white/5 border border-white/12 px-3.5 py-2.5 text-sm text-white outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20 placeholder:text-white/35"
                                        placeholder="••••••••"
                                        value={confirm}
                                        onChange={(e) => setConfirm(e.target.value)}
                                        autoComplete="new-password"
                                        required
                                        disabled={busy}
                                    />
                                </div>

                                {errorMsg && (
                                    <div className="flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                                        <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <p>{errorMsg}</p>
                                    </div>
                                )}

                                <button
                                    type="submit"
                                    className="btn-grad mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
                                    disabled={busy}
                                >
                                    <FiLock className="h-4 w-4" />
                                    {phase === "done" ? "Password updated" : phase === "saving" ? "Saving..." : "Update password"}
                                </button>
                            </form>
                        </>
                    )}
                </div>
            </div>
        </main>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense fallback={null}>
            <ResetPasswordInner />
        </Suspense>
    );
}
