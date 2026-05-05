import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

const PIPELINE_STAGES = [
    "sync",
    "layout_parser",
    "text_extraction",
    "image_captioning",
    "chunking",
    "embedding",
] as const;
type PipelineStage = (typeof PIPELINE_STAGES)[number];

function stageOrder(stage: string | null | undefined) {
    const idx = PIPELINE_STAGES.indexOf(stage as PipelineStage);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

export async function POST(req: Request) {
    let body: { library_id?: string; organization_id?: string } | null = null;

    try {
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

        const { data: library, error: libError } = await supabase
            .from("libraries")
            .select("id, organization_id, pipeline_status, pipeline_stage, total_batches")
            .eq("id", body.library_id)
            .eq("organization_id", body.organization_id)
            .single();

        if (libError || !library) {
            return NextResponse.json(
                { error: "Library not found." },
                { status: 404 }
            );
        }

        // If we don't have batches yet, resume means "re-run the bootstrap job".
        const { count: batchCount, error: batchCountError } = await supabase
            .from("library_batches")
            .select("id", { count: "exact", head: true })
            .eq("library_id", body.library_id);

        if (batchCountError) {
            return NextResponse.json(
                { error: `Failed to check batches: ${batchCountError.message}` },
                { status: 500 }
            );
        }

        if (!batchCount || batchCount === 0) {
            const now = new Date().toISOString();

            const { error: libUpdateError } = await supabase
                .from("libraries")
                .update({
                    status: "processing",
                    pipeline_status: "queued",
                    pipeline_stage: "sync",
                    pipeline_progress_percent: 0,
                    pipeline_error: null,
                    pipeline_started_at: now,
                    pipeline_finished_at: null,
                })
                .eq("id", body.library_id)
                .eq("organization_id", body.organization_id);

            if (libUpdateError) {
                return NextResponse.json(
                    { error: `Failed to update library: ${libUpdateError.message}` },
                    { status: 500 }
                );
            }

            const { data: job, error } = await supabase
                .from("processing_jobs")
                .insert({
                    type: "library_preprocess",
                    status: "queued",
                    organization_id: body.organization_id,
                    library_id: body.library_id,
                    payload: { stage: "sync", resume: true },
                })
                .select("id, status, created_at")
                .single();

            if (error) {
                return NextResponse.json({ error: error.message }, { status: 500 });
            }

            return NextResponse.json({ ok: true, mode: "bootstrap", job });
        }

    // 1) Re-queue failed/canceled jobs (stage jobs) so workers can pick them up again.
    const { error: requeueError } = await supabase
        .from("batch_stage_jobs")
        .update({
            status: "queued",
            assigned_worker: null,
            last_error: null,
            started_at: null,
            finished_at: null,
        })
        .eq("library_id", body.library_id)
        .in("status", ["failed", "canceled"]);

        if (requeueError) {
            return NextResponse.json(
                { error: `Failed to re-queue failed stage jobs: ${requeueError.message}` },
                { status: 500 }
            );
        }

    // 2) Ensure downstream jobs exist for any batches that already finished upstream.
    // Currently: if sync done and layout_parser missing, create it.
    const { data: syncDone } = await supabase
        .from("batch_stage_jobs")
        .select("batch_id, progress_total")
        .eq("library_id", body.library_id)
        .eq("stage", "sync")
        .eq("status", "done");

    if (syncDone && syncDone.length > 0) {
        const { data: existingLayout } = await supabase
            .from("batch_stage_jobs")
            .select("batch_id")
            .eq("library_id", body.library_id)
            .eq("stage", "layout_parser");

        const hasLayout = new Set((existingLayout ?? []).map((r) => r.batch_id));
        const toInsert = syncDone
            .filter((r) => r.batch_id && !hasLayout.has(r.batch_id))
            .map((r) => ({
                organization_id: body!.organization_id!,
                library_id: body!.library_id!,
                batch_id: r.batch_id,
                stage: "layout_parser",
                status: "queued",
                attempts: 0,
                payload: {},
                progress_current: 0,
                progress_total: r.progress_total ?? 0,
            }));

        if (toInsert.length > 0) {
            const { error } = await supabase.from("batch_stage_jobs").insert(toInsert);
            if (error) {
                return NextResponse.json(
                    { error: `Failed to enqueue layout_parser jobs: ${error.message}` },
                    { status: 500 }
                );
            }
        }
    }

    // If layout done, ensure BOTH text_extraction and image_captioning exist (these run in parallel).
    const { data: layoutDone } = await supabase
        .from("batch_stage_jobs")
        .select("batch_id, progress_total")
        .eq("library_id", body.library_id)
        .eq("stage", "layout_parser")
        .eq("status", "done");

    if (layoutDone && layoutDone.length > 0) {
        const { data: existingExtract } = await supabase
            .from("batch_stage_jobs")
            .select("batch_id")
            .eq("library_id", body.library_id)
            .eq("stage", "text_extraction");

        const { data: existingCaption } = await supabase
            .from("batch_stage_jobs")
            .select("batch_id")
            .eq("library_id", body.library_id)
            .eq("stage", "image_captioning");

        const hasExtract = new Set((existingExtract ?? []).map((r) => r.batch_id));
        const hasCaption = new Set((existingCaption ?? []).map((r) => r.batch_id));

        const toInsertExtract = layoutDone
            .filter((r) => r.batch_id && !hasExtract.has(r.batch_id))
            .map((r) => ({
                organization_id: body!.organization_id!,
                library_id: body!.library_id!,
                batch_id: r.batch_id,
                stage: "text_extraction",
                status: "queued",
                attempts: 0,
                payload: {},
                progress_current: 0,
                progress_total: r.progress_total ?? 0,
            }));

        const toInsertCaption = layoutDone
            .filter((r) => r.batch_id && !hasCaption.has(r.batch_id))
            .map((r) => ({
                organization_id: body!.organization_id!,
                library_id: body!.library_id!,
                batch_id: r.batch_id,
                stage: "image_captioning",
                status: "queued",
                attempts: 0,
                payload: {},
                progress_current: 0,
                progress_total: r.progress_total ?? 0,
            }));

        const toInsert = [...toInsertExtract, ...toInsertCaption];
        if (toInsert.length > 0) {
            const { error } = await supabase.from("batch_stage_jobs").insert(toInsert);
            if (error) {
                return NextResponse.json(
                    { error: `Failed to enqueue extraction/captioning jobs: ${error.message}` },
                    { status: 500 }
                );
            }
        }
    }

    // If BOTH text_extraction and image_captioning are done for a batch and chunking is missing, create chunking.
    const { data: extractDone } = await supabase
        .from("batch_stage_jobs")
        .select("batch_id, progress_total")
        .eq("library_id", body.library_id)
        .eq("stage", "text_extraction")
        .eq("status", "done");

    const { data: captionDone } = await supabase
        .from("batch_stage_jobs")
        .select("batch_id, progress_total")
        .eq("library_id", body.library_id)
        .eq("stage", "image_captioning")
        .eq("status", "done");

    const extractSet = new Map((extractDone ?? []).map((r) => [r.batch_id, r.progress_total ?? 0]));
    const captionSet = new Map((captionDone ?? []).map((r) => [r.batch_id, r.progress_total ?? 0]));
    const readyForChunk = [...extractSet.keys()].filter((bid) => bid && captionSet.has(bid));

    if (readyForChunk.length > 0) {
        const { data: existingChunk } = await supabase
            .from("batch_stage_jobs")
            .select("batch_id")
            .eq("library_id", body.library_id)
            .eq("stage", "chunking");

        const hasChunk = new Set((existingChunk ?? []).map((r) => r.batch_id));
        const toInsert = readyForChunk
            .filter((bid) => !hasChunk.has(bid))
            .map((bid) => ({
                organization_id: body!.organization_id!,
                library_id: body!.library_id!,
                batch_id: bid,
                stage: "chunking",
                status: "queued",
                attempts: 0,
                payload: {},
                progress_current: 0,
                progress_total: extractSet.get(bid) ?? captionSet.get(bid) ?? 0,
            }));

        if (toInsert.length > 0) {
            const { error } = await supabase.from("batch_stage_jobs").insert(toInsert);
            if (error) {
                return NextResponse.json(
                    { error: `Failed to enqueue chunking jobs: ${error.message}` },
                    { status: 500 }
                );
            }
        }
    }

    // If chunking is done for a batch and embedding is missing, create embedding.
    const { data: chunkDone } = await supabase
        .from("batch_stage_jobs")
        .select("batch_id, progress_total")
        .eq("library_id", body.library_id)
        .eq("stage", "chunking")
        .eq("status", "done");

    if (chunkDone && chunkDone.length > 0) {
        const { data: existingEmbed } = await supabase
            .from("batch_stage_jobs")
            .select("batch_id")
            .eq("library_id", body.library_id)
            .eq("stage", "embedding");

        const hasEmbed = new Set((existingEmbed ?? []).map((r) => r.batch_id));
        const toInsert = chunkDone
            .filter((r) => r.batch_id && !hasEmbed.has(r.batch_id))
            .map((r) => ({
                organization_id: body!.organization_id!,
                library_id: body!.library_id!,
                batch_id: r.batch_id,
                stage: "embedding",
                status: "queued",
                attempts: 0,
                payload: {},
                progress_current: 0,
                progress_total: r.progress_total ?? 0,
            }));

        if (toInsert.length > 0) {
            const { error } = await supabase.from("batch_stage_jobs").insert(toInsert);
            if (error) {
                return NextResponse.json(
                    { error: `Failed to enqueue embedding jobs: ${error.message}` },
                    { status: 500 }
                );
            }
        }
    }

    // 3) Pick a reasonable stage to show in UI (earliest stage with work remaining).
    const { data: remaining } = await supabase
        .from("batch_stage_jobs")
        .select("stage, status")
        .eq("library_id", body.library_id)
        .neq("status", "done");

    let nextStage: string = library.pipeline_stage || "sync";
    if (remaining && remaining.length > 0) {
        const stages = remaining
            .map((r) => r.stage as string)
            .sort((a, b) => stageOrder(a) - stageOrder(b));
        nextStage = stages[0] || nextStage;
    }

        const { error: finalUpdateError } = await supabase
            .from("libraries")
            .update({
                status: "processing",
                pipeline_status: "running",
                pipeline_stage: nextStage,
                pipeline_error: null,
            })
            .eq("id", body.library_id)
            .eq("organization_id", body.organization_id);

        if (finalUpdateError) {
            return NextResponse.json(
                { error: `Failed to update library status: ${finalUpdateError.message}` },
                { status: 500 }
            );
        }

        return NextResponse.json({ ok: true, mode: "stage", stage: nextStage });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
