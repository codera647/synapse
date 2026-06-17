import os
import json
import base64
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
    import pipeline_config
    return pipeline_config.pipeline_stages()


def _is_retryable_supabase_error(exc: Exception) -> bool:
    msg = str(exc) or ""
    m = msg.lower()
    if "json could not be generated" in m:
        return True
    # Supabase is fronted by Cloudflare. Under load / large bodies it can return an HTML block or
    # challenge page (403/5xx/1xxx) instead of JSON. These are transient — retry, don't fail the
    # batch. (A genuine RLS 403 returns JSON like "permission denied"/42501, which won't match here.)
    if "<!doctype html" in m or "<html" in m:
        return True
    if "cloudflare" in m or "just a moment" in m or "attention required" in m or "access denied" in m:
        return True
    if "no-js ie6 oldie" in m or "error code 1020" in m or "error code 1015" in m or "error code 1010" in m:
        return True
    if "bad gateway" in m or "error code 502" in m or " 502" in m:
        return True
    if "service unavailable" in m or "error code 503" in m or " 503" in m:
        return True
    if "gateway timeout" in m or "error code 504" in m or " 504" in m:
        return True
    if "web server is down" in m or "error code 521" in m or " 521" in m:
        return True
    if "error code 520" in m or "error code 522" in m or "error code 524" in m:
        return True
    if "timeout" in m or "timed out" in m:
        return True
    if "too many requests" in m or " 429" in m:
        return True
    if "connection reset" in m or "connection aborted" in m or "remotedisconnected" in m:
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


_PIPELINE_ABORT_STATUSES = {"canceled"}  # abort only on USER cancel — a sibling batch's
# failure must NOT stop other running workers (they may be processing fine).


def _get_library_pipeline_status(library_id: str) -> str | None:
    res = _sb_execute(
        supabase.table("libraries").select("pipeline_status, cancel_requested").eq("id", library_id).single(),
        context="libraries.select(pipeline_status)",
    )
    if not res.data:
        return None
    # A user cancel sets cancel_requested=true durably; workers never write that column, so an
    # in-flight worker cannot resurrect the pipeline by overwriting pipeline_status. Treat as canceled.
    if res.data.get("cancel_requested"):
        return "canceled"
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


# ── WAF-resilient embedding writes ───────────────────────────────────────────────────
# Supabase's REST API is fronted by Cloudflare. A chunk whose text matches a WAF attack
# pattern (code/HTML/SQL — common for code files) makes Cloudflare 403 the whole POST with
# an HTML page, so the batch fails forever (the same body always re-trips the rule). When we
# detect that, we binary-split the batch to isolate the offending row, then send its text
# fields base64-encoded through an RPC the WAF can't pattern-match (decoded server-side, so
# FTS/tsv stay correct). See docs/supabase-chunk-text-b64.sql.

_B64_TEXT_FIELDS = ("text", "embedding_text", "context_prefix", "section_heading", "locator")


def _looks_like_waf_block(exc: Exception) -> bool:
    m = (str(exc) or "").lower()
    return (
        "json could not be generated" in m
        or "<!doctype html" in m
        or "<html" in m
        or "no-js ie6 oldie" in m
        or "cloudflare" in m
        or "access denied" in m
        or "just a moment" in m
        or "attention required" in m
    )


def _upsert_one_via_b64(table_name: str, row: dict, attempts: int) -> None:
    """Single row the WAF keeps blocking: insert it with the text fields blanked (no attack
    patterns in the body), then fill the real text via the base64 RPC."""
    safe = dict(row)
    encoded: dict = {}
    for f in _B64_TEXT_FIELDS:
        v = safe.get(f)
        if v:
            encoded[f] = base64.b64encode(str(v).encode("utf-8")).decode("ascii")
            # Blank NOT NULL text columns to "", nullable ones to None, so the body is clean.
            safe[f] = "" if f in ("text", "embedding_text") else None
    _sb_execute(
        supabase.table(table_name).upsert(safe, on_conflict="chunk_id"),
        context=f"{table_name}.upsert(blanked)",
        max_attempts=attempts,
    )
    if encoded:
        _sb_execute(
            supabase.rpc(
                "set_chunk_text_b64",
                {
                    "p_chunk_id": str(row.get("chunk_id")),
                    "p_text_b64": encoded.get("text"),
                    "p_embedding_text_b64": encoded.get("embedding_text"),
                    "p_context_prefix_b64": encoded.get("context_prefix"),
                    "p_section_heading_b64": encoded.get("section_heading"),
                    "p_locator_b64": encoded.get("locator"),
                },
            ),
            context="rpc.set_chunk_text_b64",
            max_attempts=attempts,
        )
        print(f"[embed] WAF-blocked chunk {row.get('chunk_id')} written via base64 RPC fallback")


def _upsert_embeddings_resilient(table_name: str, rows: list, attempts: int, _splitting: bool = False) -> None:
    if not rows:
        return
    # Full retries on the first try (handles transient load blocks); once we KNOW it's a content
    # block we're splitting, fail fast (2 attempts) so isolation stays quick.
    use_attempts = 2 if _splitting else attempts
    try:
        _sb_execute(
            supabase.table(table_name).upsert(rows, on_conflict="chunk_id"),
            context=f"{table_name}.upsert",
            max_attempts=use_attempts,
        )
        return
    except Exception as exc:
        if not _looks_like_waf_block(exc):
            raise
    # WAF block: isolate the offending row(s) and use the base64 path for them.
    if len(rows) > 1:
        mid = len(rows) // 2
        _upsert_embeddings_resilient(table_name, rows[:mid], attempts, _splitting=True)
        _upsert_embeddings_resilient(table_name, rows[mid:], attempts, _splitting=True)
        return
    _upsert_one_via_b64(table_name, rows[0], attempts)


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
                "progress_current": 0,  # reset on (re)claim so resume counts from 0, not 9/7
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

    # Never report a misleading 100% while any stage job is FAILED — flip to failed instead.
    failed = _sb_execute(
        supabase.table("batch_stage_jobs").select("id").eq("library_id", library_id).eq("status", "failed").limit(1),
        context="batch_stage_jobs.select(failed.guard)",
    )
    if failed.data:
        _sb_execute(
            supabase.table("libraries").update({"pipeline_status": "failed", "status": "error"}).eq("id", library_id),
            context="libraries.update(failed.guard)",
        )
        return

    stages = _pipeline_stages()
    # If clustering is part of the configured pipeline, let the clustering worker finalize.
    if "clustering" in stages:
        return

    # Defer if clustering jobs exist (e.g. backfilled, or a stage-config mismatch) but aren't all
    # done — prevents marking 100% completed while clustering is still pending/failed.
    cl = _sb_execute(
        supabase.table("batch_stage_jobs").select("status").eq("library_id", library_id).eq("stage", "clustering"),
        context="batch_stage_jobs.select(clustering.guard)",
    )
    if (cl.data or []) and any(r.get("status") != "done" for r in (cl.data or [])):
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
                "last_synced_at": finished,
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
                        "locator": ch.get("locator"),
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
                # Each row carries a 1024-dim vector; 200 rows is a multi-MB POST that can trip
                # Supabase's Cloudflare WAF (403 HTML). Keep batches small to stay under the radar,
                # and give these writes a longer retry window since a WAF block can last ~1 min.
                chunk_size = int(os.getenv("EMBED_UPSERT_CHUNK", "64"))
                upsert_attempts = int(os.getenv("EMBED_UPSERT_RETRIES", "10"))
                for i in range(0, len(rows), chunk_size):
                    part = rows[i : i + chunk_size]
                    _upsert_embeddings_resilient(table_name, part, upsert_attempts)
                inserted_total += len(rows)

            current += 1
            if current % progress_every == 0:
                _sb_execute(
                    supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                        "id", job_id
                    ),
                    context="batch_stage_jobs.update(embedding.progress)",
                )

        # No embeddings for the whole batch (its docs produced no chunks). Mark THIS batch failed
        # (resumable) and stop — but do NOT fail the library or cancel sibling batches. The other
        # batches finish normally; the pipeline finalizer marks the library failed-but-retryable only
        # once everything has settled. (A single doc with a bad/empty transcription no longer sinks
        # the whole run.)
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
            print(f"[embed] batch {job_id} produced 0 embeddings — marked failed; siblings continue. {msg}")
            try:
                _maybe_finalize_pipeline(library_id)
            except Exception:
                pass
            return

        # Cancel guard: if the user cancelled while this batch ran, stop here. Mark THIS job
        # canceled (resume re-queues it) and do NOT mark done / enqueue the next stage / flip the
        # library back to running. cancel_requested is durable, so this is race-safe.
        _abort_st = _get_library_pipeline_status(library_id)
        if _abort_st is None or _abort_st in _PIPELINE_ABORT_STATUSES:
            _mark_stage_job_canceled(job_id, f"Aborted after batch (library status={_abort_st or 'missing'}).")
            return
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "done", "finished_at": now_iso(), "progress_current": total, "progress_total": total}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(embedding.done)",
        )

        # Enqueue the next stage (e.g. clustering) for this batch — mirrors chunk -> embedding.
        # cluster_worker gates on all-embeddings-done and uses a per-library lock so only one
        # clustering job actually runs KMeans; the rest mark done. Without this enqueue the
        # clustering jobs never exist and the library stalls below 100%.
        _stages = _pipeline_stages()
        _idx = _stages.index("embedding") if "embedding" in _stages else -1
        if 0 <= _idx < len(_stages) - 1:
            _next_stage = _stages[_idx + 1]
            if _next_stage:
                _ensure_stage_job_exists(org_id, library_id, batch_id, _next_stage, total)

        _update_library_progress(library_id)
        _maybe_finalize_pipeline(library_id)
    except Exception as exc:
        from errors import friendly_error
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": friendly_error(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(embedding.failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "embedding",
                    "pipeline_error": friendly_error(exc),
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(embedding.failed)",
        )
        # One batch failing should NOT cancel sibling batches by default — they may be fine. Opt in
        # with PIPELINE_CASCADE_CANCEL=1 for fail-fast behavior.
        if os.getenv("PIPELINE_CASCADE_CANCEL", "0").strip().lower() in {"1", "true", "yes", "on"}:
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
