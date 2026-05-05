import os
import json
import random
import time
from datetime import datetime, timezone

from env_bootstrap import load_env
from supabase import create_client
import boto3


load_env()

WORKER_ID = os.getenv("WORKER_ID", "embed-1")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


SUPABASE_URL = get_env("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = get_env("SUPABASE_SERVICE_ROLE_KEY")

R2_ENDPOINT = get_env("R2_ENDPOINT")
R2_BUCKET = get_env("R2_BUCKET")
# Optional on AWS if using an Instance Role (recommended).
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY") or ""
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY") or ""

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT or None,
    aws_access_key_id=R2_ACCESS_KEY or None,
    aws_secret_access_key=R2_SECRET_KEY or None,
)


def _pipeline_stages():
    raw = os.getenv(
        "PIPELINE_STAGES",
        "sync,layout_parser,text_extraction,image_captioning,chunking,embedding",
    )
    stages = [s.strip() for s in raw.split(",") if s.strip()]
    return stages or ["embedding"]


def _is_retryable_supabase_error(exc: Exception) -> bool:
    msg = str(exc) or ""
    m = msg.lower()
    if "json could not be generated" in m:
        return True
    if "bad gateway" in m or "error code 502" in m or " 502" in m:
        return True
    if "web server is down" in m or "error code 521" in m or " 521" in m:
        return True
    if "timeout" in m or "timed out" in m:
        return True
    if "too many requests" in m or " 429" in m:
        return True
    return False


def _sb_execute(query, context: str = "", max_attempts: int | None = None):
    attempts = int(os.getenv("SUPABASE_MAX_RETRIES", "6")) if max_attempts is None else int(max_attempts)
    base = float(os.getenv("SUPABASE_RETRY_BASE_SECONDS", "0.6"))
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return query.execute()
        except Exception as exc:
            last_exc = exc
            if not _is_retryable_supabase_error(exc) or i == attempts - 1:
                raise
            sleep_s = min(20.0, base * (2**i)) * (0.85 + random.random() * 0.3)
            print(f"[supabase-retry] {context or 'query'} attempt={i+1}/{attempts} sleep={sleep_s:.2f}s err={exc}")
            time.sleep(sleep_s)
    if last_exc:
        raise last_exc


_PIPELINE_ABORT_STATUSES = {"canceled", "failed"}


def _get_library_pipeline_status(library_id: str) -> str | None:
    res = _sb_execute(
        supabase.table("libraries").select("pipeline_status").eq("id", library_id).single(),
        context="libraries.select(pipeline_status)",
    )
    if not res.data:
        return None
    return (res.data.get("pipeline_status") or "").lower() or None


def _mark_stage_job_canceled(job_id: str, reason: str):
    _sb_execute(
        supabase.table("batch_stage_jobs")
        .update({"status": "canceled", "assigned_worker": None, "last_error": reason, "finished_at": now_iso()})
        .eq("id", job_id)
        .eq("status", "running"),
        context="batch_stage_jobs.update(canceled)",
    )


def _cancel_queued_stage_jobs_for_library(library_id: str, reason: str, exclude_job_id: str | None = None):
    q = (
        supabase.table("batch_stage_jobs")
        .update({"status": "canceled", "last_error": reason, "finished_at": now_iso()})
        .eq("library_id", library_id)
        .eq("status", "queued")
    )
    if exclude_job_id:
        q = q.neq("id", exclude_job_id)
    _sb_execute(q, context="batch_stage_jobs.update(cancel_queued_for_library)")


def fetch_r2_bytes(key: str) -> bytes:
    obj = s3.get_object(Bucket=R2_BUCKET, Key=key)
    return obj["Body"].read()


def fetch_r2_json(key: str) -> dict | None:
    try:
        raw = fetch_r2_bytes(key)
    except Exception:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


_embedder = None


def _get_embedder():
    global _embedder
    if _embedder is not None:
        return _embedder
    # SentenceTransformers provides stable pooling + normalization across many models.
    from sentence_transformers import SentenceTransformer  # type: ignore

    model_id = os.getenv("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    device = os.getenv("EMBED_DEVICE", "").strip()
    if not device:
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    _embedder = SentenceTransformer(model_id, device=device)
    return _embedder


def _embed_texts(texts: list[str]) -> list[list[float]]:
    embedder = _get_embedder()
    batch_size = int(os.getenv("EMBED_BATCH", "32"))
    if batch_size <= 0:
        batch_size = 16

    # Normalize for cosine/dot-product equivalence.
    # On GPU, large batches can OOM on some libraries; automatically back off.
    bs = max(1, batch_size)
    while True:
        try:
            vecs = embedder.encode(
                texts,
                batch_size=bs,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            break
        except RuntimeError as exc:
            msg = str(exc).lower()
            if "out of memory" not in msg and "cuda" not in msg:
                raise
            if bs <= 1:
                raise
            new_bs = max(1, bs // 2)
            print(f"[embed] CUDA OOM; backing off batch_size {bs} -> {new_bs}")
            bs = new_bs
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
    try:
        import numpy as np

        if isinstance(vecs, np.ndarray):
            return vecs.astype("float32").tolist()
    except Exception:
        pass
    return [list(map(float, v)) for v in vecs]


def claim_embedding_stage_job(worker_id: str):
    # Gate claiming: embedding should only run after chunking is done for the batch.
    jobs = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "embedding")
        .eq("status", "queued")
        .order("created_at")
        .limit(int(os.getenv("CLAIM_SCAN_LIMIT", "25"))),
        context="batch_stage_jobs.select(embedding.queued)",
    )
    rows = jobs.data or []
    if not rows:
        return None

    batch_ids = [r.get("batch_id") for r in rows if r.get("batch_id")]
    if not batch_ids:
        return None

    ready = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("batch_id")
        .in_("batch_id", batch_ids)
        .eq("stage", "chunking")
        .eq("status", "done"),
        context="batch_stage_jobs.select(chunking.done.for_embedding)",
    )
    ready_batches = {str(r.get("batch_id")) for r in (ready.data or []) if r.get("batch_id")}

    job = None
    for r in rows:
        bid = str(r.get("batch_id") or "")
        if bid and bid in ready_batches:
            job = r
            break
    if not job:
        return None

    claimed = _sb_execute(
        supabase.table("batch_stage_jobs")
        .update(
            {
                "status": "running",
                "assigned_worker": worker_id,
                "started_at": now_iso(),
                "attempts": int(job.get("attempts") or 0) + 1,
            }
        )
        .eq("id", job["id"])
        .eq("status", "queued"),
        context="batch_stage_jobs.update(embedding.claim)",
    )
    if not claimed.data:
        return None
    return claimed.data[0]


def _count_done_stage_jobs(library_id: str, stage: str) -> int:
    resp = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("id", count="exact")
        .eq("library_id", library_id)
        .eq("stage", stage)
        .eq("status", "done"),
        context=f"batch_stage_jobs.count(done:{stage})",
    )
    return int(resp.count or 0)


def _get_total_batches(library_id: str) -> int:
    """
    Some early libraries might not have `libraries.total_batches` populated.
    Fall back to counting `library_batches` so the pipeline can still progress.
    """
    lib = _sb_execute(
        supabase.table("libraries").select("total_batches").eq("id", library_id).single(),
        context="libraries.select(total_batches.fallback)",
    )
    tb = int((lib.data or {}).get("total_batches") or 0)
    if tb > 0:
        return tb
    cnt = _sb_execute(
        supabase.table("library_batches").select("id", count="exact").eq("library_id", library_id),
        context="library_batches.count(total_batches.fallback)",
    )
    return int(cnt.count or 0)


def _update_library_progress(library_id: str):
    total_batches = _get_total_batches(library_id)
    if total_batches <= 0:
        return

    stages = _pipeline_stages()
    done_total = 0
    for st in stages:
        done_total += _count_done_stage_jobs(library_id, st)

    denom = max(1, total_batches * len(stages))
    progress = round((done_total / denom) * 100, 2)
    # Batch-completed means reached the last stage.
    completed_batches = _count_done_stage_jobs(library_id, stages[-1])

    _sb_execute(
        supabase.table("libraries").update(
            {
                "pipeline_status": "running",
                "pipeline_progress_percent": progress,
                "completed_batches": completed_batches,
            }
        ).eq("id", library_id),
        context="libraries.update(progress)",
    )


def _maybe_finalize_pipeline(library_id: str):
    """
    Mark the library as fully processed when all stages are complete.

    Note: clustering is currently disabled, so "embedding" is the terminal stage.
    """
    total_batches = _get_total_batches(library_id)
    if total_batches <= 0:
        return

    stages = _pipeline_stages()
    # If clustering is part of the configured pipeline, let the clustering worker finalize.
    if "clustering" in stages:
        return

    for st in stages:
        if _count_done_stage_jobs(library_id, st) < total_batches:
            return

    finished = now_iso()
    _sb_execute(
        supabase.table("libraries").update(
            {
                "status": "ready",
                "pipeline_status": "completed",
                "pipeline_stage": stages[-1] if stages else "embedding",
                "pipeline_progress_percent": 100,
                "pipeline_error": None,
                "pipeline_finished_at": finished,
                "completed_batches": total_batches,
            }
        ).eq("id", library_id),
        context="libraries.update(completed)",
    )


def _ensure_stage_job_exists(org_id: str, library_id: str, batch_id: str, stage: str, progress_total: int):
    existing = _sb_execute(
        supabase.table("batch_stage_jobs").select("id").eq("batch_id", batch_id).eq("stage", stage).limit(1),
        context=f"batch_stage_jobs.select(exists:{stage})",
    )
    if existing.data:
        return
    _sb_execute(
        supabase.table("batch_stage_jobs").insert(
            {
                "organization_id": org_id,
                "library_id": library_id,
                "batch_id": batch_id,
                "stage": stage,
                "status": "queued",
                "attempts": 0,
                "payload": {},
                "progress_current": 0,
                "progress_total": int(progress_total or 0),
            }
        ),
        context=f"batch_stage_jobs.insert({stage})",
    )


def _embedding_done_for_library(library_id: str) -> bool:
    total_batches = _get_total_batches(library_id)
    if total_batches <= 0:
        return False
    return _count_done_stage_jobs(library_id, "embedding") >= total_batches


def run_embedding_stage_job(stage_job: dict):
    library_id = stage_job["library_id"]
    org_id = stage_job["organization_id"]
    batch_id = stage_job["batch_id"]
    job_id = stage_job["id"]

    st = _get_library_pipeline_status(library_id)
    if st is None or st in _PIPELINE_ABORT_STATUSES:
        # Release the job so it doesn't stay stuck in "running" if we were canceled/failed mid-claim.
        try:
            _mark_stage_job_canceled(job_id, f"Aborted (library pipeline_status={st or 'missing'}).")
        except Exception:
            pass
        return

    batch = _sb_execute(
        supabase.table("library_batches").select("doc_ids, doc_count").eq("id", batch_id).single(),
        context="library_batches.select(doc_ids)",
    )
    doc_ids = (batch.data or {}).get("doc_ids") or []
    total = int(stage_job.get("progress_total") or (batch.data or {}).get("doc_count") or len(doc_ids) or 0)
    current = int(stage_job.get("progress_current") or 0)
    progress_every = int(os.getenv("STAGE_PROGRESS_EVERY", "2"))

    # Keep UI stable.
    _sb_execute(
        supabase.table("libraries").update({"pipeline_status": "running", "pipeline_stage": "embedding"}).eq(
            "id", library_id
        ),
        context="libraries.update(stage.embedding)",
    )

    table_name = os.getenv("EMBED_TABLE", "chunk_embeddings").strip() or "chunk_embeddings"
    model_id = os.getenv("EMBED_MODEL", "BAAI/bge-large-en-v1.5")

    try:
        inserted_total = 0
        missing_chunks_docs: list[str] = []
        for doc_id in doc_ids:
            st = _get_library_pipeline_status(library_id)
            if st is None or st in _PIPELINE_ABORT_STATUSES:
                try:
                    _mark_stage_job_canceled(job_id, f"Aborted mid-batch (library pipeline_status={st or 'missing'}).")
                except Exception:
                    pass
                return

            chunks_key = f"chunks/{org_id}/{library_id}/{doc_id}.json"
            chunks_doc = fetch_r2_json(chunks_key) or {}
            if not chunks_doc:
                # If chunking artifacts are missing, embedding cannot proceed correctly.
                # Track and continue so we can fail the batch if nothing was embedded at all.
                missing_chunks_docs.append(str(doc_id))
            chunks = chunks_doc.get("chunks") or []
            if not isinstance(chunks, list) or not chunks:
                current += 1
                if current % progress_every == 0:
                    _sb_execute(
                        supabase.table("batch_stage_jobs").update(
                            {"progress_current": current, "progress_total": total}
                        ).eq("id", job_id),
                        context="batch_stage_jobs.update(embedding.progress)",
                    )
                continue

            texts = []
            metas = []
            for ch in chunks:
                if not isinstance(ch, dict):
                    continue
                emb_text = str(ch.get("embedding_text") or ch.get("text") or "").strip()
                if not emb_text:
                    continue
                texts.append(emb_text)
                metas.append(ch)

            vecs = _embed_texts(texts) if texts else []
            rows = []
            for ch, vec in zip(metas, vecs):
                chunk_id = str(ch.get("chunk_id") or "")
                if not chunk_id:
                    continue
                rows.append(
                    {
                        "organization_id": org_id,
                        "library_id": library_id,
                        "doc_id": doc_id,
                        "chunk_id": chunk_id,
                        "chunk_index": int(ch.get("chunk_index") or 0),
                        "page_start": int(ch.get("page_start") or 0),
                        "page_end": int(ch.get("page_end") or 0),
                        "section_heading": ch.get("section_heading"),
                        "text": ch.get("text"),
                        "context_prefix": ch.get("context_prefix"),
                        "embedding_text": ch.get("embedding_text"),
                        "embedding_model": model_id,
                        "embedding_dim": len(vec) if isinstance(vec, list) else None,
                        "embedding": vec,
                        "visual_ids": ch.get("visual_ids") or [],
                        "visual_keys": ch.get("visual_keys") or [],
                        "updated_at": now_iso(),
                    }
                )

            if rows:
                chunk_size = int(os.getenv("EMBED_UPSERT_CHUNK", "200"))
                for i in range(0, len(rows), chunk_size):
                    part = rows[i : i + chunk_size]
                    _sb_execute(
                        supabase.table(table_name).upsert(part, on_conflict="chunk_id"),
                        context=f"{table_name}.upsert",
                    )
                inserted_total += len(rows)

            current += 1
            if current % progress_every == 0:
                _sb_execute(
                    supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                        "id", job_id
                    ),
                    context="batch_stage_jobs.update(embedding.progress)",
                )

        # If we produced no embeddings for the entire batch, mark failed so clustering doesn't run on empty state.
        if inserted_total <= 0:
            msg = "No embeddings were produced for this batch."
            if missing_chunks_docs:
                msg += f" Missing chunk artifacts for {len(missing_chunks_docs)}/{len(doc_ids)} docs (check chunking/R2)."
            _sb_execute(
                supabase.table("batch_stage_jobs").update(
                    {"status": "failed", "last_error": msg, "finished_at": now_iso()}
                ).eq("id", job_id),
                context="batch_stage_jobs.update(embedding.failed.empty)",
            )
            _sb_execute(
                supabase.table("libraries").update(
                    {
                        "pipeline_status": "failed",
                        "pipeline_stage": "embedding",
                        "pipeline_error": msg,
                        "status": "error",
                    }
                ).eq("id", library_id),
                context="libraries.update(embedding.failed.empty)",
            )
            raise RuntimeError(msg)

        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "done", "finished_at": now_iso(), "progress_current": total, "progress_total": total}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(embedding.done)",
        )

        _update_library_progress(library_id)
        _maybe_finalize_pipeline(library_id)
    except Exception as exc:
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": str(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(embedding.failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "embedding",
                    "pipeline_error": str(exc),
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(embedding.failed)",
        )
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in embedding: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("EMBED_IDLE_LIMIT", "0"))
    # idle_limit=0 means "never exit" (better for long pipelines where downstream jobs appear later).
    print(f"[{WORKER_ID}] ready (idle_limit={'never' if idle_limit <= 0 else idle_limit})")
    while True:
        job = claim_embedding_stage_job(WORKER_ID)
        if not job:
            idle += 1
            if idle_limit > 0 and idle >= idle_limit:
                print("No embedding jobs remaining. Exiting.")
                return
            time.sleep(2)
            continue
        idle = 0
        run_embedding_stage_job(job)


if __name__ == "__main__":
    worker_loop()
