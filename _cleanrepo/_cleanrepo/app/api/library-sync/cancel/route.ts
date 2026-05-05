import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabaseAdmin";

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
      .select("id, pipeline_status")
      .eq("id", body.library_id)
      .eq("organization_id", body.organization_id)
      .single();

    if (libError || !library) {
      return NextResponse.json(
        { error: libError?.message || "Library not found." },
        { status: 404 }
      );
    }

    // Mark as canceled so workers stop as soon as they re-check library status.
    const { error: cancelError } = await supabase
      .from("libraries")
      .update({
        pipeline_status: "canceled",
        pipeline_error: "Canceled by user",
      })
      .eq("id", body.library_id)
      .eq("organization_id", body.organization_id);

    if (cancelError) {
      return NextResponse.json(
        { error: `Failed to cancel library: ${cancelError.message}` },
        { status: 500 }
      );
    }

    // IMPORTANT: mark stage jobs as canceled so workers don't keep claiming them.
    // Resume will flip them back to queued.
    const { error: requeueError } = await supabase
      .from("batch_stage_jobs")
      .update({
        status: "canceled",
        assigned_worker: null,
        last_error: null,
        started_at: null,
        finished_at: null,
      })
      .eq("library_id", body.library_id)
      .in("status", ["running", "queued"]);

    if (requeueError) {
      return NextResponse.json(
        { error: `Failed to re-queue stage jobs: ${requeueError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
