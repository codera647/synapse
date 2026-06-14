import json
import os
import random
import time
from datetime import datetime, timezone

import boto3
import fitz  # PyMuPDF
from env_bootstrap import load_env
from supabase import create_client

# Note: in Colab this file is written by the notebook via `%%writefile extraction_worker.py`.
load_env()

WORKER_ID = os.getenv("WORKER_ID", "extract-1")


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
    try:
        if exc.args and isinstance(exc.args[0], dict):
            code = str(exc.args[0].get("code") or "")
            details = str(exc.args[0].get("details") or "").lower()
            if code in {"502", "521", "429"}:
                return True
            if "bad gateway" in details or "web server is down" in details:
                return True
    except Exception:
        pass
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
        .update({"status": "canceled", "last_error": reason, "finished_at": now_iso()})
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


def put_r2_json(key: str, payload: dict):
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
    )


def _pipeline_stages():
    import pipeline_config
    return pipeline_config.pipeline_stages()


def _parallel_extraction_stages():
    import pipeline_config
    return pipeline_config.parallel_extraction_stages()


def _ensure_stage_job_exists(
    org_id: str,
    library_id: str,
    batch_id: str,
    stage: str,
    progress_total: int,
):
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


def _count_batch_stage_done(batch_id: str, stage: str) -> bool:
    resp = _sb_execute(
        supabase.table("batch_stage_jobs").select("id").eq("batch_id", batch_id).eq("stage", stage).eq("status", "done").limit(1),
        context=f"batch_stage_jobs.select(done:{stage})",
    )
    return bool(resp.data)


def _maybe_enqueue_next_after_parallel(org_id: str, library_id: str, batch_id: str, progress_total: int):
    """
    If this batch is part of the parallel extraction fanout, only enqueue the next stage
    after *all* parallel extraction stages are done.
    """
    stages = _pipeline_stages()
    parallel = [s for s in _parallel_extraction_stages() if s in stages]
    if not parallel:
        return

    # Only coordinate when both stages exist in the pipeline.
    if any(not _count_batch_stage_done(batch_id, st) for st in parallel):
        return

    # Enqueue the first stage that appears after the last parallel stage occurrence.
    last_idx = max(stages.index(st) for st in parallel)
    if last_idx < len(stages) - 1:
        next_stage = stages[last_idx + 1]
        if next_stage:
            _ensure_stage_job_exists(org_id, library_id, batch_id, next_stage, progress_total)


def claim_text_extraction_stage_job(worker_id: str):
    # Gate claiming: text_extraction should only run after layout_parser is done for the batch.
    jobs = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "text_extraction")
        .eq("status", "queued")
        .order("created_at")
        .limit(int(os.getenv("CLAIM_SCAN_LIMIT", "25"))),
        context="batch_stage_jobs.select(text_extraction.queued)",
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
        .eq("stage", "layout_parser")
        .eq("status", "done"),
        context="batch_stage_jobs.select(layout.done.for_text_extraction)",
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
        context="batch_stage_jobs.update(text_extraction.claim)",
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


def _stage_order(stage: str) -> int:
    stages = _pipeline_stages()
    try:
        return stages.index(stage)
    except ValueError:
        return 10_000


def _compute_next_stage(library_id: str) -> str:
    remaining = _sb_execute(
        supabase.table("batch_stage_jobs").select("stage, status").eq("library_id", library_id).neq("status", "done"),
        context="batch_stage_jobs.select(remaining)",
    )
    stages = [str(r.get("stage") or "") for r in (remaining.data or []) if isinstance(r, dict)]
    stages = [s for s in stages if s]
    if not stages:
        return _pipeline_stages()[-1]
    stages.sort(key=_stage_order)
    return stages[0]


def _update_library_progress(library_id: str, stage: str):
    lib = _sb_execute(
        supabase.table("libraries").select("total_batches").eq("id", library_id).single(),
        context="libraries.select(total_batches)",
    )
    total_batches = int((lib.data or {}).get("total_batches") or 0)
    if total_batches <= 0:
        return

    stages = _pipeline_stages()
    done_total = 0
    for st in stages:
        done_total += _count_done_stage_jobs(library_id, st)

    denom = max(1, total_batches * len(stages))
    progress = round((done_total / denom) * 100, 2)

    # `completed_batches` represents fully-processed batches (i.e. reached the last stage),
    # not "batches completed in the current stage".
    completed_batches = _count_done_stage_jobs(library_id, _pipeline_stages()[-1])

    next_stage = _compute_next_stage(library_id)
    _sb_execute(
        supabase.table("libraries").update(
            {
                "pipeline_status": "running",
                "pipeline_stage": next_stage,
                "completed_batches": completed_batches,
                "pipeline_progress_percent": progress,
            }
        ).eq("id", library_id),
        context="libraries.update(extraction_progress)",
    )


def _maybe_finalize_pipeline(library_id: str):
    lib = _sb_execute(
        supabase.table("libraries").select("total_batches").eq("id", library_id).single(),
        context="libraries.select(total_batches.finalize)",
    )
    total_batches = int((lib.data or {}).get("total_batches") or 0)
    if total_batches <= 0:
        return

    stages = _pipeline_stages()
    for st in stages:
        if _count_done_stage_jobs(library_id, st) < total_batches:
            return

    finished = now_iso()
    _sb_execute(
        supabase.table("libraries").update(
            {
                "status": "ready",
                "pipeline_status": "completed",
                "pipeline_stage": stages[-1],
                "pipeline_progress_percent": 100,
                "pipeline_error": None,
                "pipeline_finished_at": finished,
                "completed_batches": total_batches,
            }
        ).eq("id", library_id),
        context="libraries.update(pipeline.completed)",
    )


def _normalize_type(t: str) -> str:
    t = (t or "").strip().lower()
    # DocLayout-YOLO / DocStructBench labels can be a bit different than LayoutParser defaults.
    # Treat any text-like label as "text" so we actually extract most paragraphs.
    if t in {
        "text",
        "plain text",
        "title",
        "section header",
        "header",
        "footer",
        "caption",
        "footnote",
        "list",
        "reference",
        "references",
    }:
        return "text"
    if t in {"abandon", "ignore", "background"}:
        return "ignore"
    if t in {"table"}:
        return "table"
    if t in {"figure", "image", "graph"}:
        return "figure"
    return t or "unknown"


def _bbox_img_to_pdf(bbox_img, render_scale: float):
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox_img]
    except Exception:
        return None
    if render_scale <= 0:
        render_scale = 1.0
    return [x1 / render_scale, y1 / render_scale, x2 / render_scale, y2 / render_scale]


def _compute_links(page_blocks):
    # Simple heuristic: link each figure/table to the nearest text block beneath it with column overlap.
    # Returns list of link dicts.
    links = []
    text_blocks = [b for b in page_blocks if b.get("kind") == "text" and (b.get("text") or "").strip()]
    visual_blocks = [b for b in page_blocks if b.get("kind") in {"figure", "table"}]

    for vb in visual_blocks:
        vbbox = vb.get("bbox_pdf") or vb.get("bbox")
        if not vbbox:
            continue
        vx1, vy1, vx2, vy2 = vbbox
        best = None
        best_dy = None
        for tb in text_blocks:
            tbbox = tb.get("bbox_pdf") or tb.get("bbox")
            if not tbbox:
                continue
            tx1, ty1, tx2, ty2 = tbbox
            # must be below (or slightly above) and overlap in x (same column)
            overlap_x = min(vx2, tx2) - max(vx1, tx1)
            if overlap_x <= 0:
                continue
            dy = ty1 - vy2
            if dy < -10:  # allow tiny overlap, but avoid far-above paragraphs
                continue
            if dy > 200:  # too far away to be a caption
                continue
            if best_dy is None or dy < best_dy:
                best = tb
                best_dy = dy
        if best:
            links.append(
                {
                    "visual_block_id": vb["block_id"],
                    "caption_block_id": best["block_id"],
                    "relation": "caption",
                    "page": vb.get("page"),
                    "score": float(max(0.0, 1.0 - (best_dy or 0) / 200.0)),
                }
            )

    return links


def run_text_extraction_stage_job(stage_job):
    library_id = stage_job["library_id"]
    org_id = stage_job["organization_id"]
    batch_id = stage_job["batch_id"]
    job_id = stage_job["id"]

    st = _get_library_pipeline_status(library_id)
    if st is None or st in _PIPELINE_ABORT_STATUSES:
        _mark_stage_job_canceled(job_id, f"Aborted (library pipeline_status={st or 'missing'}).")
        return

    batch = _sb_execute(
        supabase.table("library_batches").select("doc_ids, doc_count").eq("id", batch_id).single(),
        context="library_batches.select(doc_ids)",
    )
    doc_ids = (batch.data or {}).get("doc_ids") or []
    total = int(stage_job.get("progress_total") or (batch.data or {}).get("doc_count") or len(doc_ids) or 0)
    current = int(stage_job.get("progress_current") or 0)

    _sb_execute(
        supabase.table("libraries").update({"pipeline_status": "running", "pipeline_stage": "text_extraction"}).eq(
            "id", library_id
        ),
        context="libraries.update(stage=text_extraction)",
    )

    # Load docs metadata for the batch in chunks (avoid 1 query per doc).
    docs_by_id: dict[str, dict] = {}
    fetch_chunk = int(os.getenv("DOC_FETCH_CHUNK", "100"))
    for i in range(0, len(doc_ids), fetch_chunk):
        chunk = doc_ids[i : i + fetch_chunk]
        resp = _sb_execute(
            # Include NOT NULL columns so our bulk upsert never attempts to insert a partial row.
            supabase.table("documents").select(
                "id, organization_id, library_id, title, gdrive_file_id, mime_type, file_size_bytes, status, storage_path_raw"
            ).in_("id", chunk),
            context="documents.select(batch)",
        )
        for d in resp.data or []:
            docs_by_id[d["id"]] = d

    progress_every = int(os.getenv("STAGE_PROGRESS_EVERY", "3"))
    min_chars = int(os.getenv("EXTRACT_MIN_CHARS", "20"))

    doc_updates = []
    doc_update_chunk = int(os.getenv("DOC_TEXT_UPSERT_CHUNK", "50"))

    try:
        for doc_id in doc_ids:
            # Stop early if canceled/failed (checked periodically via progress_every).
            if current % progress_every == 0:
                st = _get_library_pipeline_status(library_id)
                if st is None or st in _PIPELINE_ABORT_STATUSES:
                    _mark_stage_job_canceled(job_id, f"Aborted mid-batch (library pipeline_status={st or 'missing'}).")
                    return

            d = docs_by_id.get(doc_id) or {}
            key = d.get("storage_path_raw")
            mime = (d.get("mime_type") or "").lower()
            if not key or ("pdf" not in mime):
                current += 1
                if current % progress_every == 0:
                    _sb_execute(
                        supabase.table("batch_stage_jobs").update(
                            {"progress_current": current, "progress_total": total}
                        ).eq("id", job_id),
                        context="batch_stage_jobs.update(progress)",
                    )
                continue

            pdf_bytes = fetch_r2_bytes(key)
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")

            # Load layout artifact (optional but recommended).
            layout_key = f"layout/{org_id}/{library_id}/{doc_id}.json"
            layout = fetch_r2_json(layout_key) or {}
            render_scale = float(layout.get("render_scale") or os.getenv("LAYOUT_RENDER_SCALE", "1.5"))

            pages_layout = layout.get("layout") or []
            by_page = {int(p.get("page")): p for p in pages_layout if isinstance(p, dict) and "page" in p}

            out_pages = []
            all_links = []

            for page_index in range(doc.page_count):
                page = doc.load_page(page_index)
                page_info = by_page.get(page_index) or {}
                blocks = page_info.get("blocks") or []
                out_blocks = []

                for bi, b in enumerate(blocks):
                    btype = _normalize_type(b.get("type") if isinstance(b, dict) else "")
                    if btype == "ignore":
                        continue
                    bbox_img = (b.get("bbox") if isinstance(b, dict) else None) or None
                    bbox_pdf = _bbox_img_to_pdf(bbox_img, render_scale) if bbox_img else None

                    block_id = f"p{page_index}_b{bi}"
                    rec = {
                        "block_id": block_id,
                        "page": page_index,
                        "type": b.get("type") if isinstance(b, dict) else None,
                        "kind": btype,
                        "score": float((b.get("score") or 1.0) if isinstance(b, dict) else 1.0),
                        "bbox_img": bbox_img,
                        "bbox_pdf": bbox_pdf,
                    }

                    if btype == "text" and bbox_pdf:
                        x1, y1, x2, y2 = bbox_pdf
                        clip = fitz.Rect(x1, y1, x2, y2)
                        txt = (page.get_text("text", clip=clip) or "").strip()
                        rec["text"] = txt
                        rec["char_count"] = len(txt)
                        rec["needs_ocr"] = len(txt) < min_chars
                    elif btype in {"figure", "table"}:
                        rec["needs_caption"] = True
                    out_blocks.append(rec)

                out_pages.append({"page": page_index, "blocks": out_blocks})
                all_links.extend(_compute_links(out_blocks))

            out_key = f"text/{org_id}/{library_id}/{doc_id}.json"
            put_r2_json(
                out_key,
                {
                    "doc_id": doc_id,
                    "library_id": library_id,
                    "organization_id": org_id,
                    "created_at": now_iso(),
                    "render_scale": render_scale,
                    "layout_key": layout_key,
                    "source_pdf_key": key,
                    "pages": out_pages,
                    "links": all_links,
                },
            )

            # Use upsert for batch efficiency, but include required columns so we never attempt to insert
            # a partial row (which would violate NOT NULL constraints like organization_id/library_id/title).
            doc_updates.append(
                {
                    "id": doc_id,
                    "organization_id": d.get("organization_id") or org_id,
                    "library_id": d.get("library_id") or library_id,
                    "title": d.get("title") or doc_id,
                    "gdrive_file_id": d.get("gdrive_file_id"),
                    "mime_type": d.get("mime_type"),
                    "file_size_bytes": d.get("file_size_bytes"),
                    "status": d.get("status") or "pending",
                    "storage_path_raw": d.get("storage_path_raw") or key,
                    "storage_path_text": out_key,
                }
            )
            if len(doc_updates) >= doc_update_chunk:
                _sb_execute(
                    supabase.table("documents").upsert(doc_updates, on_conflict="id"),
                    context="documents.upsert(storage_path_text)",
                )
                doc_updates = []

            current += 1
            if current % progress_every == 0:
                _sb_execute(
                    supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                        "id", job_id
                    ),
                    context="batch_stage_jobs.update(progress)",
                )

        if doc_updates:
            _sb_execute(
                supabase.table("documents").upsert(doc_updates, on_conflict="id"),
                context="documents.upsert(storage_path_text.final)",
            )

        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "done", "finished_at": now_iso(), "progress_current": total, "progress_total": total}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(done)",
        )

        # Captioning runs in parallel with text extraction; only fan-in to next stage when both are done.
        _maybe_enqueue_next_after_parallel(org_id=org_id, library_id=library_id, batch_id=batch_id, progress_total=total)

        _update_library_progress(library_id, stage="text_extraction")
        _maybe_finalize_pipeline(library_id)

    except Exception as exc:
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": str(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "text_extraction",
                    "pipeline_error": str(exc),
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(text_extraction.failed)",
        )
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in text_extraction: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("EXTRACT_IDLE_LIMIT", "60"))
    print(f"[{WORKER_ID}] ready (idle_limit={idle_limit})")
    while True:
        job = claim_text_extraction_stage_job(WORKER_ID)
        if not job:
            idle += 1
            if idle >= idle_limit:
                print("No extraction jobs remaining. Exiting.")
                return
            time.sleep(2)
            continue
        idle = 0
        run_text_extraction_stage_job(job)


if __name__ == "__main__":
    worker_loop()
