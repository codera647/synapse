"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { FiAlertCircle, FiArrowLeft, FiMail } from "react-icons/fi";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import GradientBackground from "@/components/GradientBackground";
import { getAuthRedirectUrl, getFriendlyAuthError } from "@/lib/auth";

export default function ForgotPasswordPage() {
    const supabase = createSupabaseBrowserClient();

    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [sent, setSent] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrorMsg(null);
        setLoading(true);
        try {
            const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
                redirectTo: getAuthRedirectUrl("/reset-password"),
            });
            // Don't reveal whether the email exists — always show the same confirmation, but surface
            // genuine errors (rate limiting, bad config).
            if (error && /rate|too many|smtp|provider|not enabled/i.test(error.message)) {
                throw error;
            }
            setSent(true);
        } catch (error) {
            setErrorMsg(getFriendlyAuthError(error instanceof Error ? error.message : "Couldn't send the reset email."));
        } finally {
            setLoading(false);
        }
    };

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

                    {sent ? (
                        <>
                            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/30">
                                <FiMail className="h-6 w-6 text-white" />
                            </div>
                            <h1 className="text-2xl font-bold tracking-tight text-white">Check your email</h1>
                            <p className="mt-2 text-sm leading-relaxed text-white/60">
                                If an account exists for <span className="text-white/85">{email.trim().toLowerCase()}</span>,
                                we&apos;ve sent a link to reset your password. The link expires in 1 hour.
                            </p>
                            <Link
                                href="/login"
                                className="btn-grad mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white"
                            >
                                Back to sign in
                            </Link>
                        </>
                    ) : (
                        <>
                            <h1 className="text-2xl font-bold tracking-tight text-white">Reset your password</h1>
                            <p className="mt-1.5 text-sm text-white/55">
                                Enter your email and we&apos;ll send you a link to set a new password.
                            </p>

                            <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
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
                                        disabled={loading}
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
                                    className="btn-grad mt-2 w-full rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
                                    disabled={loading}
                                >
                                    {loading ? "Sending..." : "Send reset link"}
                                </button>
                            </form>

                            <Link
                                href="/login"
                                className="mt-5 inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white transition-colors"
                            >
                                <FiArrowLeft className="h-3.5 w-3.5" /> Back to sign in
                            </Link>
                        </>
                    )}
                </div>
            </div>
        </main>
    );
}
