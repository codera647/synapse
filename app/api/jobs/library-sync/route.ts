import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

export async function POST(req: Request) {
    let body: { library_id?: string; organization_id?: string } | null = null;

    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { error: "Invalid JSON body" },
            { status: 400 }
        );
    }

    if (!body?.library_id || !body?.organization_id) {
        return NextResponse.json(
            { error: "library_id and organization_id are required" },
            { status: 400 }
        );
    }

    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
        .from("processing_jobs")
        .insert({
            type: "library_preprocess",
            status: "queued",
            organization_id: body.organization_id,
            library_id: body.library_id,
            payload: {},
        })
        .select("id, status, created_at")
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ job: data });
}
