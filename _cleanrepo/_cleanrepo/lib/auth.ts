import type { EmailOtpType, SupabaseClient } from "@supabase/supabase-js";

const OTP_TYPES: EmailOtpType[] = [
    "signup",
    "invite",
    "magiclink",
    "recovery",
    "email_change",
    "email",
];

function trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, "");
}

export function getAppOrigin() {
    const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (configured) {
        return trimTrailingSlash(configured);
    }

    if (typeof window !== "undefined") {
        return trimTrailingSlash(window.location.origin);
    }

    return "";
}

export function getAuthRedirectUrl(path = "/auth/callback") {
    const origin = getAppOrigin();
    return origin ? `${origin}${path}` : path;
}

export function getFriendlyAuthError(message?: string | null) {
    if (!message) {
        return "Something went wrong. Please try again.";
    }

    const normalized = message.toLowerCase();

    if (normalized.includes("invalid login credentials")) {
        return "Invalid email or password.";
    }

    if (normalized.includes("email not confirmed")) {
        return "Your email is not confirmed yet. Please confirm it from your inbox.";
    }

    if (normalized.includes("user already registered")) {
        return "An account with this email already exists. Try signing in instead.";
    }

    if (normalized.includes("password should be at least")) {
        return "Password is too short. Use at least 6 characters.";
    }

    if (normalized.includes("too many requests")) {
        return "Too many attempts. Please wait a bit and try again.";
    }

    if (normalized.includes("signup is disabled")) {
        return "New signups are currently disabled.";
    }

    if (normalized.includes("provider is not enabled")) {
        return "Google sign-in is not enabled in Supabase yet.";
    }

    if (normalized.includes("oauth") || normalized.includes("provider")) {
        return "We couldn't start Google sign-in. Please try again.";
    }

    return message;
}

export function parseOtpType(value: string | null): EmailOtpType | null {
    if (!value) {
        return null;
    }

    return OTP_TYPES.includes(value as EmailOtpType) ? (value as EmailOtpType) : null;
}

export async function syncSignedInUser(supabase: SupabaseClient) {
    const {
        data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
        throw new Error("No active session found.");
    }

    const response = await fetch("/api/auth/sync-user", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${session.access_token}`,
        },
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error(payload?.error || "Unable to sync your account.");
    }
}

export async function resolvePostAuthRedirect(supabase: SupabaseClient) {
    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
        throw new Error("We couldn't verify your session. Please sign in again.");
    }

    await syncSignedInUser(supabase);

    const { count, error: membershipError } = await supabase
        .from("organization_members")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

    if (membershipError) {
        throw new Error("Signed in, but we couldn't load your workspace yet.");
    }

    return count && count > 0 ? "/dashboard" : "/new-organization";
}
