import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

export async function POST(req: Request) {
    const authHeader = req.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json({ error: "Missing access token." }, { status: 401 });
    }

    const accessToken = authHeader.slice("Bearer ".length).trim();
    const supabase = createSupabaseAdminClient();

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
        return NextResponse.json({ error: "Invalid or expired session." }, { status: 401 });
    }

    if (!user.email) {
        return NextResponse.json({ error: "Authenticated user is missing an email." }, { status: 400 });
    }

    const profile = {
        id: user.id,
        email: user.email,
        name:
            user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            null,
        avatar_url:
            user.user_metadata?.avatar_url ||
            user.user_metadata?.picture ||
            null,
        auth_provider:
            typeof user.app_metadata?.provider === "string"
                ? user.app_metadata.provider
                : null,
        auth_provider_id:
            typeof user.user_metadata?.sub === "string"
                ? user.user_metadata.sub
                : null,
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabase
        .from("users")
        .upsert(profile, { onConflict: "id" });

    if (upsertError) {
        console.error("sync-user upsert error:", upsertError);
        return NextResponse.json(
            { error: "Signed in, but we couldn't prepare your profile record." },
            { status: 500 }
        );
    }

    return NextResponse.json({ ok: true });
}
