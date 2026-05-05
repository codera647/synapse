"use client";

import { SessionProvider } from "next-auth/react";

export default function AuthProviders({
    children,
}: {
    children: React.ReactNode;
}) {
    // Guardrail: keep NextAuth wiring inert unless explicitly enabled.
    const nextAuthEnabled = process.env.NEXT_PUBLIC_NEXTAUTH_ENABLED === "true";

    if (!nextAuthEnabled) {
        return <>{children}</>;
    }

    return <SessionProvider>{children}</SessionProvider>;
}
