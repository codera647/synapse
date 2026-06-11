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
from fastapi import APIRouter, HTTPException, Query
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


# Weighted stage ranges — kept identical to docs/sync-pipeline-design.md so the
# HTTP progress value matches what the frontend computes from Supabase.
STAGE_RANGES = [
    ("sync", 0, 20),
    ("layout_parser", 20, 35),
    ("text_extraction", 35, 55),
    ("image_captioning", 55, 70),
    ("chunking", 70, 82),
    ("embedding", 82, 94),
    ("vector_indexing", 94, 100),
]


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
    for stage, lo, hi in STAGE_RANGES:
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
