"""
backend/library_files_api.py

Add files to an ALREADY-PROCESSED library and process ONLY the new files.

Endpoints used by the "Add files" modal:
  POST /library/add-files/upload   (multipart) -> store local files in R2 + create documents
  POST /library/add-files/drive    (json)      -> add picked Drive files OR re-scan the folder
  POST /library/add-files/commit   (json)      -> batch the new docs + restart the pipeline

The new documents get their OWN batches (append, not clear); the library flips back to
processing; and the per-library clustering lock is cleared so clustering re-runs over all chunks
(old + new). Existing documents are never re-processed.
"""
from __future__ import annotations

import os
import uuid
from typing import List, Optional

import requests
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from batch_creator import append_documents_to_library
from sync_worker import (
    supabase,
    s3,
    R2_BUCKET,
    slugify,
    get_access_token,
    list_drive_files,
)

router = APIRouter()

# The set the document pipeline actually parses (mirrors document_parsers._CODE_EXTS + the doc/image
# formats handled by layout/extraction). Keep in sync with agent_api._ALLOWED_UPLOAD_EXT.
_ALLOWED_EXT = {
    # documents
    ".pdf", ".docx", ".txt", ".text", ".log", ".md", ".markdown", ".csv", ".xlsx", ".xlsm", ".json",
    # code / source files
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".rb", ".php", ".c", ".cc", ".cpp",
    ".h", ".hpp", ".cs", ".swift", ".kt", ".scala", ".sh", ".bash", ".sql", ".r", ".m", ".lua", ".pl",
    ".dart", ".vue", ".css", ".scss",
    # images (VLM transcription)
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
}


def _max_upload_bytes() -> int:
    try:
        return int(float(os.getenv("LIBRARY_MAX_UPLOAD_MB", "50")) * 1024 * 1024)
    except Exception:
        return 50 * 1024 * 1024


def _library(organization_id: str, library_id: str) -> dict:
    rows = (
        supabase.table("libraries")
        .select("id, name, organization_id, total_batches, created_by_user_id")
        .eq("id", library_id).eq("organization_id", organization_id)
        .limit(1).execute().data or []
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Library not found.")
    return rows[0]


def _can_write(library: dict, user_id: Optional[str]) -> bool:
    """A user may add files to a library if they OWN it, or have been granted 'write' on it.
    No grant row = read-only (the default for shared libraries)."""
    if not user_id:
        return False
    if str(library.get("created_by_user_id") or "") == str(user_id):
        return True
    grant = (
        supabase.table("team_library_member_privileges")
        .select("privilege")
        .eq("library_id", library["id"]).eq("user_id", user_id)
        .limit(1).execute().data or []
    )
    return bool(grant and str(grant[0].get("privilege")) == "write")


def _require_write(library: dict, user_id: Optional[str]) -> None:
    if not _can_write(library, user_id):
        raise HTTPException(status_code=403, detail="You don't have permission to add files to this library.")


def _org_name(organization_id: str) -> str:
    try:
        rows = supabase.table("organizations").select("name").eq("id", organization_id).limit(1).execute().data or []
        return (rows[0].get("name") if rows else None) or "org"
    except Exception:
        return "org"


def _source(organization_id: str, library_id: str) -> dict:
    rows = (
        supabase.table("library_sources")
        .select("refresh_token, folder_id")
        .eq("library_id", library_id).eq("organization_id", organization_id)
        .limit(1).execute().data or []
    )
    if not rows or not rows[0].get("refresh_token"):
        raise HTTPException(status_code=400, detail="This library is not connected to Google Drive.")
    return rows[0]


def _existing_drive_ids(library_id: str) -> set:
    rows = supabase.table("documents").select("gdrive_file_id").eq("library_id", library_id).execute().data or []
    return {r.get("gdrive_file_id") for r in rows if r.get("gdrive_file_id")}


def _existing_by_title(library_id: str, titles: List[str]) -> dict:
    """title -> existing document row, for the given titles in this library (duplicate detection)."""
    uniq = list({t for t in (titles or []) if t})
    out: dict = {}
    for i in range(0, len(uniq), 100):
        rows = (
            supabase.table("documents")
            .select("id, title, storage_path_raw, storage_path_text")
            .eq("library_id", library_id).in_("title", uniq[i:i + 100])
            .execute().data or []
        )
        for r in rows:
            out[str(r.get("title"))] = r
    return out


# per-document derived artefacts live under {stage}/{org}/{lib}/{doc_id}* in R2
_DOC_R2_PREFIXES = ("text", "layout", "chunks", "visuals", "visuals_manifest",
                    "tables", "formulas", "charts", "captions")


def _r2_delete_prefix(prefix: str) -> None:
    try:
        paginator = s3.get_paginator("list_objects_v2")
        batch: List[dict] = []
        for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=prefix):
            for obj in (page.get("Contents") or []):
                batch.append({"Key": obj["Key"]})
                if len(batch) >= 1000:
                    s3.delete_objects(Bucket=R2_BUCKET, Delete={"Objects": batch})
                    batch = []
        if batch:
            s3.delete_objects(Bucket=R2_BUCKET, Delete={"Objects": batch})
    except Exception:
        pass


def _delete_document(organization_id: str, library_id: str, doc: dict) -> None:
    """Fully remove ONE document: its R2 objects + chunks + the row. Best-effort on R2 so a storage
    hiccup never blocks the DB cleanup."""
    doc_id = doc.get("id")
    for key in (doc.get("storage_path_raw"), doc.get("storage_path_text")):
        if key:
            try:
                s3.delete_object(Bucket=R2_BUCKET, Key=key)
            except Exception:
                pass
    if doc_id:
        for stage in _DOC_R2_PREFIXES:
            _r2_delete_prefix(f"{stage}/{organization_id}/{library_id}/{doc_id}")
        try:
            supabase.table("chunk_embeddings").delete().eq("doc_id", doc_id).execute()
        except Exception:
            pass
        try:
            supabase.table("documents").delete().eq("id", doc_id).execute()
        except Exception:
            pass


def _truthy(v) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


class CheckRequest(BaseModel):
    organization_id: str
    library_id: str
    filenames: List[str]
    acting_user_id: Optional[str] = None


@router.post("/library/add-files/check")
def library_add_check(req: CheckRequest):
    """Return which of the given filenames already exist in the library (by title)."""
    lib = _library(req.organization_id, req.library_id)
    _require_write(lib, req.acting_user_id)
    names = [(n or "").replace("/", "_").replace("\\", "_") for n in (req.filenames or []) if n]
    existing = _existing_by_title(req.library_id, names)
    return {"duplicates": sorted({n for n in names if n in existing})}


# ── local upload ─────────────────────────────────────────────────────────────────────
@router.post("/library/add-files/upload")
async def library_add_upload(
    organization_id: str = Form(...),
    library_id: str = Form(...),
    created_by_user_id: Optional[str] = Form(None),
    acting_user_id: Optional[str] = Form(None),
    replace: Optional[str] = Form(None),
    files: List[UploadFile] = File(...),
):
    lib = _library(organization_id, library_id)
    _require_write(lib, acting_user_id or created_by_user_id)
    org_slug = slugify(_org_name(organization_id))
    lib_slug = slugify(lib.get("name") or "library")
    max_bytes = _max_upload_bytes()
    do_replace = _truthy(replace)

    names = [(f.filename or "upload").replace("/", "_").replace("\\", "_") for f in files]
    existing = _existing_by_title(library_id, names)

    doc_ids: List[str] = []
    skipped: List[str] = []
    for f, name in zip(files, names):
        ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
        if ext not in _ALLOWED_EXT:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext or 'unknown'}")
        dup = existing.get(name)
        if dup:
            if do_replace:
                _delete_document(organization_id, library_id, dup)
                existing.pop(name, None)
            else:
                skipped.append(name)
                continue
        data = await f.read()
        if len(data) > max_bytes:
            raise HTTPException(status_code=413, detail=f"{name} is too large.")
        key = f"org_{org_slug}_{organization_id}/library_{lib_slug}_{library_id}/raw/local-{uuid.uuid4()}-{name}"
        s3.put_object(Bucket=R2_BUCKET, Key=key, Body=data,
                      ContentType=f.content_type or "application/octet-stream")
        doc_id = str(uuid.uuid4())
        supabase.table("documents").insert({
            "id": doc_id,
            "organization_id": organization_id,
            "library_id": library_id,
            "title": name,
            "mime_type": f.content_type,
            "file_size_bytes": len(data),
            "status": "pending",
            "storage_path": key,
            "storage_path_raw": key,  # already in R2 -> the sync stage skips the Drive download
        }).execute()
        doc_ids.append(doc_id)
    return {"added": len(doc_ids), "doc_ids": doc_ids, "skipped": skipped}


# ── google drive: pick files OR re-scan the connected folder ──────────────────────────
class DriveAddRequest(BaseModel):
    organization_id: str
    library_id: str
    mode: str  # "files" | "rescan"
    file_ids: Optional[List[str]] = None
    acting_user_id: Optional[str] = None
    replace: Optional[bool] = None


def _drive_meta(access_token: str, file_id: str) -> dict:
    res = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"fields": "id, name, mimeType, size", "supportsAllDrives": "true"},
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


@router.post("/library/add-files/drive")
def library_add_drive(req: DriveAddRequest):
    lib = _library(req.organization_id, req.library_id)
    _require_write(lib, req.acting_user_id)
    src = _source(req.organization_id, req.library_id)
    access_token = get_access_token(src["refresh_token"])
    existing = _existing_drive_ids(req.library_id)

    if req.mode == "rescan":
        folder_id = src.get("folder_id")
        if not folder_id:
            raise HTTPException(status_code=400, detail="No connected Drive folder to re-scan.")
        files = list_drive_files(access_token, folder_id)
    elif req.mode == "files":
        ids = [fid for fid in (req.file_ids or []) if fid]
        if not ids:
            raise HTTPException(status_code=400, detail="No Drive files selected.")
        files = []
        for fid in ids:
            try:
                files.append(_drive_meta(access_token, fid))
            except Exception:
                continue
    else:
        raise HTTPException(status_code=400, detail="Invalid mode.")

    do_replace = bool(req.replace)
    by_title = _existing_by_title(req.library_id, [str(f.get("name") or "") for f in files])

    new_rows, doc_ids, skipped = [], [], []
    for f in files:
        fid = f.get("id")
        if not fid or fid in existing:
            continue
        title = str(f.get("name") or fid)
        dup = by_title.get(title)
        if dup:
            if do_replace:
                _delete_document(req.organization_id, req.library_id, dup)
                by_title.pop(title, None)
            else:
                skipped.append(title)
                continue
        existing.add(fid)
        doc_id = str(uuid.uuid4())
        doc_ids.append(doc_id)
        new_rows.append({
            "id": doc_id,
            "organization_id": req.organization_id,
            "library_id": req.library_id,
            "title": title,
            "mime_type": f.get("mimeType"),
            "file_size_bytes": int(f.get("size") or 0),
            "status": "pending",
            "gdrive_file_id": fid,  # the sync stage downloads these
        })
    if new_rows:
        supabase.table("documents").upsert(new_rows, on_conflict="library_id,gdrive_file_id").execute()
    return {"added": len(doc_ids), "doc_ids": doc_ids, "skipped": skipped}


# ── commit: batch the new docs + restart the pipeline ─────────────────────────────────
class CommitRequest(BaseModel):
    organization_id: str
    library_id: str
    doc_ids: List[str]
    acting_user_id: Optional[str] = None


@router.post("/library/add-files/commit")
def library_add_commit(req: CommitRequest):
    lib = _library(req.organization_id, req.library_id)
    _require_write(lib, req.acting_user_id)
    doc_ids = [d for d in (req.doc_ids or []) if d]
    if not doc_ids:
        raise HTTPException(status_code=400, detail="No new files to process.")

    desired = min(len(doc_ids), max(1, int(os.getenv("ADD_FILES_BATCHES", "4"))))
    res = append_documents_to_library(req.organization_id, req.library_id, doc_ids, worker_count=desired)
    added_batches = int(res.get("created") or 0)
    if added_batches == 0:
        raise HTTPException(status_code=400, detail="No new files to process.")

    # Force clustering to re-run over the WHOLE library (old + new chunks): the clustering stage
    # has a fast-path that skips when library_cluster_runs.status == 'done', so clear it.
    try:
        supabase.table("library_cluster_runs").delete().eq("library_id", req.library_id).execute()
    except Exception:
        pass

    prev_total = int(lib.get("total_batches") or 0)
    supabase.table("libraries").update({
        "total_batches": prev_total + added_batches,
        "pipeline_status": "queued",
        "pipeline_stage": "sync",
        "status": "processing",
        "pipeline_error": None,
        "cancel_requested": False,
        "pipeline_finished_at": None,
    }).eq("id", req.library_id).eq("organization_id", req.organization_id).execute()

    return {"ok": True, "added_batches": added_batches, "added_documents": len(doc_ids)}
