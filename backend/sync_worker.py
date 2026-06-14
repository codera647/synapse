import os
import time
import random
from datetime import datetime, timezone
from batch_creator import create_library_batches
import boto3
import requests
from supabase import create_client, Client
from env_bootstrap import load_env
load_env()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def get_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing env var: {name}")
    return value


SUPABASE_URL = get_env("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = get_env("SUPABASE_SERVICE_ROLE_KEY")

GOOGLE_CLIENT_ID = get_env("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = get_env("GOOGLE_CLIENT_SECRET")

R2_ENDPOINT = get_env("R2_ENDPOINT")
R2_BUCKET = get_env("R2_BUCKET")
# Optional on AWS if using an Instance Role (recommended).
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY") or ""
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY") or ""

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT or None,
    aws_access_key_id=R2_ACCESS_KEY or None,
    aws_secret_access_key=R2_SECRET_KEY or None,
)


def _is_retryable_supabase_error(exc: Exception) -> bool:
    # Supabase/PostgREST sometimes returns Cloudflare HTML (502/521) which the client can't JSON-decode.
    # We retry those, plus common transient network/timeouts and 429s.
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
    """
    Execute a Supabase query with retries/backoff on transient 5xx/429/timeout.

    This is important because sync/layout can generate lots of requests (multiple workers),
    and Supabase can intermittently respond with Cloudflare HTML 502 which breaks JSON parsing.
    """
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
            # Exponential backoff with jitter
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
        .update({"status": "canceled", "last_error": reason, "finished_at": now_iso(), "assigned_worker": None})
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


def slugify(value: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in value).strip("-")


def get_access_token(refresh_token: str) -> str:
    url = "https://oauth2.googleapis.com/token"
    payload = {
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    res = requests.post(url, data=payload, timeout=30)
    res.raise_for_status()
    return res.json()["access_token"]


def list_drive_files(access_token: str, folder_id: str):
    files = []
    page_token = None
    headers = {"Authorization": f"Bearer {access_token}"}
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
            "pageSize": 1000,
            "pageToken": page_token,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        res = requests.get(
            "https://www.googleapis.com/drive/v3/files",
            headers=headers,
            params=params,
            timeout=30,
        )
        res.raise_for_status()
        data = res.json()
        files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files

def download_drive_file(access_token: str, file_id: str, mime_type: str | None):
    headers = {"Authorization": f"Bearer {access_token}"}

    export_map = {
        "application/vnd.google-apps.document": "application/pdf",
        "application/vnd.google-apps.spreadsheet": "text/csv",
        "application/vnd.google-apps.presentation": "application/pdf",
        "application/vnd.google-apps.drawing": "application/pdf",
    }

    if mime_type in export_map:
        export_mime = export_map[mime_type]
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}/export"
        res = requests.get(
            url,
            headers=headers,
            params={"mimeType": export_mime, "supportsAllDrives": "true"},
            timeout=120,
        )
        res.raise_for_status()
        return res.content, export_mime

    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    res = requests.get(
        url,
        headers=headers,
        params={"supportsAllDrives": "true"},
        timeout=120,
    )
    res.raise_for_status()
    return res.content, mime_type




def upload_to_r2(
    org_id: str,
    org_name: str,
    library_id: str,
    library_name: str,
    file_id: str,
    filename: str,
    content: bytes
) -> str:
    safe_name = filename.replace("/", "_").replace("\\", "_")
    org_slug = slugify(org_name or "org")
    lib_slug = slugify(library_name or "library")
    key = (
        f"org_{org_slug}_{org_id}/"
        f"library_{lib_slug}_{library_id}/raw/"
        f"{file_id}-{safe_name}"
    )
    s3.put_object(Bucket=R2_BUCKET, Key=key, Body=content)
    return key


def ensure_extension(filename: str, mime_type: str | None) -> str:
    ext_map = {
        "application/pdf": ".pdf",
        "text/csv": ".csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    }
    if not mime_type:
        return filename
    ext = ext_map.get(mime_type)
    if not ext:
        return filename
    if filename.lower().endswith(ext):
        return filename
    return f"{filename}{ext}"


def parse_drive_time(value: str | None):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def claim_job():
    q = (
        supabase.table("processing_jobs")
        .select("*")
        .eq("status", "queued")
        .in_("type", ["library_preprocess", "library_sync"])
        .order("created_at")
        .limit(1)
    )
    jobs = _sb_execute(q, context="processing_jobs.select(queued)")
    if not jobs.data:
        return None

    job = jobs.data[0]
    claimed_q = (
        supabase.table("processing_jobs")
        .update({"status": "running"})
        .eq("id", job["id"])
        .eq("status", "queued")
    )
    claimed = _sb_execute(claimed_q, context="processing_jobs.update(claim)")
    if not claimed.data:
        return None
    return claimed.data[0]


def complete_job(job_id: str, error: str | None = None):
    q = (
        supabase.table("processing_jobs")
        .update(
            {
                "status": "failed" if error else "done",
                "last_error": error,
            }
        )
        .eq("id", job_id)
    )
    _sb_execute(q, context="processing_jobs.update(complete)")


def run_sync(job):
    """Phase-2: bootstrapper for sync.

    Claims a `processing_jobs` row and prepares the per-batch queue:
    - upserts `documents` metadata from Drive
    - creates `library_batches`
    - enqueues `batch_stage_jobs(stage=sync)`
    """
    library_id = job["library_id"]
    org_id = job["organization_id"]

    try:
        sync_workers = int(os.getenv("SYNC_WORKERS", "3"))

        org = _sb_execute(
            supabase.table("organizations").select("name").eq("id", org_id).single(),
            context="organizations.select(name)",
        )
        lib = _sb_execute(
            supabase.table("libraries").select("name").eq("id", library_id).single(),
            context="libraries.select(name)",
        )
        org_name = org.data["name"] if org.data else "org"
        lib_name = lib.data["name"] if lib.data else "library"

        source = (
            supabase.table("library_sources")
            .select("*")
            .eq("library_id", library_id)
            .eq("organization_id", org_id)
            .limit(1)
        )
        source = _sb_execute(source, context="library_sources.select")
        if not source.data:
            raise RuntimeError("No library source found for sync job")

        source = source.data[0]
        access_token = get_access_token(source["refresh_token"])
        folder_id = source["folder_id"]

        _sb_execute(
            supabase.table("libraries").update(
                {
                    "status": "processing",
                    "pipeline_status": "running",
                    "pipeline_stage": "sync",
                    "pipeline_progress_percent": 0,
                    "pipeline_error": None,
                    "pipeline_started_at": now_iso(),
                    "pipeline_finished_at": None,
                    "completed_batches": 0,
                }
            ).eq("id", library_id),
            context="libraries.update(pipeline_start)",
        )

        files = list_drive_files(access_token, folder_id)

        existing = _sb_execute(
            supabase.table("documents").select("id, gdrive_file_id").eq("library_id", library_id),
            context="documents.select(existing)",
        )
        existing_map = {d["gdrive_file_id"]: d for d in existing.data if d.get("gdrive_file_id")}
        seen = set()

        # Bulk upsert documents metadata (reduces request count, avoids intermittent Supabase 502s).
        upserts = []
        for f in files:
            file_id = f["id"]
            seen.add(file_id)
            upserts.append(
                {
                    "organization_id": org_id,
                    "library_id": library_id,
                    "title": f.get("name") or file_id,
                    "mime_type": f.get("mimeType"),
                    "file_size_bytes": int(f.get("size") or 0),
                    "status": "pending",
                    "gdrive_file_id": file_id,
                }
            )

        chunk_size = int(os.getenv("DOC_META_UPSERT_CHUNK", "200"))
        for i in range(0, len(upserts), chunk_size):
            chunk = upserts[i : i + chunk_size]
            _sb_execute(
                supabase.table("documents").upsert(chunk, on_conflict="library_id,gdrive_file_id"),
                context=f"documents.upsert(meta) [{i}:{i+len(chunk)}]",
            )

        # Mark docs that disappeared from Drive in bulk.
        to_skip_ids = [doc["id"] for fid, doc in existing_map.items() if fid not in seen]
        for i in range(0, len(to_skip_ids), chunk_size):
            ids_chunk = to_skip_ids[i : i + chunk_size]
            _sb_execute(
                supabase.table("documents")
                .update({"status": "skipped", "skipped_reason": "deleted"})
                .in_("id", ids_chunk),
                context=f"documents.update(skipped) [{i}:{i+len(ids_chunk)}]",
            )

        batches = create_library_batches(org_id, library_id, worker_count=sync_workers, stage="sync")
        total_batches = int(batches.get("created") or 0)

        _sb_execute(
            supabase.table("libraries").update(
                {
                    "total_batches": total_batches,
                    "completed_batches": 0,
                    "pipeline_progress_percent": 0,
                    "pipeline_error": None,
                }
            ).eq("id", library_id),
            context="libraries.update(total_batches)",
        )

        print(f"[bootstrap] library={library_id} docs={len(files)} batches={total_batches} workers={sync_workers}")

    except Exception as exc:
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "status": "error",
                    "pipeline_status": "failed",
                    "pipeline_stage": "sync",
                    "pipeline_error": str(exc),
                }
            ).eq("id", library_id),
            context="libraries.update(sync_failed)",
        )
        raise

def claim_sync_stage_job(worker_id: str):
    jobs_q = (
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "sync")
        .eq("status", "queued")
        .order("created_at")
        .limit(1)
    )
    jobs = _sb_execute(jobs_q, context="batch_stage_jobs.select(sync.queued)")
    if not jobs.data:
        return None

    job = jobs.data[0]
    claimed_q = (
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
        .eq("status", "queued")
    )
    claimed = _sb_execute(claimed_q, context="batch_stage_jobs.update(sync.claim)")
    if not claimed.data:
        return None
    return claimed.data[0]

def _update_library_progress(library_id: str):
    # Back-compat wrapper: keep the old name but compute progress from stage jobs.
    _update_pipeline_progress(library_id, current_stage="sync")


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


def _count_remaining_stage_jobs(library_id: str, stage: str) -> int:
    resp = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("id", count="exact")
        .eq("library_id", library_id)
        .eq("stage", stage)
        .neq("status", "done"),
        context=f"batch_stage_jobs.count(remaining:{stage})",
    )
    return int(resp.count or 0)


def _update_pipeline_progress(library_id: str, current_stage: str):
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

    # For UI "Batches X/Y" we show completion for the current stage.
    # `completed_batches` represents fully-processed batches (i.e. reached the last stage),
    # not "batches completed in the current stage".
    completed_batches = _count_done_stage_jobs(library_id, _pipeline_stages()[-1])

    _sb_execute(
        supabase.table("libraries").update(
            {
                "pipeline_status": "running",
                "pipeline_stage": current_stage,
                "completed_batches": completed_batches,
                "pipeline_progress_percent": progress,
            }
        ).eq("id", library_id),
        context="libraries.update(pipeline_progress)",
    )

def run_sync_stage_job(stage_job):
    library_id = stage_job["library_id"]
    org_id = stage_job["organization_id"]
    batch_id = stage_job["batch_id"]
    job_id = stage_job["id"]

    try:
        st = _get_library_pipeline_status(library_id)
        if st is None or st in _PIPELINE_ABORT_STATUSES:
            _mark_stage_job_canceled(job_id, f"Aborted (library pipeline_status={st or 'missing'}).")
            return

        batch = _sb_execute(
            supabase.table("library_batches").select("id, doc_ids, doc_count").eq("id", batch_id).single(),
            context="library_batches.select(batch)",
        )
        doc_ids = (batch.data or {}).get("doc_ids") or []
        _sb_execute(
            supabase.table("library_batches").update({"status": "running"}).eq("id", batch_id),
            context="library_batches.update(running)",
        )
        org = _sb_execute(
            supabase.table("organizations").select("name").eq("id", org_id).single(),
            context="organizations.select(name)",
        )
        lib = _sb_execute(
            supabase.table("libraries").select("name, status, pipeline_status").eq("id", library_id).single(),
            context="libraries.select(name,status)",
        )
        org_name = org.data["name"] if org.data else "org"
        lib_name = lib.data["name"] if lib.data else "library"

        # If the library was deleted/canceled/failed while workers are running, stop cleanly.
        lib_status = (lib.data or {}).get("status")
        pipe_status = str((lib.data or {}).get("pipeline_status") or "").lower()
        if (not lib.data) or (lib_status in {"deleted"}) or (pipe_status in _PIPELINE_ABORT_STATUSES):
            _sb_execute(
                supabase.table("batch_stage_jobs").update(
                    {
                        "status": "canceled",
                        "finished_at": now_iso(),
                        "last_error": f"library aborted (pipeline_status={pipe_status or 'missing'})",
                    }
                ).eq("id", job_id),
                context="batch_stage_jobs.update(canceled)",
            )
            return

        source = (
            supabase.table("library_sources")
            .select("refresh_token")
            .eq("library_id", library_id)
            .eq("organization_id", org_id)
            .single()
        )
        source = _sb_execute(source, context="library_sources.select(refresh_token)")
        refresh = (source.data or {}).get("refresh_token")
        if not refresh:
            raise RuntimeError("Missing refresh_token for library_sources")
        access_token = get_access_token(refresh)
        total = int(stage_job.get("progress_total") or len(doc_ids) or 0)
        current = int(stage_job.get("progress_current") or 0)
        if total <= 0:
            total = len(doc_ids)

        # Fetch document rows for this batch in chunks (avoid one query per doc_id).
        docs_by_id: dict[str, dict] = {}
        id_chunk = int(os.getenv("DOC_FETCH_CHUNK", "100"))
        for i in range(0, len(doc_ids), id_chunk):
            chunk = doc_ids[i : i + id_chunk]
            resp = _sb_execute(
                supabase.table("documents")
                .select("id, gdrive_file_id, title, mime_type, file_size_bytes")
                .in_("id", chunk),
                context=f"documents.select(batch) [{i}:{i+len(chunk)}]",
            )
            for d in resp.data or []:
                docs_by_id[d["id"]] = d

        progress_every = int(os.getenv("STAGE_PROGRESS_EVERY", "5"))
        update_chunk = int(os.getenv("DOC_STORAGE_UPSERT_CHUNK", "20"))
        storage_updates = []

        for doc_id in doc_ids:
            st = _get_library_pipeline_status(library_id)
            if st is None or st in _PIPELINE_ABORT_STATUSES:
                _mark_stage_job_canceled(job_id, f"Aborted mid-batch (library pipeline_status={st or 'missing'}).")
                return

            d = docs_by_id.get(doc_id)
            if not d or not d.get("gdrive_file_id"):
                continue
            file_id = d["gdrive_file_id"]
            name = d.get("title") or file_id
            mime = d.get("mime_type")
            content, effective_mime = download_drive_file(access_token, file_id, mime)
            name = ensure_extension(name, effective_mime)
            storage_path = upload_to_r2(org_id, org_name, library_id, lib_name, file_id, name, content)

            # Use upsert for batch efficiency, but include required columns so we never attempt to insert
            # a partial row (which would violate NOT NULL constraints like organization_id/library_id).
            storage_updates.append(
                {
                    "id": doc_id,
                    "organization_id": org_id,
                    "library_id": library_id,
                    "gdrive_file_id": file_id,
                    "title": name,
                    "mime_type": effective_mime or mime,
                    "file_size_bytes": int(d.get("file_size_bytes") or 0),
                    "status": "pending",
                    "storage_path": storage_path,
                    "storage_path_raw": storage_path,
                }
            )

            current += 1

            # Batch doc updates to reduce Supabase write load.
            if len(storage_updates) >= update_chunk:
                _sb_execute(
                    supabase.table("documents").upsert(storage_updates, on_conflict="id"),
                    context="documents.upsert(storage_path)",
                )
                storage_updates = []

            # Throttle progress updates (don’t write every doc).
            if current % progress_every == 0:
                _sb_execute(
                    supabase.table("batch_stage_jobs").update(
                        {"progress_current": current, "progress_total": total}
                    ).eq("id", job_id),
                    context="batch_stage_jobs.update(progress)",
                )

        if storage_updates:
            _sb_execute(
                supabase.table("documents").upsert(storage_updates, on_conflict="id"),
                context="documents.upsert(storage_path.final)",
            )

        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "done", "finished_at": now_iso(), "progress_current": total, "progress_total": total}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(done)",
        )
        _sb_execute(
            supabase.table("library_batches").update({"status": "completed", "completed_at": now_iso()}).eq(
                "id", batch_id
            ),
            context="library_batches.update(completed)",
        )

        # Enqueue next stage (layout parsing) for this batch.
        _sb_execute(
            supabase.table("batch_stage_jobs").upsert(
            {
                "organization_id": org_id,
                "library_id": library_id,
                "batch_id": batch_id,
                "stage": "layout_parser",
                "status": "queued",
                "attempts": 0,
                "payload": {},
                "progress_current": 0,
                "progress_total": total,
            },
            on_conflict="batch_id,stage",
            ),
            context="batch_stage_jobs.upsert(layout_parser)",
        )
        _update_pipeline_progress(library_id, current_stage="sync")
        # If all sync batches are done, finalize library sync.
        remaining = _sb_execute(
            supabase.table("batch_stage_jobs")
            .select("id", count="exact")
            .eq("library_id", library_id)
            .eq("stage", "sync")
            .neq("status", "done"),
            context="batch_stage_jobs.count(sync.remaining)",
        )
        if int(remaining.count or 0) == 0:
            # If a next stage exists (layout_parser), transition the library instead of marking pipeline completed.
            stages = _pipeline_stages()
            next_stage = None
            if "sync" in stages:
                idx = stages.index("sync")
                if idx < len(stages) - 1:
                    next_stage = stages[idx + 1]

            if next_stage:
                # Keep the library in processing state so the UI continues polling.
                _sb_execute(
                    supabase.table("libraries").update(
                        {
                            "status": "processing",
                            "pipeline_status": "running",
                            "pipeline_stage": next_stage,
                            "pipeline_error": None,
                        }
                    ).eq("id", library_id),
                    context="libraries.update(transition_next_stage)",
                )
                _update_pipeline_progress(library_id, current_stage=next_stage)
            else:
                finished = now_iso()
                _sb_execute(
                    supabase.table("libraries").update(
                        {
                            "status": "ready",
                            "last_synced_at": finished,
                            "pipeline_status": "completed",
                            "pipeline_stage": "sync",
                            "pipeline_progress_percent": 100,
                            "pipeline_error": None,
                            "pipeline_finished_at": finished,
                        }
                    ).eq("id", library_id),
                    context="libraries.update(sync.completed)",
                )
    except Exception as exc:
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": str(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(sync.failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "status": "error",
                    "pipeline_status": "failed",
                    "pipeline_stage": "sync",
                    "pipeline_error": str(exc),
                }
            ).eq("id", library_id),
            context="libraries.update(sync.failed)",
        )
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in sync: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise

def worker_loop():
    while True:
        job = claim_job()
        if not job:
            time.sleep(3)
            continue

        try:
            run_sync(job)
            complete_job(job["id"])
        except Exception as exc:
            _sb_execute(
                supabase.table("libraries").update(
                    {
                        "status": "error",
                        "pipeline_status": "failed",
                        "pipeline_stage": "sync",
                        "pipeline_error": str(exc),
                    }
                ).eq("id", job["library_id"]),
                context="libraries.update(worker_loop.failed)",
            )
            complete_job(job["id"], str(exc))
            time.sleep(2)


if __name__ == "__main__":
    worker_loop()
