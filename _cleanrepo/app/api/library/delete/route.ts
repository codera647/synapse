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

function slugify(value: string) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
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

    const supabase = createSupabaseAdminClient();

    const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", body.organization_id)
        .single();

    const { data: lib } = await supabase
        .from("libraries")
        .select("name")
        .eq("id", body.library_id)
        .single();

    const orgName = org?.name ?? "org";
    const libName = lib?.name ?? "library";

    const orgSlug = slugify(orgName);
    const libSlug = slugify(libName);
    const prefix = `org_${orgSlug}_${body.organization_id}/library_${libSlug}_${body.library_id}/`;
    const stagePrefixes = [
        `layout/${body.organization_id}/${body.library_id}/`,
        `text/${body.organization_id}/${body.library_id}/`,
        `visuals_manifest/${body.organization_id}/${body.library_id}/`,
        `visuals/${body.organization_id}/${body.library_id}/`,
        `tables/${body.organization_id}/${body.library_id}/`,
        `formulas/${body.organization_id}/${body.library_id}/`,
        `charts/${body.organization_id}/${body.library_id}/`,
        `captions/${body.organization_id}/${body.library_id}/`,
        `chunks/${body.organization_id}/${body.library_id}/`,
    ];

    // Best-effort: stop work ASAP and clean up queue rows so workers stop claiming new work.
    await supabase
        .from("libraries")
        .update({
            pipeline_status: "canceled",
            pipeline_error: "Canceled by user",
            status: "error",
        })
        .eq("id", body.library_id)
        .eq("organization_id", body.organization_id);

    // Remove derived vector/cluster state (best-effort). These tables may not exist in early schemas.
    try { await supabase.from("chunk_embeddings").delete().eq("library_id", body.library_id); } catch { /* ignore */ }
    try { await supabase.from("library_clusters").delete().eq("library_id", body.library_id); } catch { /* ignore */ }
    try { await supabase.from("library_cluster_runs").delete().eq("library_id", body.library_id); } catch { /* ignore */ }

    // Remove documents (and any downstream rows linked via FK/cascade, if configured).
    // Do this before deleting the library row to avoid orphaned rows when FK constraints are present.
    await supabase.from("documents").delete().eq("library_id", body.library_id);

    await supabase.from("batch_stage_jobs").delete().eq("library_id", body.library_id);
    await supabase.from("library_batches").delete().eq("library_id", body.library_id);
    await supabase.from("processing_jobs").delete().eq("library_id", body.library_id);

    const backend = getBackendBaseUrl();
    if (!backend) {
        return NextResponse.json(
            {
                error:
                    "Backend URL not configured. Set RUNPOD_API_URL (server) or NEXT_PUBLIC_RUNPOD_API_URL (dev) so we can delete R2 objects.",
            },
            { status: 500 }
        );
    }

    // Delete raw + all derived artifacts from R2.
    const prefixesToDelete = [prefix, ...stagePrefixes];
    const deleteResults = await Promise.all(
        prefixesToDelete.map(async (pfx) => {
            try {
                const res = await fetch(`${backend}/r2/delete-prefix`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prefix: pfx }),
                });
                const text = await res.text();
                return { prefix: pfx, ok: res.ok, status: res.status, body: text.slice(0, 500) };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { prefix: pfx, ok: false, status: 0, body: msg };
            }
        })
    );

    const failedDeletes = deleteResults.filter((r) => !r.ok);
    if (failedDeletes.length > 0) {
        return NextResponse.json(
            {
                error: "Failed to delete some R2 prefixes. Check backend URL and R2 credentials in Colab.",
                backend,
                failed: failedDeletes,
            },
            { status: 502 }
        );
    }

    const { error } = await supabase
        .from("libraries")
        .delete()
        .eq("id", body.library_id)
        .eq("organization_id", body.organization_id);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
}
