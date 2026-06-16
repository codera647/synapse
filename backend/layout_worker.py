import io
import json
import os
import random
import queue
import tempfile
import threading
import time
from datetime import datetime, timezone

import boto3
import fitz  # PyMuPDF
import numpy as np
from PIL import Image
from env_bootstrap import load_env
from supabase import create_client

# Note: in Colab this file is written by the notebook via `%%writefile layout_worker.py`.
load_env()

# Reduce CUDA memory fragmentation (must be set before importing torch in the worker).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

WORKER_ID = os.getenv("WORKER_ID", "layout-1")


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
    # Supabase is fronted by Cloudflare; under load / large bodies it can return an HTML block or
    # challenge page (403/5xx/1xxx) instead of JSON. Transient -> retry. (Genuine RLS 403s come back
    # as JSON like "permission denied"/42501, which won't match these HTML/Cloudflare markers.)
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
    if "connection reset" in m or "connection aborted" in m or "remotedisconnected" in m:
        return True
    if "timeout" in m or "timed out" in m:
        return True
    if "too many requests" in m or " 429" in m:
        return True
    try:
        if exc.args and isinstance(exc.args[0], dict):
            code = str(exc.args[0].get("code") or "")
            details = str(exc.args[0].get("details") or "").lower()
            if code in {"403", "429", "502", "503", "504", "520", "521", "522", "524", "1015", "1020"}:
                return True
            if ("<!doctype html" in details or "<html" in details or "cloudflare" in details
                    or "bad gateway" in details or "web server is down" in details):
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
    # Guard with eq(status,running) to avoid overwriting failed/done rows.
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
    """
    Create the batch stage job iff it doesn't already exist.
    Avoids upsert resetting status for an already-running/done job.
    """
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


def _enqueue_after_layout(org_id: str, library_id: str, batch_id: str, progress_total: int):
    """
    After layout_parser completes, fan-out into extraction stages in parallel.
    """
    stages = _pipeline_stages()
    try:
        idx = stages.index("layout_parser")
    except ValueError:
        return

    # Only stages that appear after layout_parser are considered.
    after = set(stages[idx + 1 :])
    fanout = [s for s in _parallel_extraction_stages() if s in after]
    if fanout:
        for st in fanout:
            _ensure_stage_job_exists(org_id, library_id, batch_id, st, progress_total)
        return

    # Fallback to sequential enqueue if no fanout stages are configured.
    if idx < len(stages) - 1:
        next_stage = stages[idx + 1]
        if next_stage:
            _ensure_stage_job_exists(org_id, library_id, batch_id, next_stage, progress_total)


# DocLayout-YOLO detector. Lazy-loaded on first job so uvicorn can boot cleanly.
_yolo_model = None
_yolo_device = None


def get_yolo():
    global _yolo_model, _yolo_device
    if _yolo_model is not None:
        return _yolo_model, _yolo_device

    try:
        import torch

        _yolo_device = "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        _yolo_device = "cpu"

    from huggingface_hub import hf_hub_download
    from doclayout_yolo import YOLOv10

    repo_id = os.getenv("DOCLAYOUT_YOLO_REPO", "juliozhao/DocLayout-YOLO-DocStructBench")
    filename = os.getenv("DOCLAYOUT_YOLO_FILENAME", "doclayout_yolo_docstructbench_imgsz1024.pt")
    weights_path = hf_hub_download(repo_id=repo_id, filename=filename)

    _yolo_model = YOLOv10(weights_path)
    return _yolo_model, _yolo_device


def claim_layout_stage_job(worker_id: str):
    # Gate claiming: layout_parser should only run after sync is done for the batch.
    jobs = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "layout_parser")
        .eq("status", "queued")
        .order("created_at")
        .limit(int(os.getenv("CLAIM_SCAN_LIMIT", "25"))),
        context="batch_stage_jobs.select(layout_parser.queued)",
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
        .eq("stage", "sync")
        .eq("status", "done"),
        context="batch_stage_jobs.select(sync.done.for_layout)",
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
        context="batch_stage_jobs.update(layout_parser.claim)",
    )
    if not claimed.data:
        return None
    return claimed.data[0]


def fetch_r2_bytes(key: str) -> bytes:
    obj = s3.get_object(Bucket=R2_BUCKET, Key=key)
    return obj["Body"].read()


def put_r2_json(key: str, payload: dict):
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
    )


def render_pages(pdf_bytes: bytes, max_pages: int | None = None):
    # Backwards-compatible helper (renders all pages). Prefer chunked rendering for large PDFs.
    scale = float(os.getenv("LAYOUT_RENDER_SCALE", "1.5"))
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    n = doc.page_count
    if max_pages is not None:
        n = min(n, max_pages)
    pages = []
    for i in range(n):
        page = doc.load_page(i)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        pages.append((i, np.array(img)))
    return pages


def render_pages_chunked(pdf_bytes: bytes, chunk_pages: int):
    """
    Render pages in chunks to keep RAM stable and reduce peak memory for large PDFs.
    """
    scale = float(os.getenv("LAYOUT_RENDER_SCALE", "1.5"))
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    n = doc.page_count
    if chunk_pages <= 0:
        chunk_pages = 1

    for offset in range(0, n, chunk_pages):
        pages = []
        end = min(n, offset + chunk_pages)
        for i in range(offset, end):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
            img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            pages.append((i, np.array(img)))
        yield pages


def detect_layout(pages):
    model, device = get_yolo()
    page_indices = [p[0] for p in pages]

    imgsz = int(os.getenv("LAYOUT_IMGSZ", "768"))
    conf = float(os.getenv("LAYOUT_CONF", "0.2"))
    batch_pages = int(os.getenv("LAYOUT_BATCH_PAGES", "16"))
    if batch_pages <= 0:
        batch_pages = 1

    def _predict(inputs):
        kwargs = {"imgsz": imgsz, "conf": conf, "device": device}
        try:
            kwargs["half"] = bool(int(os.getenv("LAYOUT_HALF", "1")))
        except Exception:
            pass

        try:
            return model.predict(inputs, **kwargs)
        except TypeError:
            # Some wrappers don't accept `half`.
            kwargs.pop("half", None)
            return model.predict(inputs, **kwargs)

    results = []

    # Try in-memory inference first (much faster: avoids writing PNGs to disk).
    # If the wrapper doesn't support it, we fall back to temp PNG files.
    use_temp_files = False
    try:
        # Use PIL images to keep memory smaller than raw NumPy in some backends.
        sample_imgs = [Image.fromarray(p[1]) for p in pages[:1]]
        _ = _predict(sample_imgs)
    except Exception:
        use_temp_files = True

    if not use_temp_files:
        pil_images = [Image.fromarray(image_np) for _, image_np in pages]
        for offset in range(0, len(pil_images), batch_pages):
            chunk_imgs = pil_images[offset : offset + batch_pages]
            chunk_page_indices = page_indices[offset : offset + batch_pages]
            det_res = _predict(chunk_imgs)

            for page_index, r in zip(chunk_page_indices, det_res):
                blocks = []
                boxes = getattr(r, "boxes", None)
                names = getattr(r, "names", None)

                if boxes is not None and getattr(boxes, "xyxy", None) is not None:
                    xyxy = boxes.xyxy
                    confs = getattr(boxes, "conf", None)
                    clss = getattr(boxes, "cls", None)
                    try:
                        xyxy = xyxy.cpu().numpy()
                        confs = confs.cpu().numpy() if confs is not None else None
                        clss = clss.cpu().numpy().astype(int) if clss is not None else None
                    except Exception:
                        pass

                    for i, bb in enumerate(xyxy):
                        cls_id = int(clss[i]) if clss is not None else -1
                        label = names.get(cls_id, str(cls_id)) if isinstance(names, dict) else str(cls_id)
                        score = float(confs[i]) if confs is not None else 1.0
                        x1, y1, x2, y2 = [float(v) for v in bb]
                        blocks.append({"type": label, "score": score, "bbox": [x1, y1, x2, y2]})

                results.append({"page": int(page_index), "blocks": blocks})

            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        return results

    # Fallback: temp PNG files.
    with tempfile.TemporaryDirectory() as td:
        paths = []
        for page_index, image_np in pages:
            p = os.path.join(td, f"page_{page_index}.png")
            Image.fromarray(image_np).save(p)
            paths.append(p)

        for offset in range(0, len(paths), batch_pages):
            chunk_paths = paths[offset : offset + batch_pages]
            chunk_page_indices = page_indices[offset : offset + batch_pages]
            det_res = _predict(chunk_paths)

            for page_index, r in zip(chunk_page_indices, det_res):
                blocks = []
                boxes = getattr(r, "boxes", None)
                names = getattr(r, "names", None)

                if boxes is not None and getattr(boxes, "xyxy", None) is not None:
                    xyxy = boxes.xyxy
                    confs = getattr(boxes, "conf", None)
                    clss = getattr(boxes, "cls", None)
                    try:
                        xyxy = xyxy.cpu().numpy()
                        confs = confs.cpu().numpy() if confs is not None else None
                        clss = clss.cpu().numpy().astype(int) if clss is not None else None
                    except Exception:
                        pass

                    for i, bb in enumerate(xyxy):
                        cls_id = int(clss[i]) if clss is not None else -1
                        label = names.get(cls_id, str(cls_id)) if isinstance(names, dict) else str(cls_id)
                        score = float(confs[i]) if confs is not None else 1.0
                        x1, y1, x2, y2 = [float(v) for v in bb]
                        blocks.append({"type": label, "score": score, "bbox": [x1, y1, x2, y2]})

                results.append({"page": int(page_index), "blocks": blocks})

            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        return results


def detect_layout_pil(page_indices, pil_images):
    """
    Same as detect_layout(), but takes PIL images directly to avoid extra conversions and disk writes.
    Falls back to temp files if the wrapper doesn't accept in-memory images.
    """
    model, device = get_yolo()

    imgsz = int(os.getenv("LAYOUT_IMGSZ", "768"))
    conf = float(os.getenv("LAYOUT_CONF", "0.2"))
    batch_pages = int(os.getenv("LAYOUT_BATCH_PAGES", "16"))
    if batch_pages <= 0:
        batch_pages = 1

    def _predict(inputs):
        kwargs = {"imgsz": imgsz, "conf": conf, "device": device}
        try:
            kwargs["half"] = bool(int(os.getenv("LAYOUT_HALF", "1")))
        except Exception:
            pass
        try:
            return model.predict(inputs, **kwargs)
        except TypeError:
            kwargs.pop("half", None)
            return model.predict(inputs, **kwargs)

    results = []

    use_temp_files = False
    try:
        if pil_images:
            _ = _predict([pil_images[0]])
    except Exception:
        use_temp_files = True

    if not use_temp_files:
        for offset in range(0, len(pil_images), batch_pages):
            chunk_imgs = pil_images[offset : offset + batch_pages]
            chunk_page_indices = page_indices[offset : offset + batch_pages]
            det_res = _predict(chunk_imgs)

            for page_index, r in zip(chunk_page_indices, det_res):
                blocks = []
                boxes = getattr(r, "boxes", None)
                names = getattr(r, "names", None)

                if boxes is not None and getattr(boxes, "xyxy", None) is not None:
                    xyxy = boxes.xyxy
                    confs = getattr(boxes, "conf", None)
                    clss = getattr(boxes, "cls", None)
                    try:
                        xyxy = xyxy.cpu().numpy()
                        confs = confs.cpu().numpy() if confs is not None else None
                        clss = clss.cpu().numpy().astype(int) if clss is not None else None
                    except Exception:
                        pass

                    for i, bb in enumerate(xyxy):
                        cls_id = int(clss[i]) if clss is not None else -1
                        label = names.get(cls_id, str(cls_id)) if isinstance(names, dict) else str(cls_id)
                        score = float(confs[i]) if confs is not None else 1.0
                        x1, y1, x2, y2 = [float(v) for v in bb]
                        blocks.append({"type": label, "score": score, "bbox": [x1, y1, x2, y2]})

                results.append({"page": int(page_index), "blocks": blocks})

            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        return results

    # Fallback: temp PNG files.
    with tempfile.TemporaryDirectory() as td:
        paths = []
        for page_index, img in zip(page_indices, pil_images):
            p = os.path.join(td, f"page_{page_index}.png")
            img.save(p)
            paths.append(p)

        for offset in range(0, len(paths), batch_pages):
            chunk_paths = paths[offset : offset + batch_pages]
            chunk_page_indices = page_indices[offset : offset + batch_pages]
            det_res = _predict(chunk_paths)

            for page_index, r in zip(chunk_page_indices, det_res):
                blocks = []
                boxes = getattr(r, "boxes", None)
                names = getattr(r, "names", None)

                if boxes is not None and getattr(boxes, "xyxy", None) is not None:
                    xyxy = boxes.xyxy
                    confs = getattr(boxes, "conf", None)
                    clss = getattr(boxes, "cls", None)
                    try:
                        xyxy = xyxy.cpu().numpy()
                        confs = confs.cpu().numpy() if confs is not None else None
                        clss = clss.cpu().numpy().astype(int) if clss is not None else None
                    except Exception:
                        pass

                    for i, bb in enumerate(xyxy):
                        cls_id = int(clss[i]) if clss is not None else -1
                        label = names.get(cls_id, str(cls_id)) if isinstance(names, dict) else str(cls_id)
                        score = float(confs[i]) if confs is not None else 1.0
                        x1, y1, x2, y2 = [float(v) for v in bb]
                        blocks.append({"type": label, "score": score, "bbox": [x1, y1, x2, y2]})

                results.append({"page": int(page_index), "blocks": blocks})

            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        return results


def detect_layout_for_pdf_streaming(pdf_bytes: bytes):
    """
    Producer/consumer pipeline:
    - Producer thread renders PDF pages to PIL images in chunks and pushes into a bounded queue.
    - Consumer (GPU) batches those chunks and runs YOLO, overlapping CPU render with GPU inference.
    """
    chunk_pages = int(os.getenv("LAYOUT_RENDER_CHUNK_PAGES", "8"))
    if chunk_pages <= 0:
        chunk_pages = 8

    max_queue_chunks = int(os.getenv("LAYOUT_PIPELINE_QUEUE_CHUNKS", "6"))
    if max_queue_chunks <= 0:
        max_queue_chunks = 6

    q: queue.Queue = queue.Queue(maxsize=max_queue_chunks)
    sentinel = object()

    def producer():
        try:
            scale = float(os.getenv("LAYOUT_RENDER_SCALE", "1.5"))
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            n = doc.page_count
            for offset in range(0, n, chunk_pages):
                end = min(n, offset + chunk_pages)
                idxs = []
                imgs = []
                for i in range(offset, end):
                    page = doc.load_page(i)
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
                    idxs.append(i)
                    imgs.append(img)
                q.put((idxs, imgs))
        finally:
            q.put(sentinel)

    t = threading.Thread(target=producer, daemon=True)
    t.start()

    layout_all = []
    while True:
        item = q.get()
        if item is sentinel:
            break
        idxs, imgs = item
        layout_all.extend(detect_layout_pil(idxs, imgs))

    t.join(timeout=30)
    return layout_all


def _pipeline_stages():
    import pipeline_config
    return pipeline_config.pipeline_stages()


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


def _update_library_progress(library_id: str):
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
        res = _sb_execute(
            supabase.table("batch_stage_jobs")
            .select("id", count="exact")
            .eq("library_id", library_id)
            .eq("stage", st)
            .eq("status", "done"),
            context=f"batch_stage_jobs.count(done:{st})",
        )
        done_total += int(res.count or 0)

    denom = max(1, total_batches * len(stages))
    progress = round((done_total / denom) * 100, 2)

    # `completed_batches` represents fully-processed batches (i.e. reached the last stage),
    # not "batches completed in the current stage".
    completed_batches = _count_done_stage_jobs(library_id, _pipeline_stages()[-1])

    _sb_execute(
        supabase.table("libraries").update(
            {
                "pipeline_status": "running",
                "pipeline_stage": "layout_parser",
                "completed_batches": completed_batches,
                "pipeline_progress_percent": progress,
            }
        ).eq("id", library_id),
        context="libraries.update(layout_progress)",
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
        res = _sb_execute(
            supabase.table("batch_stage_jobs")
            .select("id", count="exact")
            .eq("library_id", library_id)
            .eq("stage", st)
            .eq("status", "done"),
            context=f"batch_stage_jobs.count(done:{st}.finalize)",
        )
        if int(res.count or 0) < total_batches:
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


def run_layout_stage_job(stage_job):
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
        supabase.table("libraries").update({"pipeline_status": "running", "pipeline_stage": "layout_parser"}).eq(
            "id", library_id
        ),
        context="libraries.update(stage=layout_parser)",
    )

    try:
        for doc_id in doc_ids:
            # Stop early if canceled/failed (so other workers don't keep burning GPU/CPU after a failure).
            st = _get_library_pipeline_status(library_id)
            if st is None or st in _PIPELINE_ABORT_STATUSES:
                _mark_stage_job_canceled(job_id, f"Aborted mid-batch (library pipeline_status={st or 'missing'}).")
                return

            doc = _sb_execute(
                supabase.table("documents").select("id, storage_path_raw, mime_type").eq("id", doc_id).single(),
                context="documents.select(storage_path_raw)",
            )
            if not doc.data:
                continue
            key = doc.data.get("storage_path_raw")
            if not key:
                continue
            mime = (doc.data.get("mime_type") or "").lower()
            if "pdf" not in mime:
                current += 1
                _sb_execute(
                    supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                        "id", job_id
                    ),
                    context="batch_stage_jobs.update(progress.nonpdf)",
                )
                continue

            pdf_bytes = fetch_r2_bytes(key)
            layout = detect_layout_for_pdf_streaming(pdf_bytes)

            out_key = f"layout/{org_id}/{library_id}/{doc_id}.json"
            # Persist render_scale so downstream stages (cropping / bbox->pdf conversions) stay consistent.
            put_r2_json(
                out_key,
                {
                    "doc_id": doc_id,
                    "library_id": library_id,
                    "organization_id": org_id,
                    "created_at": now_iso(),
                    "render_scale": float(os.getenv("LAYOUT_RENDER_SCALE", "1.5")),
                    "layout": layout,
                },
            )

            current += 1
            _sb_execute(
                supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                    "id", job_id
                ),
                context="batch_stage_jobs.update(progress)",
            )

        # Cancel guard: if the user cancelled while this batch ran, stop here. Mark THIS job
        # canceled (resume re-queues it) and do NOT mark done / enqueue the next stage / flip the
        # library back to running. cancel_requested is durable, so this is race-safe.
        _abort_st = _get_library_pipeline_status(library_id)
        if _abort_st is None or _abort_st in _PIPELINE_ABORT_STATUSES:
            _mark_stage_job_canceled(job_id, f"Aborted after batch (library status={_abort_st or 'missing'}).")
            return
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {
                    "status": "done",
                    "finished_at": now_iso(),
                    "progress_current": total,
                    "progress_total": total,
                }
            ).eq("id", job_id),
            context="batch_stage_jobs.update(done)",
        )

        # Enqueue extraction fanout (text_extraction + image_captioning) in parallel.
        _enqueue_after_layout(org_id=org_id, library_id=library_id, batch_id=batch_id, progress_total=total)

        _update_library_progress(library_id)
        _maybe_finalize_pipeline(library_id)

    except Exception as exc:
        from errors import friendly_error
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": friendly_error(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "layout_parser",
                    "pipeline_error": friendly_error(exc),
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(layout_failed)",
        )
        # Fail-fast: prevent any remaining queued work for this library from being picked up.
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in layout_parser: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("LAYOUT_IDLE_LIMIT", "60"))
    print(f"[{WORKER_ID}] ready (idle_limit={idle_limit})")
    while True:
        job = claim_layout_stage_job(WORKER_ID)
        if not job:
            idle += 1
            if idle >= idle_limit:
                print("No layout jobs remaining. Exiting.")
                return
            time.sleep(2)
            continue
        idle = 0
        run_layout_stage_job(job)


if __name__ == "__main__":
    worker_loop()
