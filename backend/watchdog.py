"""
backend/watchdog.py

Stale-job reaper. Workers claim a `batch_stage_jobs` row, set it to `running`, and
mark it `done` when finished. If a worker crashes (OOM, killed, network death) the row
is left `running` forever — nothing re-queues it, so the library stalls below 100%
(this is adjacent to the "stuck at 85%" failure mode).

The watchdog periodically finds jobs that have been `running` longer than
WATCHDOG_STALE_SECONDS and:
  - requeues them (status -> queued, assigned_worker -> null) if attempts < max, so a
    healthy worker picks them back up;
  - fails them (status -> failed, with a clear error) once they've exceeded
    WATCHDOG_MAX_ATTEMPTS, so the pipeline surfaces a real failure instead of hanging.

`started_at` is set at claim time and is reliable across all workers, so we age on it.
The default timeout is deliberately conservative (a big API-captioning batch can run for
several minutes) — raise WATCHDOG_STALE_SECONDS if legitimate jobs ever get reaped.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone

from supabase import create_client

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cutoff_iso(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def run_once(supabase, stale_seconds: int, max_attempts: int) -> tuple[int, int]:
    """One sweep. Returns (requeued, failed)."""
    cutoff = _cutoff_iso(stale_seconds)
    rows = (
        supabase.table("batch_stage_jobs")
        .select("id, stage, attempts, started_at, library_id")
        .eq("status", "running")
        .lt("started_at", cutoff)
        .limit(500)
        .execute()
        .data
        or []
    )
    requeued = 0
    failed = 0
    for j in rows:
        attempts = int(j.get("attempts") or 0)
        lib_id = j.get("library_id")
        if attempts >= max_attempts:
            supabase.table("batch_stage_jobs").update(
                {
                    "status": "failed",
                    "assigned_worker": None,
                    "last_error": f"stale: exceeded {max_attempts} attempts (watchdog)",
                    "finished_at": _now_iso(),
                }
            ).eq("id", j["id"]).eq("status", "running").execute()
            failed += 1
            # Surface to the frontend instead of an endless "running".
            if lib_id:
                try:
                    supabase.table("libraries").update(
                        {"pipeline_status": "failed", "status": "error",
                         "pipeline_error": "A worker stopped responding (possible out-of-memory) and the "
                                           "job exceeded its retries. Click Resume to continue."}
                    ).eq("id", lib_id).neq("pipeline_status", "completed").execute()
                except Exception:
                    pass
        else:
            supabase.table("batch_stage_jobs").update(
                {"status": "queued", "assigned_worker": None, "started_at": None}
            ).eq("id", j["id"]).eq("status", "running").execute()
            requeued += 1
            if lib_id:
                try:
                    supabase.table("libraries").update(
                        {"pipeline_error": "A worker stalled (possible out-of-memory); auto-retrying."}
                    ).eq("id", lib_id).neq("pipeline_status", "completed").execute()
                except Exception:
                    pass
    return requeued, failed


def watchdog_loop(stop_event) -> None:
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        print("[watchdog] missing Supabase config; watchdog disabled")
        return
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    stale_seconds = int(os.getenv("WATCHDOG_STALE_SECONDS", "1800"))  # 30 min, conservative
    max_attempts = int(os.getenv("WATCHDOG_MAX_ATTEMPTS", "5"))
    interval = max(5, int(os.getenv("WATCHDOG_INTERVAL_SECONDS", "60")))
    print(
        f"[watchdog] started (stale>{stale_seconds}s, max_attempts={max_attempts}, every {interval}s)"
    )
    while not stop_event.is_set():
        try:
            r, f = run_once(supabase, stale_seconds, max_attempts)
            if r or f:
                print(f"[watchdog] requeued={r} failed={f}")
        except Exception as exc:  # never let the watchdog die
            print(f"[watchdog] error: {exc}")
        # responsive sleep
        for _ in range(interval):
            if stop_event.is_set():
                break
            time.sleep(1)
    print("[watchdog] stopped")
