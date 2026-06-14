import os
import json
import random
import time
from datetime import datetime, timezone

from env_bootstrap import load_env
from supabase import create_client


load_env()

WORKER_ID = os.getenv("WORKER_ID", "cluster-1")


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


def _pipeline_stages():
    import pipeline_config
    return pipeline_config.pipeline_stages()


def _stage_order(stage: str) -> int:
    stages = _pipeline_stages()
    try:
        return stages.index(stage)
    except ValueError:
        return 10_000


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


def claim_clustering_stage_job(worker_id: str):
    # Gate claiming: only claim clustering when embeddings are complete for the library.
    # This avoids a bunch of workers "claiming then re-queueing" and makes worker counts look sane.
    scan = int(os.getenv("CLAIM_SCAN_LIMIT", "25"))
    if scan <= 0:
        scan = 25
    jobs = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "clustering")
        .eq("status", "queued")
        .order("created_at")
        .limit(scan),
        context="batch_stage_jobs.select(clustering.queued)",
    )
    rows = jobs.data or []
    if not rows:
        return None

    # Try to pick the first library that is ready.
    job = None
    # Cache per-library readiness checks in this claim call.
    ready_cache: dict[str, bool] = {}
    for r in rows:
        lib_id = str(r.get("library_id") or "")
        if not lib_id:
            continue
        if lib_id not in ready_cache:
            st = _get_library_pipeline_status(lib_id)
            if st is None or st in _PIPELINE_ABORT_STATUSES:
                ready_cache[lib_id] = False
            else:
                total = _get_total_batches(lib_id)
                done_embed = _count_done_stage_jobs(lib_id, "embedding")
                ready_cache[lib_id] = total > 0 and done_embed >= total
        if ready_cache.get(lib_id):
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
        context="batch_stage_jobs.update(clustering.claim)",
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
    Fall back to counting `library_batches` so clustering can still run.
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
    completed_batches = _count_done_stage_jobs(library_id, stages[-1])
    next_stage = _compute_next_stage(library_id)

    _sb_execute(
        supabase.table("libraries").update(
            {
                "pipeline_status": "running",
                "pipeline_stage": next_stage,
                "pipeline_progress_percent": progress,
                "completed_batches": completed_batches,
            }
        ).eq("id", library_id),
        context="libraries.update(progress)",
    )


def _maybe_finalize_pipeline(library_id: str):
    total_batches = _get_total_batches(library_id)
    if total_batches <= 0:
        return

    # Don't report 100% while any stage job is FAILED.
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


def _choose_k(num_chunks: int) -> int:
    # sqrt heuristic with caps
    k = int(round((num_chunks ** 0.5)))
    k = max(int(os.getenv("CLUSTER_K_MIN", "8")), k)
    k = min(int(os.getenv("CLUSTER_K_MAX", "50")), k)
    k = min(k, max(1, num_chunks))
    return k


def _fetch_all_embeddings(library_id: str, table_name: str) -> tuple[list[str], list[list[float]]]:
    def _parse_vec(v):
        # PostgREST can return pgvector as a JSON-like string (e.g. "[0.1,0.2]") instead of a list.
        # Accept both list and string formats.
        if v is None:
            return None
        if isinstance(v, dict):
            # Some clients may return structured payloads for pgvector.
            for k in ("data", "values", "value", "vector", "embedding"):
                if k in v:
                    return _parse_vec(v.get(k))
            return None
        if isinstance(v, list):
            try:
                return [float(x) for x in v]
            except Exception:
                return None
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            try:
                if s.startswith("[") and s.endswith("]"):
                    arr = json.loads(s)
                    if isinstance(arr, list):
                        return [float(x) for x in arr]
            except Exception:
                pass
            # Fallback for "[...]" / "(...)" / "{...}" / comma-separated.
            s = s.strip("(){}[]")
            if "," in s:
                parts = [p.strip() for p in s.split(",") if p.strip()]
            else:
                # Some renderers return space-separated floats.
                parts = [p.strip() for p in s.split() if p.strip()]
            if not parts:
                return None
            try:
                return [float(p) for p in parts]
            except Exception:
                return None
        return None

    # Fast existence check (helps produce a better error message when parsing fails).
    try:
        head = _sb_execute(
            supabase.table(table_name)
            .select("chunk_id", count="exact", head=True)
            .eq("library_id", library_id),
            context=f"{table_name}.count(library_id)",
            max_attempts=2,
        )
        total_rows = int(head.count or 0)
    except Exception:
        total_rows = -1

    ids: list[str] = []
    vecs: list[list[float]] = []
    page_size = int(os.getenv("CLUSTER_FETCH_PAGE", "1000"))
    offset = 0
    while True:
        resp = _sb_execute(
            supabase.table(table_name)
            .select("chunk_id, embedding")
            .eq("library_id", library_id)
            .range(offset, offset + page_size - 1),
            context=f"{table_name}.select(embeddings)",
        )
        rows = resp.data or []
        if not rows:
            break
        for r in rows:
            cid = str(r.get("chunk_id") or "")
            emb = _parse_vec(r.get("embedding"))
            if not cid or not emb:
                continue
            ids.append(cid)
            vecs.append(emb)
        if len(rows) < page_size:
            break
        offset += page_size

    # If embeddings exist but we couldn't parse any vectors, surface a clearer error.
    if not ids and total_rows > 0:
        sample = _sb_execute(
            supabase.table(table_name)
            .select("chunk_id, embedding")
            .eq("library_id", library_id)
            .limit(1),
            context=f"{table_name}.select(sample_embedding)",
            max_attempts=2,
        )
        sv = None
        if sample.data and isinstance(sample.data[0], dict):
            sv = sample.data[0].get("embedding")
        raise RuntimeError(
            f"Embeddings exist ({total_rows} rows) but none could be parsed. "
            f"Check column type/format for `{table_name}.embedding`. sample_type={type(sv).__name__} sample={str(sv)[:120]}"
        )
    return ids, vecs


def _run_kmeans(ids: list[str], vecs: list[list[float]]) -> tuple[dict[str, int], list[list[float]]]:
    # Default CPU engine: MiniBatchKMeans.
    import numpy as np
    from sklearn.cluster import MiniBatchKMeans  # type: ignore

    x = np.asarray(vecs, dtype="float32")
    k = int(os.getenv("CLUSTER_K", "0")) or _choose_k(int(x.shape[0]))
    batch = int(os.getenv("CLUSTER_BATCH", "2048"))
    km = MiniBatchKMeans(
        n_clusters=k,
        batch_size=batch,
        n_init="auto",
        random_state=42,
        max_iter=int(os.getenv("CLUSTER_MAX_ITER", "200")),
    )
    labels = km.fit_predict(x)
    centers = km.cluster_centers_.astype("float32").tolist()
    mapping = {cid: int(lbl) for cid, lbl in zip(ids, labels)}
    return mapping, centers


def run_clustering_stage_job(stage_job: dict):
    library_id = stage_job["library_id"]
    org_id = stage_job["organization_id"]
    job_id = stage_job["id"]

    st = _get_library_pipeline_status(library_id)
    if st is None or st in _PIPELINE_ABORT_STATUSES:
        try:
            _mark_stage_job_canceled(job_id, f"Aborted (library pipeline_status={st or 'missing'}).")
        except Exception:
            pass
        return

    # Ensure embeddings are complete before clustering.
    total_batches = _get_total_batches(library_id)
    if total_batches <= 0:
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": "Missing total_batches; cannot cluster.", "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(clustering.failed.missing_total_batches)",
        )
        raise RuntimeError("Missing total_batches; cannot cluster.")
    if _count_done_stage_jobs(library_id, "embedding") < total_batches:
        # Re-queue and try later.
        _sb_execute(
            supabase.table("batch_stage_jobs").update({"status": "queued", "assigned_worker": None}).eq("id", job_id),
            context="batch_stage_jobs.update(clustering.requeue.wait_embed)",
        )
        time.sleep(2)
        return

    # Library-level lock via table.
    run_table = os.getenv("CLUSTER_RUN_TABLE", "library_cluster_runs").strip() or "library_cluster_runs"
    emb_table = os.getenv("EMBED_TABLE", "chunk_embeddings").strip() or "chunk_embeddings"
    cluster_table = os.getenv("CLUSTER_TABLE", "library_clusters").strip() or "library_clusters"

    # If already completed, mark this job done.
    existing = _sb_execute(
        supabase.table(run_table).select("status").eq("library_id", library_id).limit(1),
        context=f"{run_table}.select(status)",
    )
    if existing.data and str(existing.data[0].get("status") or "") == "done":
        _sb_execute(
            supabase.table("batch_stage_jobs").update({"status": "done", "finished_at": now_iso()}).eq("id", job_id),
            context="batch_stage_jobs.update(clustering.done.fast)",
        )
        _update_library_progress(library_id)
        _maybe_finalize_pipeline(library_id)
        return

    # Acquire lock (best effort). If previous run failed, allow takeover.
    lock_ok = False
    prev_status = str(existing.data[0].get("status") or "") if existing.data else ""
    if prev_status == "failed":
        _sb_execute(
            supabase.table(run_table).upsert(
                {
                    "library_id": library_id,
                    "organization_id": org_id,
                    "status": "running",
                    "started_at": now_iso(),
                    "finished_at": None,
                    "last_error": None,
                    "updated_at": now_iso(),
                },
                on_conflict="library_id",
            ),
            context=f"{run_table}.upsert(lock.failed_takeover)",
        )
        lock_ok = True
    else:
        try:
            _sb_execute(
                supabase.table(run_table).insert(
                    {
                        "library_id": library_id,
                        "organization_id": org_id,
                        "status": "running",
                        "started_at": now_iso(),
                        "updated_at": now_iso(),
                    }
                ),
                context=f"{run_table}.insert(lock)",
            )
            lock_ok = True
        except Exception:
            # Someone else is clustering. Re-queue.
            lock_ok = False

    if not lock_ok:
        _sb_execute(
            supabase.table("batch_stage_jobs").update({"status": "queued", "assigned_worker": None}).eq("id", job_id),
            context="batch_stage_jobs.update(clustering.requeue.lock_busy)",
        )
        time.sleep(2)
        return

    try:
        _sb_execute(
            supabase.table("libraries").update({"pipeline_status": "running", "pipeline_stage": "clustering"}).eq(
                "id", library_id
            ),
            context="libraries.update(stage.clustering)",
        )

        ids, vecs = _fetch_all_embeddings(library_id, emb_table)
        if not ids:
            raise RuntimeError("No embeddings found for library; cannot cluster.")

        mapping, centers = _run_kmeans(ids, vecs)

        # Annotate EXISTING chunk rows with their cluster_id using UPDATE (never upsert): an upsert
        # with a partial {chunk_id, cluster_id} payload INSERTs a phantom row with null
        # organization_id (NOT NULL) for any chunk_id that doesn't already exist, which is the
        # `23502 null value in column "organization_id"` failure. Group by cluster so this is a
        # handful of bulk UPDATE ... WHERE chunk_id IN (...) calls; non-existent ids simply no-op.
        from collections import defaultdict

        by_cluster: dict[int, list[str]] = defaultdict(list)
        for cid, lbl in mapping.items():
            by_cluster[int(lbl)].append(cid)
        page = int(os.getenv("CLUSTER_UPDATE_PAGE", "300"))
        for lbl, cids in by_cluster.items():
            for i in range(0, len(cids), page):
                part = cids[i : i + page]
                _sb_execute(
                    supabase.table(emb_table).update({"cluster_id": lbl}).in_("chunk_id", part),
                    context=f"{emb_table}.update(cluster_id)",
                )

        # Write cluster centroids + size for routing/UI.
        counts: dict[int, int] = {}
        for lbl in mapping.values():
            counts[int(lbl)] = counts.get(int(lbl), 0) + 1
        cluster_rows = []
        for cid, center in enumerate(centers):
            cluster_rows.append(
                {
                    "organization_id": org_id,
                    "library_id": library_id,
                    "cluster_id": int(cid),
                    "size": int(counts.get(int(cid), 0)),
                    "centroid": center,
                    "updated_at": now_iso(),
                }
            )
        if cluster_rows:
            _sb_execute(
                supabase.table(cluster_table).upsert(cluster_rows, on_conflict="library_id,cluster_id"),
                context=f"{cluster_table}.upsert",
            )

        _sb_execute(
            supabase.table(run_table).upsert(
                {
                    "library_id": library_id,
                    "organization_id": org_id,
                    "status": "done",
                    "finished_at": now_iso(),
                    "updated_at": now_iso(),
                    "last_error": None,
                },
                on_conflict="library_id",
            ),
            context=f"{run_table}.upsert(done)",
        )

        # Mark all clustering jobs for this library done (single library-level run).
        _sb_execute(
            supabase.table("batch_stage_jobs")
            .update({"status": "done", "finished_at": now_iso()})
            .eq("library_id", library_id)
            .eq("stage", "clustering")
            .neq("status", "done"),
            context="batch_stage_jobs.update(clustering.done.all)",
        )

        _update_library_progress(library_id)
        _maybe_finalize_pipeline(library_id)
    except Exception as exc:
        import traceback

        from errors import friendly_error

        _emsg = friendly_error(exc)
        print(f"[cluster] FAILED library={library_id}: {exc}")
        traceback.print_exc()
        _sb_execute(
            supabase.table(run_table).upsert(
                {
                    "library_id": library_id,
                    "organization_id": org_id,
                    "status": "failed",
                    "finished_at": now_iso(),
                    "updated_at": now_iso(),
                    "last_error": _emsg,
                },
                on_conflict="library_id",
            ),
            context=f"{run_table}.upsert(failed)",
        )
        _sb_execute(
            supabase.table("batch_stage_jobs").update({"status": "failed", "last_error": _emsg}).eq("id", job_id),
            context="batch_stage_jobs.update(clustering.failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "clustering",
                    "pipeline_error": _emsg,
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(clustering.failed)",
        )
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in clustering: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("CLUSTER_IDLE_LIMIT", "0"))
    # idle_limit=0 means "never exit" (clustering may need to wait for embedding to finish).
    print(f"[{WORKER_ID}] ready (idle_limit={'never' if idle_limit <= 0 else idle_limit})")
    while True:
        job = claim_clustering_stage_job(WORKER_ID)
        if not job:
            idle += 1
            if idle_limit > 0 and idle >= idle_limit:
                print("No clustering jobs remaining. Exiting.")
                return
            time.sleep(2)
            continue
        idle = 0
        run_clustering_stage_job(job)


if __name__ == "__main__":
    worker_loop()
