"""
backend/pipeline_api.py

HTTP API for pipeline control + storage maintenance, mounted by app.py.

Design note — this is ADDITIVE. Synapse stays queue-driven: the durable source of
truth for work is Supabase (`processing_jobs`, `batch_stage_jobs`, `libraries`), and
the worker pool polls those tables. These endpoints give the frontend an HTTP way to
trigger and observe the same queue, mirroring exactly what the Next.js routes already
write to Supabase (app/api/library-sync/*). Nothing here bypasses the queue.

Endpoints
  GET  /pipeline/status?library_id=...     -> unified progress for a library
  POST /pipeline/start                     -> queue a library_preprocess job
  POST /pipeline/cancel                    -> cancel a library's running/queued work
  POST /pipeline/resume                    -> re-queue failed/canceled batch-stage jobs
  GET  /workers/status                     -> worker plan + job counts by stage/status
  POST /r2/delete-prefix                   -> delete object-storage keys under prefix(es)
                                              (fills a contract the frontend already calls)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from supabase import create_client

from env_bootstrap import load_env

load_env()

router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


# Reuse the same service-role client + S3 config the workers use.
_SUPABASE_URL = _get_env("SUPABASE_URL")
_SUPABASE_KEY = _get_env("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(_SUPABASE_URL, _SUPABASE_KEY)

_R2_ENDPOINT = os.getenv("R2_ENDPOINT") or ""
_R2_BUCKET = os.getenv("R2_BUCKET") or ""
_R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY") or ""
_R2_SECRET_KEY = os.getenv("R2_SECRET_KEY") or ""

s3 = boto3.client(
    "s3",
    endpoint_url=_R2_ENDPOINT or None,
    aws_access_key_id=_R2_ACCESS_KEY or None,
    aws_secret_access_key=_R2_SECRET_KEY or None,
)


# Weighted stage ranges come from the single source of truth (pipeline_config) so the
# HTTP progress value matches the stages the workers actually run (incl. clustering) and
# always reaches 100. Replaces the old hard-coded list that referenced a phantom
# "vector_indexing" stage and omitted "clustering".
import pipeline_config


def _stage_ranges():
    return pipeline_config.stage_ranges()


_WORKER_STAGES = [
    "sync",
    "layout_parser",
    "text_extraction",
    "image_captioning",
    "chunking",
    "embedding",
    "clustering",
    "chat_retriever",
]


def _require_owner(request: Request):
    """Validate the Bearer token and require the caller to own at least one org.
    Worker counts are a deployment-wide setting, so only owners may change them."""
    auth = request.headers.get("authorization") or ""
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing access token.")
    token = auth[len("Bearer "):].strip()
    try:
        res = supabase.auth.get_user(token)
        user = getattr(res, "user", None)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired session.")
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session.")
    rows = (
        supabase.table("organization_members")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "owner")
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(status_code=403, detail="Owner only.")
    return user


class WorkerConfigRequest(BaseModel):
    counts: Dict[str, int] = Field(default_factory=dict)


@router.get("/pipeline/workers")
def get_pipeline_workers(request: Request):
    """Per-stage worker counts: auto-suggested (hardware) vs configured vs running."""
    _require_owner(request)
    import worker_bootstrap
    return worker_bootstrap.get_pool_status()


@router.post("/pipeline/workers")
def set_pipeline_workers(req: WorkerConfigRequest, request: Request):
    """Persist per-stage worker counts and reconcile the live pool. Owner only."""
    user = _require_owner(request)
    clean = {}
    for stage, val in (req.counts or {}).items():
        if stage in _WORKER_STAGES:
            try:
                clean[stage] = max(0, min(64, int(val)))
            except Exception:
                continue
    row = {"id": True, "updated_by": str(user.id), "updated_at": _now_iso()}
    row.update(clean)
    try:
        supabase.table("pipeline_worker_config").upsert(row, on_conflict="id").execute()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Couldn't save worker config: {exc}")

    import worker_bootstrap
    applied = worker_bootstrap.reconcile_pool(clean)
    return {"ok": True, "applied": applied, "status": worker_bootstrap.get_pool_status()}


# ----------------------------- request models ------------------------------

class LibraryRef(BaseModel):
    organization_id: str = Field(..., description="Organization UUID")
    library_id: str = Field(..., description="Library UUID")


class CancelRequest(BaseModel):
    library_id: str
    organization_id: Optional[str] = None


class DeletePrefixRequest(BaseModel):
    # Accept either a single prefix or a list; the frontend sends one prefix per call.
    prefix: Optional[str] = None
    prefixes: Optional[List[str]] = None


# ------------------------------- helpers -----------------------------------

def _safe_single(table: str, select: str, eq: Dict[str, str]) -> Optional[Dict[str, Any]]:
    q = supabase.table(table).select(select)
    for k, v in eq.items():
        q = q.eq(k, v)
    res = q.limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None


# ------------------------------- endpoints ---------------------------------

@router.get("/pipeline/status")
def pipeline_status(library_id: str = Query(..., description="Library UUID")):
    """
    Unified progress for one library, computed from batch_stage_jobs and reconciled
    with the libraries row. Returns the same shape the dashboard derives from Supabase.
    """
    lib = _safe_single(
        "libraries",
        "id, name, status, pipeline_status, pipeline_stage, pipeline_progress_percent, "
        "pipeline_error, total_batches, completed_batches, last_synced_at",
        {"id": library_id},
    )
    if not lib:
        raise HTTPException(status_code=404, detail="Library not found")

    jobs = (
        supabase.table("batch_stage_jobs")
        .select("stage, status, progress_current, progress_total")
        .eq("library_id", library_id)
        .limit(5000)
        .execute()
        .data
        or []
    )

    # Count batches per stage and how many are done, to compute weighted progress.
    by_stage: Dict[str, Dict[str, int]] = {}
    for j in jobs:
        st = j.get("stage") or "unknown"
        slot = by_stage.setdefault(st, {"total": 0, "done": 0})
        slot["total"] += 1
        if j.get("status") == "done":
            slot["done"] += 1

    progress = 0.0
    for stage, lo, hi in _stage_ranges():
        slot = by_stage.get(stage)
        if not slot or slot["total"] == 0:
            continue
        frac = slot["done"] / slot["total"]
        progress += lo if frac >= 1.0 else frac * (hi - lo)
    progress = round(min(progress, 100.0), 2)

    status_counts: Dict[str, int] = {}
    for j in jobs:
        status_counts[j.get("status") or "unknown"] = status_counts.get(j.get("status") or "unknown", 0) + 1

    return {
        "library": lib,
        "computed_progress_percent": progress,
        "stage_breakdown": by_stage,
        "status_counts": status_counts,
        "total_stage_jobs": len(jobs),
    }


@router.post("/pipeline/start")
def pipeline_start(req: LibraryRef):
    """
    Queue preprocessing for a library. Mirrors app/api/library-sync/start: marks the
    library queued and inserts a `library_preprocess` processing job for the worker pool.

    Note: Google Drive OAuth + library_sources upsert remain a frontend concern (they need
    the user's browser OAuth flow); this endpoint assumes the source is already connected.
    """
    lib = _safe_single("libraries", "id", {"id": req.library_id, "organization_id": req.organization_id})
    if not lib:
        raise HTTPException(status_code=404, detail="Library not found for organization")

    src = _safe_single(
        "library_sources", "id", {"library_id": req.library_id, "organization_id": req.organization_id}
    )
    if not src:
        raise HTTPException(
            status_code=409,
            detail="No connected source for this library. Connect Google Drive first.",
        )

    supabase.table("libraries").update(
        {
            "pipeline_status": "queued",
            "pipeline_stage": "sync",
            "pipeline_progress_percent": 0,
            "pipeline_error": None,
            "pipeline_started_at": _now_iso(),
            "pipeline_finished_at": None,
            "total_batches": 0,
            "completed_batches": 0,
            "status": "processing",
        }
    ).eq("id", req.library_id).execute()

    job = (
        supabase.table("processing_jobs")
        .insert(
            {
                "type": "library_preprocess",
                "status": "queued",
                "organization_id": req.organization_id,
                "library_id": req.library_id,
                "payload": {"stage": "sync"},
            }
        )
        .execute()
    )
    return {"ok": True, "job": (job.data or [{}])[0]}


@router.post("/pipeline/cancel")
def pipeline_cancel(req: CancelRequest):
    """Cancel a library's running/queued work. Mirrors app/api/library-sync/cancel."""
    lib = _safe_single("libraries", "id", {"id": req.library_id})
    if not lib:
        raise HTTPException(status_code=404, detail="Library not found")

    supabase.table("libraries").update(
        {"pipeline_status": "canceled", "pipeline_error": "Canceled by user"}
    ).eq("id", req.library_id).execute()

    supabase.table("batch_stage_jobs").update(
        {
            "status": "canceled",
            "assigned_worker": None,
            "last_error": None,
            "started_at": None,
            "finished_at": None,
        }
    ).eq("library_id", req.library_id).in_("status", ["running", "queued"]).execute()

    return {"ok": True}


@router.post("/pipeline/resume")
def pipeline_resume(req: LibraryRef):
    """
    Re-queue failed/canceled batch-stage jobs for a library. Mirrors the core of
    app/api/library-sync/resume (re-queue path). If no batches exist yet, re-enqueues
    a fresh library_preprocess job instead.
    """
    lib = _safe_single("libraries", "id", {"id": req.library_id, "organization_id": req.organization_id})
    if not lib:
        raise HTTPException(status_code=404, detail="Library not found for organization")

    batches = (
        supabase.table("library_batches").select("id").eq("library_id", req.library_id).limit(1).execute().data
        or []
    )

    if not batches:
        supabase.table("libraries").update(
            {
                "status": "processing",
                "pipeline_status": "queued",
                "pipeline_stage": "sync",
                "pipeline_progress_percent": 0,
                "pipeline_error": None,
                "pipeline_started_at": _now_iso(),
                "pipeline_finished_at": None,
            }
        ).eq("id", req.library_id).execute()
        job = (
            supabase.table("processing_jobs")
            .insert(
                {
                    "type": "library_preprocess",
                    "status": "queued",
                    "organization_id": req.organization_id,
                    "library_id": req.library_id,
                    "payload": {"stage": "sync", "resume": True},
                }
            )
            .execute()
        )
        return {"ok": True, "mode": "fresh", "job": (job.data or [{}])[0]}

    requeued = (
        supabase.table("batch_stage_jobs")
        .update(
            {
                "status": "queued",
                "assigned_worker": None,
                "last_error": None,
                "started_at": None,
                "finished_at": None,
            }
        )
        .eq("library_id", req.library_id)
        .in_("status", ["failed", "canceled"])
        .execute()
        .data
        or []
    )

    supabase.table("libraries").update(
        {"status": "processing", "pipeline_status": "running", "pipeline_error": None}
    ).eq("id", req.library_id).execute()

    return {"ok": True, "mode": "requeue", "requeued_count": len(requeued)}


@router.get("/workers/status")
def workers_status():
    """
    Observability endpoint: the auto worker plan plus live job counts across the queue,
    grouped by stage and status. Useful for the dashboard and for FYP demos.
    """
    try:
        from hardware import auto_worker_plan

        plan = auto_worker_plan()
    except Exception as exc:  # pragma: no cover
        plan = {"error": str(exc)}

    rows = (
        supabase.table("batch_stage_jobs")
        .select("stage, status")
        .limit(10000)
        .execute()
        .data
        or []
    )
    grid: Dict[str, Dict[str, int]] = {}
    for r in rows:
        st = r.get("stage") or "unknown"
        stat = r.get("status") or "unknown"
        grid.setdefault(st, {}).setdefault(stat, 0)
        grid[st][stat] += 1

    pj = (
        supabase.table("processing_jobs")
        .select("type, status")
        .in_("status", ["queued", "running"])
        .limit(2000)
        .execute()
        .data
        or []
    )
    pending_processing = {}
    for r in pj:
        key = f"{r.get('type')}:{r.get('status')}"
        pending_processing[key] = pending_processing.get(key, 0) + 1

    return {
        "worker_plan": plan,
        "batch_stage_jobs": grid,
        "pending_processing_jobs": pending_processing,
    }


@router.post("/r2/delete-prefix")
def r2_delete_prefix(req: DeletePrefixRequest):
    """
    Delete all object-storage keys under the given prefix(es). The frontend calls this
    during library deletion (app/api/library/delete) to purge raw + per-stage artifacts.
    Previously unimplemented on the backend, so storage cleanup silently failed.
    """
    if not _R2_BUCKET:
        raise HTTPException(status_code=500, detail="R2_BUCKET not configured")

    prefixes: List[str] = []
    if req.prefix:
        prefixes.append(req.prefix)
    if req.prefixes:
        prefixes.extend([p for p in req.prefixes if p])
    prefixes = [p for p in prefixes if p and p.strip()]
    if not prefixes:
        raise HTTPException(status_code=400, detail="No prefix(es) provided")

    deleted_total = 0
    errors: List[str] = []
    for prefix in prefixes:
        try:
            paginator = s3.get_paginator("list_objects_v2")
            to_delete: List[Dict[str, str]] = []
            for page in paginator.paginate(Bucket=_R2_BUCKET, Prefix=prefix):
                for obj in page.get("Contents", []) or []:
                    to_delete.append({"Key": obj["Key"]})
                    # S3 DeleteObjects caps at 1000 keys per request.
                    if len(to_delete) == 1000:
                        s3.delete_objects(Bucket=_R2_BUCKET, Delete={"Objects": to_delete})
                        deleted_total += len(to_delete)
                        to_delete = []
            if to_delete:
                s3.delete_objects(Bucket=_R2_BUCKET, Delete={"Objects": to_delete})
                deleted_total += len(to_delete)
        except Exception as exc:  # pragma: no cover
            errors.append(f"{prefix}: {exc}")

    return {"ok": not errors, "deleted": deleted_total, "prefixes": prefixes, "errors": errors}


@router.get("/visual/file")
def visual_file(key: str = Query(..., description="R2 key under visuals/")):
    """
    Stream a visual (figure/table/chart PNG) from R2 so it can be embedded inline in an answer.
    Only keys under the `visuals/` prefix are allowed.
    """
    k = (key or "").strip().lstrip("/")
    if not k.startswith("visuals/") or ".." in k:
        raise HTTPException(status_code=400, detail="Invalid visual key.")
    if not _R2_BUCKET:
        raise HTTPException(status_code=500, detail="R2_BUCKET not configured")
    try:
        obj = s3.get_object(Bucket=_R2_BUCKET, Key=k)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Visual not found: {exc}")

    body = obj["Body"]

    def _iter(chunk_size: int = 65536):
        try:
            while True:
                data = body.read(chunk_size)
                if not data:
                    break
                yield data
        finally:
            try:
                body.close()
            except Exception:
                pass

    media = str(obj.get("ContentType") or "image/png")
    if "image" not in media:
        media = "image/png"
    return StreamingResponse(
        _iter(),
        media_type=media,
        headers={"Cache-Control": "private, max-age=600"},
    )


@router.get("/document/chunk")
def document_chunk(chunk_id: str = Query(..., description="chunk_embeddings.chunk_id")):
    """
    Return a chunk's verbatim text + a little neighbour context, fetched on demand by chunk_id.
    Powers the source hover preview and the in-app PDF highlight — works even for reloaded threads
    where the snippet wasn't persisted with the message.
    """
    try:
        from chat_runtime import fetch_chunk_snippets

        info = fetch_chunk_snippets([chunk_id]).get(chunk_id) or {}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load chunk: {exc}")

    return {
        "chunk_id": chunk_id,
        "text": info.get("text") or "",
        "before": info.get("before") or "",
        "after": info.get("after") or "",
    }


@router.get("/document/file")
def document_file(
    doc_id: str = Query(..., description="documents.id"),
    organization_id: Optional[str] = Query(None, description="org guard"),
):
    """
    Stream a document's raw PDF from R2 so the frontend can render it in-app (in-tool PDF viewer)
    and highlight the cited chunk. Served as a binary stream — the frontend reaches this through a
    dedicated Next.js binary proxy (app/api/pdf), NOT the generic text proxy.
    """
    try:
        res = (
            supabase.table("documents")
            .select("id,organization_id,storage_path_raw,mime_type,title")
            .eq("id", doc_id)
            .single()
            .execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Document not found: {exc}")

    d = res.data
    if not d:
        raise HTTPException(status_code=404, detail="Document not found.")
    if organization_id and str(d.get("organization_id")) != str(organization_id):
        raise HTTPException(status_code=403, detail="Document does not belong to this organization.")

    key = d.get("storage_path_raw")
    if not key:
        raise HTTPException(status_code=404, detail="No stored raw file for this document.")
    if not _R2_BUCKET:
        raise HTTPException(status_code=500, detail="R2_BUCKET not configured")

    try:
        obj = s3.get_object(Bucket=_R2_BUCKET, Key=key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to read file from storage: {exc}")

    body = obj["Body"]  # botocore StreamingBody

    def _iter(chunk_size: int = 65536):
        try:
            while True:
                data = body.read(chunk_size)
                if not data:
                    break
                yield data
        finally:
            try:
                body.close()
            except Exception:
                pass

    return StreamingResponse(
        _iter(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'inline; filename="document.pdf"',
            "Cache-Control": "private, max-age=300",
        },
    )
