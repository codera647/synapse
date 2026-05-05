import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from env_bootstrap import load_env
from supabase import create_client

load_env()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


SUPABASE_URL = get_env("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = get_env("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def create_chat_job(
    organization_id: str,
    library_ids: List[str],
    message: str,
    top_k: int,
    max_hops: int,
) -> Dict[str, Any]:
    payload = {
        "organization_id": organization_id,
        "library_ids": library_ids,
        "message": message,
        "top_k": int(top_k),
        "max_hops": int(max_hops),
    }
    res = (
        supabase.table("chat_jobs")
        .insert(
            {
                "organization_id": organization_id,
                "library_ids": library_ids,
                "message": message,
                "status": "running",
                "payload": payload,
            }
        )
        .execute()
    )
    if not res.data:
        raise RuntimeError("Failed to create chat_jobs row.")
    return res.data[0]


def mark_chat_job_done(chat_job_id: str, result: Dict[str, Any]):
    supabase.table("chat_jobs").update(
        {"status": "done", "result": result, "updated_at": now_iso()}
    ).eq("id", chat_job_id).execute()


def mark_chat_job_failed(chat_job_id: str, error: str):
    supabase.table("chat_jobs").update(
        {"status": "failed", "last_error": str(error), "updated_at": now_iso()}
    ).eq("id", chat_job_id).execute()


def enqueue_retrieval_tasks(
    chat_job_id: str,
    organization_id: str,
    library_ids: List[str],
    hop: int,
    query_text: str,
    query_embedding: List[float],
    kinds: List[str],
    top_k: int,
):
    rows = []
    for kind in kinds:
        rows.append(
            {
                "chat_job_id": chat_job_id,
                "organization_id": organization_id,
                "library_ids": library_ids,
                "hop": int(hop),
                "kind": kind,
                "status": "queued",
                "attempts": 0,
                "payload": {
                    "query_text": query_text,
                    "query_embedding": query_embedding,
                    "top_k": int(top_k),
                },
            }
        )
    if rows:
        supabase.table("chat_retrieval_tasks").insert(rows).execute()


def claim_retrieval_task(worker_id: str) -> Optional[Dict[str, Any]]:
    # Grab a few queued tasks, then attempt to atomically claim the first one.
    scan = int(os.getenv("CHAT_CLAIM_SCAN_LIMIT", "25"))
    res = (
        supabase.table("chat_retrieval_tasks")
        .select("*")
        .eq("status", "queued")
        .order("created_at")
        .limit(scan)
        .execute()
    )
    rows = res.data or []
    if not rows:
        return None

    for task in rows:
        claimed = (
            supabase.table("chat_retrieval_tasks")
            .update(
                {
                    "status": "running",
                    "assigned_worker": worker_id,
                    "started_at": now_iso(),
                    "attempts": int(task.get("attempts") or 0) + 1,
                }
            )
            .eq("id", task["id"])
            .eq("status", "queued")
            .execute()
        )
        if claimed.data:
            return claimed.data[0]
    return None


def complete_retrieval_task(task_id: str, result: Dict[str, Any]):
    supabase.table("chat_retrieval_tasks").update(
        {"status": "done", "result": result, "finished_at": now_iso(), "updated_at": now_iso()}
    ).eq("id", task_id).execute()


def fail_retrieval_task(task_id: str, error: str):
    supabase.table("chat_retrieval_tasks").update(
        {"status": "failed", "last_error": str(error), "finished_at": now_iso(), "updated_at": now_iso()}
    ).eq("id", task_id).execute()


def wait_hop_results(chat_job_id: str, hop: int, kinds: List[str], timeout_s: float = 20.0) -> List[Dict[str, Any]]:
    deadline = time.time() + max(1.0, float(timeout_s))
    kinds_set = set(kinds)
    while time.time() < deadline:
        res = (
            supabase.table("chat_retrieval_tasks")
            .select("kind,status,result,last_error")
            .eq("chat_job_id", chat_job_id)
            .eq("hop", int(hop))
            .in_("kind", list(kinds_set))
            .execute()
        )
        rows = res.data or []
        done = [r for r in rows if (r.get("status") == "done")]
        if len(done) >= len(kinds_set):
            out = []
            for r in done:
                rr = r.get("result") or {}
                if isinstance(rr, dict):
                    out.append({"kind": r.get("kind"), **rr})
            return out
        time.sleep(0.35)
    return []
