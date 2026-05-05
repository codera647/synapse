import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";

// Guardrail: Supabase auth is primary; keep NextAuth disabled unless explicitly enabled.
const nextAuthEnabled = process.env.NEXT_PUBLIC_NEXTAUTH_ENABLED === "true";

const handler = nextAuthEnabled
    ? NextAuth({
        providers: [
            GoogleProvider({
                clientId: process.env.GOOGLE_CLIENT_ID!,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            }),
        ],
        // Optional callbacks - kept for potential future use.
        callbacks: {
            async session({ session, token }) {
                if (session.user && token.sub) {
                    (session.user as any).id = token.sub;
                }
                return session;
            },
        },
    })
    : () => new Response("Not Found", { status: 404 });

export { handler as GET, handler as POST };
