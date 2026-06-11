"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import {
    getFriendlyAuthError,
    parseOtpType,
    resolvePostAuthRedirect,
} from "@/lib/auth";

async function waitForSession(
    getSession: () => Promise<{ data: { session: Session | null } }>,
    timeoutMs = 6000,
    intervalMs = 250
) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const { data } = await getSession();
        if (data.session) {
            return data.session;
        }

        await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }

    return null;
}

function AuthCallbackInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const supabase = createSupabaseBrowserClient();
    const [message, setMessage] = useState("Finalizing your sign-in...");

    useEffect(() => {
        let cancelled = false;

        const finish = async () => {
            const code = searchParams.get("code");
            const tokenHash = searchParams.get("token_hash");
            const type = parseOtpType(searchParams.get("type"));
            const errorDescription =
                searchParams.get("error_description") || searchParams.get("error");

            if (errorDescription) {
                router.replace(`/login?error=${encodeURIComponent(getFriendlyAuthError(errorDescription))}`);
                return;
            }

            try {
                if (tokenHash && type) {
                    setMessage("Confirming your email...");
                    const { error } = await supabase.auth.verifyOtp({
                        token_hash: tokenHash,
                        type,
                    });
                    if (error) {
                        throw error;
                    }
                }

                if (code) {
                    setMessage("Establishing your secure session...");
                    const session = await waitForSession(() => supabase.auth.getSession());
                    if (!session) {
                        throw new Error(
                            "We couldn't finish Google sign-in. Please try again."
                        );
                    }
                }

                const destination = await resolvePostAuthRedirect(supabase);
                router.replace(destination);
            } catch (error) {
                if (cancelled) {
                    return;
                }

                const fallback = getFriendlyAuthError(
                    error instanceof Error ? error.message : "Authentication failed."
                );
                setMessage(fallback);
                window.setTimeout(() => {
                    router.replace(`/login?error=${encodeURIComponent(fallback)}`);
                }, 1200);
            }
        };

        void finish();

        return () => {
            cancelled = true;
        };
    }, [router, searchParams, supabase]);

    return (
        <main className="min-h-screen flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#080B14] px-6 py-8 text-center shadow-2xl">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-[#b87fd9]" />
                <h1 className="mt-5 text-xl font-semibold text-white">Signing you in</h1>
                <p className="mt-2 text-sm text-gray-400">{message}</p>
            </div>
        </main>
    );
}

export default function AuthCallbackPage() {
    return (
        <Suspense fallback={null}>
            <AuthCallbackInner />
        </Suspense>
    );
}
