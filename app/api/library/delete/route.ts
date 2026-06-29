import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";
import { getBackendBaseUrl } from "@/lib/backend-url";

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
        `raw/${body.organization_id}/${body.library_id}/`,
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
    // The library's Drive source connection (refresh token, folder). Org-level drive_connections
    // are shared across libraries, so we leave those alone.
    try { await supabase.from("library_sources").delete().eq("library_id", body.library_id); } catch { /* ignore */ }

    // R2 cleanup is BEST-EFFORT — never block removing the library (and its DB rows + embeddings,
    // already deleted above) on R2 being reachable. Any failures come back as warnings so leftover
    // objects can be swept later, but the library always disappears for the user.
    const backend = await getBackendBaseUrl();
    let r2Warnings: { prefix: string; status: number; body?: string }[] = [];
    if (backend) {
        const prefixesToDelete = [prefix, ...stagePrefixes];
        const deleteResults = await Promise.all(
            prefixesToDelete.map(async (pfx) => {
                try {
                    const res = await fetch(`${backend}/r2/delete-prefix`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ prefix: pfx }),
                    });
                    return { prefix: pfx, ok: res.ok, status: res.status, body: res.ok ? "" : (await res.text()).slice(0, 300) };
                } catch (err) {
                    return { prefix: pfx, ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
                }
            })
        );
        r2Warnings = deleteResults.filter((r) => !r.ok).map(({ prefix, status, body }) => ({ prefix, status, body }));
    } else {
        r2Warnings = [{ prefix: "*", status: 0, body: "Backend URL not configured; R2 objects were not deleted." }];
    }

    // Always remove the library row last (DB rows + embeddings are already gone above).
    const { error } = await supabase
        .from("libraries")
        .delete()
        .eq("id", body.library_id)
        .eq("organization_id", body.organization_id);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, r2_warnings: r2Warnings.length ? r2Warnings : undefined });
}
