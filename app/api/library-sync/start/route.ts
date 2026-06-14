import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

function getBackendBaseUrl() {
    return (
        process.env.RUNPOD_API_URL ||
        process.env.BACKEND_API_URL ||
        process.env.NEXT_PUBLIC_BACKEND_API_URL ||
        process.env.NEXT_PUBLIC_RUNPOD_API_URL ||
        ""
    ).trim().replace(/\/+$/, "");
}

async function checkBackendAvailable() {
    const base = getBackendBaseUrl();
    if (!base) {
        return {
            ok: false as const,
            status: 500,
            target: null as string | null,
            message: "Missing backend URL. Set BACKEND_API_URL or RUNPOD_API_URL.",
        };
    }

    const target = `${base}/hardware`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(target, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
            return { ok: true as const };
        }

        const text = await res.text().catch(() => "");
        return {
            ok: false as const,
            status: res.status,
            target,
            message: `Backend responded with ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`,
            details: text ? text.slice(0, 400) : "",
        };
    } catch (err) {
        const isTimeout = err instanceof Error && err.name === "AbortError";
        return {
            ok: false as const,
            status: 502,
            target,
            message: isTimeout
                ? "Backend timed out (5s). Start your backend and retry."
                : "Unable to reach backend. Start your backend and retry.",
            details: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

function getAppUrl() {
    return (
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXTAUTH_URL ||
        "http://localhost:3000"
    );
}

function buildAuthUrl(libraryId: string, organizationId: string) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        throw new Error("Missing GOOGLE_CLIENT_ID");
    }

    const redirectUri = `${getAppUrl()}/api/google-drive/callback`;
    const state = Buffer.from(
        JSON.stringify({ library_id: libraryId, organization_id: organizationId })
    ).toString("base64url");

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: "https://www.googleapis.com/auth/drive.readonly",
        state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Validate a refresh token by attempting to exchange it for an access token.
 * Returns { valid: true, access_token } on success, or { valid: false } if expired/revoked.
 */
async function validateRefreshToken(refreshToken: string): Promise<{ valid: boolean; access_token?: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return { valid: false };
    }

    try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }),
        });

        if (!res.ok) {
            const errorBody = await res.json().catch(() => ({}));
            console.error("Token validation failed:", res.status, errorBody);
            return { valid: false };
        }

        const data = await res.json();
        return { valid: true, access_token: data.access_token };
    } catch (err) {
        console.error("Token validation error:", err);
        return { valid: false };
    }
}

/**
 * Clear stale OAuth tokens for an organization so the user is forced to re-authorize.
 */
async function clearStaleTokens(supabase: ReturnType<typeof createSupabaseAdminClient>, organizationId: string, libraryId?: string) {
    // Clear org-level drive connection
    await supabase
        .from("drive_connections")
        .delete()
        .eq("organization_id", organizationId);

    // Clear library-specific source tokens
    if (libraryId) {
        await supabase
            .from("library_sources")
            .delete()
            .eq("organization_id", organizationId)
            .eq("library_id", libraryId);
    } else {
        await supabase
            .from("library_sources")
            .delete()
            .eq("organization_id", organizationId);
    }
}

export async function POST(req: Request) {
    let body: { library_id?: string; organization_id?: string } | null = null;

    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body?.library_id || !body?.organization_id) {
        return NextResponse.json(
            { error: "library_id and organization_id are required" },
            { status: 400 }
        );
    }

    try {
    const supabase = createSupabaseAdminClient();

    // --- Step 1: Find the refresh token ---
    let refreshToken: string | null = null;

    const { data: source } = await supabase
        .from("library_sources")
        .select("id, refresh_token")
        .eq("library_id", body.library_id)
        .eq("organization_id", body.organization_id)
        .limit(1)
        .maybeSingle();

    if (source?.refresh_token) {
        refreshToken = source.refresh_token;
    } else {
        const { data: connection } = await supabase
            .from("drive_connections")
            .select("refresh_token")
            .eq("organization_id", body.organization_id)
            .maybeSingle();

        refreshToken = connection?.refresh_token ?? null;
    }

    // No token at all → send to Google OAuth
    if (!refreshToken) {
        const authUrl = buildAuthUrl(body.library_id, body.organization_id);
        return NextResponse.json({ requires_auth: true, auth_url: authUrl });
    }

    // --- Step 2: Validate the refresh token BEFORE queuing a job ---
    const tokenCheck = await validateRefreshToken(refreshToken);

    if (!tokenCheck.valid) {
        // Token is expired/revoked → clear stale tokens and force re-auth
        console.warn(
            `Refresh token invalid for org=${body.organization_id}, lib=${body.library_id}. Clearing stale tokens.`
        );
        await clearStaleTokens(supabase, body.organization_id, body.library_id);

        const authUrl = buildAuthUrl(body.library_id, body.organization_id);
        return NextResponse.json({
            requires_auth: true,
            auth_url: authUrl,
            reason: "token_expired",
            message: "Google Drive authorization has expired. Please re-authorize.",
        });
    }

    // --- Step 3: Ensure library_sources entry exists ---
    if (!source || !source.refresh_token) {
        const { data: library } = await supabase
            .from("libraries")
            .select("source_folder_id, name")
            .eq("id", body.library_id)
            .eq("organization_id", body.organization_id)
            .single();

        if (!library?.source_folder_id) {
            return NextResponse.json(
                { error: "Missing source_folder_id for library" },
                { status: 400 }
            );
        }

        await supabase.from("library_sources").upsert(
            {
                organization_id: body.organization_id,
                library_id: body.library_id,
                provider: "google_drive",
                folder_id: library.source_folder_id,
                folder_name: library.name,
                refresh_token: refreshToken,
            },
            { onConflict: "library_id,organization_id" }
        );
    }

    // --- Step 4: Make sure the external backend is reachable ---
    const backendCheck = await checkBackendAvailable();

    if (!backendCheck.ok) {
        return NextResponse.json(
            {
                error: backendCheck.message,
                backend_status: backendCheck.status,
                backend_target: backendCheck.target,
                backend_details: "details" in backendCheck ? backendCheck.details : undefined,
            },
            { status: 503 }
        );
    }

    const now = new Date().toISOString();

    await supabase
        .from("libraries")
        .update({
            pipeline_status: "queued",
            pipeline_stage: "sync",
            pipeline_progress_percent: 0,
            pipeline_error: null,
            cancel_requested: false,
            pipeline_started_at: now,
            pipeline_finished_at: null,
            total_batches: 0,
            completed_batches: 0,
            status: "processing",
        })
        .eq("id", body.library_id)
        .eq("organization_id", body.organization_id);

    // --- Step 5: Queue the preprocessing bootstrap job ---
    const { data, error } = await supabase
        .from("processing_jobs")
        .insert({
            type: "library_preprocess",
            status: "queued",
            organization_id: body.organization_id,
            library_id: body.library_id,
            payload: {
                stage: "sync",
            },
        })
        .select("id, status, created_at")
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ job: data });
    } catch (err) {
        // Surface the real cause instead of an opaque 500 (usually a missing Worker env var:
        // SUPABASE_SERVICE_ROLE_KEY / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / BACKEND_API_URL).
        console.error("library-sync/start failed:", err);
        return NextResponse.json(
            {
                error:
                    err instanceof Error
                        ? `Couldn't start preprocessing: ${err.message}`
                        : "Unexpected server error starting preprocessing.",
            },
            { status: 500 },
        );
    }
}
