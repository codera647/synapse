import math
import os
from env_bootstrap import load_env
from supabase import create_client

load_env()

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))


def create_library_batches(
    organization_id: str,
    library_id: str,
    worker_count: int,
    stage: str = "sync",
    clear_existing: bool = True,
):
    if worker_count <= 0:
        worker_count = 1

    if clear_existing:
        # Delete stage jobs first (FK), then batches.
        supabase.table("batch_stage_jobs").delete().eq("library_id", library_id).execute()
        supabase.table("library_batches").delete().eq("library_id", library_id).execute()

    docs = (
        supabase.table("documents")
        .select("id, gdrive_file_id, title")
        .eq("library_id", library_id)
        .order("gdrive_file_id", desc=False)
        .order("title", desc=False)
        .execute()
        .data
        or []
    )

    total = len(docs)
    if total == 0:
        return {"created": 0, "batch_size": 0}

    # The number of batches sets the MAX parallelism for every stage (one worker per batch at a
    # time). It is exactly the worker count you configured (passed in as `worker_count` = the
    # largest per-stage worker setting), so "I set 5 workers" => 5 batches => the card shows N/5.
    # No hidden doc-based inflation (that's what made 29 docs show up as "0/6"). Capped by the
    # document count (can't have more batches than docs) and BATCH_MAX_COUNT.
    max_batches = max(1, int(os.getenv("BATCH_MAX_COUNT", "64")))
    n_batches = min(max(1, int(worker_count)), max_batches, total)
    batch_size = max(1, math.ceil(total / n_batches))
    batches = [docs[i : i + batch_size] for i in range(0, total, batch_size)]

    for idx, batch in enumerate(batches):
        doc_ids = [d["id"] for d in batch]
        inserted = (
            supabase.table("library_batches")
            .insert(
                {
                    "organization_id": organization_id,
                    "library_id": library_id,
                    "batch_index": idx,
                    "status": "queued",
                    "doc_ids": doc_ids,
                    "doc_count": len(doc_ids),
                }
            )
            .execute()
        )

        if not inserted.data:
            raise RuntimeError("Failed to insert library_batches row")
        batch_id = inserted.data[0]["id"]
        supabase.table("batch_stage_jobs").insert(
            {
                "organization_id": organization_id,
                "library_id": library_id,
                "batch_id": batch_id,
                "stage": stage,
                "status": "queued",
                "attempts": 0,
                "payload": {},
                "progress_current": 0,
                "progress_total": len(doc_ids),
            }
        ).execute()

    return {"created": len(batches), "batch_size": batch_size}
