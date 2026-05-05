import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

function getAppUrl() {
    return (
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXTAUTH_URL ||
        "http://localhost:3000"
    );
}

function decodeState(state: string) {
    const json = Buffer.from(state, "base64url").toString("utf8");
    return JSON.parse(json) as { library_id: string; organization_id: string };
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    const redirectBase = `${getAppUrl()}/dashboard`;

    if (errorParam) {
        return NextResponse.redirect(
            `${redirectBase}?drive=error&reason=${encodeURIComponent(errorParam)}`
        );
    }

    if (!code || !stateParam) {
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=missing`);
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=oauth`);
    }

    let state: { library_id: string; organization_id: string };
    try {
        state = decodeState(stateParam);
    } catch {
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=state`);
    }

    const redirectUri = `${getAppUrl()}/api/google-drive/callback`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });

    if (!tokenRes.ok) {
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=token`);
    }

    const tokenJson = await tokenRes.json();
    const refreshToken = tokenJson.refresh_token as string | undefined;
    const accessToken = tokenJson.access_token as string | undefined;
    const expiresIn = tokenJson.expires_in as number | undefined;

    const supabase = createSupabaseAdminClient();

    const { data: library } = await supabase
        .from("libraries")
        .select("id, organization_id, source_folder_id, name")
        .eq("id", state.library_id)
        .eq("organization_id", state.organization_id)
        .single();

    if (!library) {
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=library`);
    }

    const tokenExpiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;

    let storedRefresh = refreshToken;
    if (!storedRefresh) {
        const { data: existingOrg } = await supabase
            .from("drive_connections")
            .select("refresh_token")
            .eq("organization_id", state.organization_id)
            .maybeSingle();
        storedRefresh = existingOrg?.refresh_token;
    }

    if (!storedRefresh) {
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=refresh`);
    }

    const { error: orgError } = await supabase
        .from("drive_connections")
        .upsert(
            {
                organization_id: state.organization_id,
                provider: "google_drive",
                refresh_token: storedRefresh,
                access_token: accessToken ?? null,
                token_expires_at: tokenExpiresAt,
            },
            { onConflict: "organization_id" }
        );

    if (orgError) {
        console.error("drive_connections upsert error:", orgError);
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=store`);
    }

    const { error } = await supabase
        .from("library_sources")
        .upsert(
            {
                organization_id: state.organization_id,
                library_id: state.library_id,
                provider: "google_drive",
                folder_id: library.source_folder_id,
                folder_name: library.name,
                refresh_token: storedRefresh,
                access_token: accessToken ?? null,
                token_expires_at: tokenExpiresAt,
            },
            { onConflict: "library_id,organization_id" }
        );

    if (error) {
        console.error("library_sources upsert error:", error);
        return NextResponse.redirect(`${redirectBase}?drive=error&reason=store`);
    }

    const { error: jobError } = await supabase
        .from("processing_jobs")
        .insert({
            type: "library_preprocess",
            status: "queued",
            organization_id: state.organization_id,
            library_id: state.library_id,
            payload: {},
        });

    if (jobError) {
        return NextResponse.redirect(`${redirectBase}?drive=connected`);
    }

    return NextResponse.redirect(`${redirectBase}?drive=queued`);
}
