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

/**
 * Permanently delete an organization the user OWNS, plus everything scoped to it:
 * libraries + documents + chunks, personal/team chat, agent runs/artifacts, knowledge graphs,
 * shares/invites/members, and all R2 objects. Irreversible. Uses the service-role client so it
 * can clean up regardless of RLS, after verifying the caller owns the org.
 */
export async function POST(req: Request) {
    let body: { organization_id?: string; user_id?: string } | null = null;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const orgId = body?.organization_id;
    const uid = body?.user_id;
    if (!orgId || !uid) {
        return NextResponse.json({ error: "organization_id and user_id are required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();

    // Ownership guard — only an owner may delete the org.
    const { data: mem } = await supabase
        .from("organization_members")
        .select("role")
        .eq("organization_id", orgId)
        .eq("user_id", uid)
        .maybeSingle();
    if (!mem || String((mem as { role?: string }).role) !== "owner") {
        return NextResponse.json({ error: "Only the organization owner can delete it." }, { status: 403 });
    }

    const { data: org } = await supabase.from("organizations").select("name").eq("id", orgId).single();
    const orgSlug = slugify(org?.name ?? "org");

    // Collect ids for library-scoped + run-scoped cleanup.
    const { data: libs } = await supabase.from("libraries").select("id").eq("organization_id", orgId);
    const libIds = ((libs as Array<{ id: string }>) || []).map((l) => String(l.id));
    const { data: runs } = await supabase.from("agent_runs").select("id").eq("organization_id", orgId);
    const runIds = ((runs as Array<{ id: string }>) || []).map((r) => String(r.id));

    // ---- R2 cleanup (best-effort) — org-level prefixes cover every library's objects ----
    const stages = ["raw", "layout", "text", "visuals_manifest", "visuals", "tables", "formulas", "charts", "captions", "chunks"];
    const prefixes = [
        `org_${orgSlug}_${orgId}/`,
        ...stages.map((s) => `${s}/${orgId}/`),
        `agent-uploads/${orgId}/`,
        ...runIds.slice(0, 2000).map((r) => `agents/${r}/`),
    ];
    const backend = getBackendBaseUrl();
    const r2Warnings: { status: number; body?: string }[] = [];
    if (backend) {
        try {
            const res = await fetch(`${backend}/r2/delete-prefix`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prefixes }),
            });
            if (!res.ok) r2Warnings.push({ status: res.status, body: (await res.text()).slice(0, 300) });
        } catch (err) {
            r2Warnings.push({ status: 0, body: err instanceof Error ? err.message : String(err) });
        }
    } else {
        r2Warnings.push({ status: 0, body: "Backend URL not configured; R2 objects were not deleted." });
    }

    // ---- DB cleanup (explicit + ordered; admin client bypasses RLS). Best-effort per table so a
    // missing table in an early schema never blocks the deletion. ----
    const delEq = async (table: string, col: string, val: string) => {
        try {
            await supabase.from(table).delete().eq(col, val);
        } catch {
            /* table may not exist */
        }
    };
    const delIn = async (table: string, col: string, vals: string[]) => {
        if (!vals.length) return;
        try {
            await supabase.from(table).delete().in(col, vals);
        } catch {
            /* table may not exist */
        }
    };

    // library-scoped helper tables
    await delIn("library_clusters", "library_id", libIds);
    await delIn("library_cluster_runs", "library_id", libIds);
    await delIn("batch_stage_jobs", "library_id", libIds);
    await delIn("library_batches", "library_id", libIds);
    await delIn("processing_jobs", "library_id", libIds);
    await delIn("library_sources", "library_id", libIds);

    // org-scoped content
    await delEq("chunk_embeddings", "organization_id", orgId);
    await delEq("documents", "organization_id", orgId);
    await delEq("libraries", "organization_id", orgId);

    await delEq("chat_message_sources", "organization_id", orgId);
    await delEq("chat_messages", "organization_id", orgId);
    await delEq("chat_threads", "organization_id", orgId);

    await delEq("agent_artifacts", "organization_id", orgId);
    await delEq("agent_messages", "organization_id", orgId);
    await delEq("agent_uploads", "organization_id", orgId);
    await delEq("agent_runs", "organization_id", orgId);

    await delEq("kg_edges", "organization_id", orgId);
    await delEq("kg_nodes", "organization_id", orgId);
    await delEq("kg_graphs", "organization_id", orgId);

    await delEq("team_library_member_privileges", "organization_id", orgId);
    await delEq("team_library_shares", "organization_id", orgId);
    await delEq("organization_invitations", "organization_id", orgId);
    await delEq("drive_connections", "organization_id", orgId);
    await delEq("organization_members", "organization_id", orgId);

    // finally, the organization itself
    const { error } = await supabase.from("organizations").delete().eq("id", orgId);
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, r2_warnings: r2Warnings.length ? r2Warnings : undefined });
}
