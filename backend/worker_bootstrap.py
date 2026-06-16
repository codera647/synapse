# worker_bootstrap.py
import os
import time
import signal
import tempfile
import threading
import multiprocessing as mp
from env_bootstrap import load_env
from hardware import auto_worker_plan
from sync_worker import (
    run_sync,
    claim_job,
    complete_job,
    claim_sync_stage_job,
    run_sync_stage_job,
)

load_env()

_POOL_STARTED = False
# Cross-platform default (Colab hardcoded /tmp); still overridable via WORKER_POOL_LOCK.
_POOL_LOCK_PATH = os.getenv("WORKER_POOL_LOCK") or os.path.join(
    tempfile.gettempdir(), "synapse_worker_pool.lock"
)


def _pid_alive(pid: int) -> bool:
    try:
        # Works on Unix. On Windows, this raises for most PIDs; Colab is Unix.
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _acquire_pool_lock() -> bool:
    """
    Prevent accidentally starting multiple worker pools (common when the backend cell is re-run,
    or a server reload/import occurs). If an existing pool PID is alive, we refuse to start a new pool.
    """
    try:
        if os.path.exists(_POOL_LOCK_PATH):
            raw = ""
            try:
                with open(_POOL_LOCK_PATH, "r", encoding="utf-8") as f:
                    raw = (f.read() or "").strip()
            except Exception:
                raw = ""
            if raw.isdigit() and _pid_alive(int(raw)):
                print(f"[worker-pool] lock exists; pool already started (pid={raw}).")
                return False
            # Stale lock
            try:
                os.remove(_POOL_LOCK_PATH)
            except Exception:
                pass

        with open(_POOL_LOCK_PATH, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        return True
    except Exception:
        # If lock can't be created, still start (best effort).
        return True

def preprocess_worker(worker_id: int, stop_event: mp.Event):
    print(f"[preprocess-{worker_id}] started")
    while not stop_event.is_set():
        job = claim_job()
        if not job:
            time.sleep(2)
            continue
        try:
            run_sync(job)
            complete_job(job["id"])
        except Exception as exc:
            complete_job(job["id"], str(exc))
            time.sleep(1)
    print(f"[preprocess-{worker_id}] stopped")


def sync_batch_worker(worker_id: int, stop_event: mp.Event):
    wid = f"sync-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_sync_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_sync_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def layout_worker(worker_id: int, stop_event: mp.Event):
    # Import inside the process so uvicorn can boot even if layout deps aren't installed yet,
    # and to avoid initializing CUDA in the parent process.
    from layout_worker import claim_layout_stage_job, run_layout_stage_job
    wid = f"layout-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_layout_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_layout_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def extraction_worker(worker_id: int, stop_event: mp.Event):
    # Import inside the process so uvicorn can boot even if extraction deps aren't installed yet.
    from extraction_worker import claim_text_extraction_stage_job, run_text_extraction_stage_job

    wid = f"extract-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_text_extraction_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_text_extraction_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def caption_worker(worker_id: int, stop_event: mp.Event):
    # Import inside the process so uvicorn can boot even if caption deps aren't installed yet.
    from caption_worker import claim_caption_stage_job, run_caption_stage_job

    wid = f"caption-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_caption_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_caption_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def chunk_worker(worker_id: int, stop_event: mp.Event):
    # Import inside the process so uvicorn can boot even if deps aren't installed yet.
    from chunk_worker import claim_chunk_stage_job, run_chunk_stage_job

    wid = f"chunk-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_chunk_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_chunk_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def embed_worker(worker_id: int, stop_event: mp.Event):
    # Import inside the process to avoid loading torch/models in the parent.
    from embed_worker import claim_embedding_stage_job, run_embedding_stage_job

    wid = f"embed-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_embedding_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_embedding_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def cluster_worker(worker_id: int, stop_event: mp.Event):
    from cluster_worker import claim_clustering_stage_job, run_clustering_stage_job

    wid = f"cluster-{worker_id}"
    print(f"[{wid}] started")
    while not stop_event.is_set():
        stage_job = claim_clustering_stage_job(wid)
        if not stage_job:
            time.sleep(2)
            continue
        try:
            run_clustering_stage_job(stage_job)
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


def chat_retriever_worker(worker_id: int, stop_event: mp.Event):
    # Import inside the process so uvicorn can boot even if chat deps aren't installed yet.
    from chat_retriever_worker import worker_loop

    os.environ["WORKER_ID"] = f"chat-retriever-{worker_id}"
    wid = os.environ["WORKER_ID"]
    print(f"[{wid}] started")
    while not stop_event.is_set():
        try:
            worker_loop()
        except Exception:
            time.sleep(1)
    print(f"[{wid}] stopped")


# ── Worker-pool registry (user-tunable counts + live reconcile) ──────────────────────
# Map each pipeline stage to its wrapper loop (defined above). "sync" here = the batch
# sync workers; preprocess_worker (creates batches) + the watchdog are tracked separately.
_STAGE_TARGETS = {
    "sync": sync_batch_worker,
    "layout_parser": layout_worker,
    "text_extraction": extraction_worker,
    "image_captioning": caption_worker,
    "chunking": chunk_worker,
    "embedding": embed_worker,
    "clustering": cluster_worker,
    "chat_retriever": chat_retriever_worker,
}

# stage -> list of {"proc": Process, "stop": Event}. Per-worker stop events let us scale a
# single stage down without touching the others.
_STAGE_WORKERS: dict = {}
_MASTER_STOP = None
_EXTRA_PROCS: list = []  # preprocess + watchdog

_STAGE_ENV = {
    "sync": "SYNC_WORKERS",
    "layout_parser": "LAYOUT_WORKERS",
    "text_extraction": "EXTRACT_WORKERS",
    "image_captioning": "CAPTION_WORKERS",
    "chunking": "CHUNK_WORKERS",
    "embedding": "EMBED_WORKERS",
    "clustering": "CLUSTER_WORKERS",
    "chat_retriever": "CHAT_RETRIEVER_WORKERS",
}

# Stages that each load a heavy model into the GPU/RAM — running many copies just OOMs the box and
# contends on the single GPU, so they're hard-capped low regardless of the user's per-stage number.
_MODEL_STAGES = {"layout_parser", "image_captioning", "embedding"}
# Serialize all pool mutations (the autoscaler thread + the Settings route can both reconcile).
_POOL_MUTEX = threading.Lock()
_AUTOSCALER_STARTED = False

# Pipeline order — used to prioritise earlier stages when the global cap is tight.
_STAGE_ORDER = ["sync", "layout_parser", "text_extraction", "image_captioning",
                "chunking", "embedding", "clustering", "chat_retriever"]
# Batch-pipeline stages the autoscaler manages (chat_retriever is excluded — it polls the chat
# queue, not batch_stage_jobs, so it's spawned once at startup and left alone).
_PIPELINE_STAGES = [s for s in _STAGE_ORDER if s != "chat_retriever"]


def _watchdog_proc(stop_event):
    try:
        from watchdog import watchdog_loop
        watchdog_loop(stop_event)
    except Exception as exc:
        print(f"[watchdog] failed to start: {exc}")


def _sb_client():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return None
    from supabase import create_client
    return create_client(url, key)


def _row_to_counts(row: dict) -> dict:
    out = {}
    for s in _STAGE_TARGETS:
        v = (row or {}).get(s)
        if v is not None:
            try:
                out[s] = max(0, int(v))
            except Exception:
                pass
    return out


def _load_worker_config() -> dict:
    """Per-stage counts that drive the LIVE pool. The worker pool is a single shared resource
    (one VM, one set of processes), so the most-recently-saved user's config wins. Per-user rows
    keep each account's *saved* settings separate; this just picks which one the pool runs.
    Returns {} if the table is missing/empty so env + auto-plan stay the fallback."""
    try:
        sb = _sb_client()
        if sb is None:
            return {}
        rows = (
            sb.table("pipeline_worker_config")
            .select("*")
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
            .data
            or []
        )
        return _row_to_counts(rows[0]) if rows else {}
    except Exception:
        return {}


def _user_worker_config(user_id: str) -> dict:
    """One specific user's saved per-stage counts (for showing them their OWN settings in the UI),
    independent of whose config is currently driving the pool. {} if none saved."""
    try:
        sb = _sb_client()
        if sb is None or not user_id:
            return {}
        rows = (
            sb.table("pipeline_worker_config")
            .select("*")
            .eq("user_id", str(user_id))
            .limit(1)
            .execute()
            .data
            or []
        )
        return _row_to_counts(rows[0]) if rows else {}
    except Exception:
        return {}


def _auto_suggested() -> dict:
    plan = auto_worker_plan()
    return {
        "sync": int(plan.get("sync_workers") or 1),
        "layout_parser": 1,
        "text_extraction": int(plan.get("extract_workers") or 2),
        "image_captioning": 1,
        "chunking": 1,
        "embedding": int(plan.get("embed_workers") or 1),
        "clustering": 1,  # clustering re-enabled: it powers cluster-routed retrieval + finalizes
        "chat_retriever": 0,
    }


def _resolve_counts() -> dict:
    """Effective per-stage worker count: DB config -> env var -> auto hardware plan."""
    auto = _auto_suggested()
    cfg = _load_worker_config()
    counts = {}
    for stage in _STAGE_TARGETS:
        if stage in cfg:
            counts[stage] = cfg[stage]
            continue
        ev = os.getenv(_STAGE_ENV[stage])
        if ev is not None and ev.strip() != "":
            try:
                counts[stage] = max(0, int(ev))
                continue
            except Exception:
                pass
        counts[stage] = max(0, int(auto[stage]))
    return counts


def _alive_workers(stage: str) -> list:
    lst = [w for w in _STAGE_WORKERS.get(stage, []) if w["proc"].is_alive()]
    _STAGE_WORKERS[stage] = lst
    return lst


def _spawn_stage(stage: str, n: int) -> None:
    target = _STAGE_TARGETS.get(stage)
    if not target or n <= 0:
        return
    lst = _STAGE_WORKERS.setdefault(stage, [])
    base = len(lst)
    print(f"[pool] spawning {n} '{stage}' worker(s) (had {base})")
    for i in range(n):
        ev = mp.Event()
        p = mp.Process(target=target, args=(base + i + 1, ev))
        p.start()
        lst.append({"proc": p, "stop": ev})


def _all_procs() -> list:
    procs = list(_EXTRA_PROCS)
    for lst in _STAGE_WORKERS.values():
        procs.extend(w["proc"] for w in lst)
    return procs


# ── Demand-driven scheduling ─────────────────────────────────────────────────────────
# Workers are NOT all pre-spawned. An autoscaler thread looks at which stages actually have
# pending work and spawns workers only for those (bounded by a global cap), shifting capacity as
# work flows sync -> ... -> clustering. This keeps the process count (and torch-import RAM) small
# and prevents the "31 idle workers OOM the box" failure.

def _pending_by_stage() -> dict:
    """{stage: (pending_count, set(library_ids))} for jobs that are queued or running."""
    try:
        sb = _sb_client()
        if sb is None:
            return {}
        rows = (
            sb.table("batch_stage_jobs")
            .select("stage, library_id, status")
            .in_("status", ["queued", "running"])
            .limit(20000)
            .execute()
            .data
            or []
        )
        out: dict = {}
        for r in rows:
            st = r.get("stage")
            if st not in _STAGE_TARGETS:
                continue
            cnt, libs = out.get(st, (0, set()))
            lid = r.get("library_id")
            out[st] = (cnt + 1, libs | ({lid} if lid else set()))
        return out
    except Exception:
        return {}


def _owner_configs_for_libs(lib_ids: set) -> list:
    """Per-stage configs of the OWNERS of the libraries that currently have work. This is what makes
    the live pool honour *the processing user's* settings (not whoever saved settings last)."""
    try:
        sb = _sb_client()
        if sb is None or not lib_ids:
            return []
        libs = sb.table("libraries").select("id, organization_id").in_("id", list(lib_ids)).execute().data or []
        org_ids = {l.get("organization_id") for l in libs if l.get("organization_id")}
        if not org_ids:
            return []
        owners = (
            sb.table("organization_members").select("user_id, role")
            .in_("organization_id", list(org_ids)).eq("role", "owner").execute().data or []
        )
        cfgs = []
        for uid in {o.get("user_id") for o in owners if o.get("user_id")}:
            c = _user_worker_config(uid)
            if c:
                cfgs.append(c)
        return cfgs


    except Exception:
        return []


def _global_cap() -> int:
    # High by default = honour the user's per-stage settings. It's only a runaway backstop (e.g.,
    # many stages overlapping); lower POOL_MAX_WORKERS on a tiny-RAM box if needed.
    return max(1, int(os.getenv("POOL_MAX_WORKERS", "64")))


def _apply_global_cap(targets: dict, cap: int) -> dict:
    """Keep total workers <= cap. Give every active stage at least 1 (earliest pipeline stages
    first); distribute any remaining budget toward each stage's desired count, earliest first."""
    if sum(targets.get(s, 0) for s in _PIPELINE_STAGES) <= cap:
        return targets
    capped = {s: (1 if targets.get(s, 0) > 0 else 0) for s in _PIPELINE_STAGES}
    base = sum(capped.values())
    if base > cap:  # more active stages than the cap — drop the latest stages
        for s in reversed(_PIPELINE_STAGES):
            if base <= cap:
                break
            if capped.get(s, 0) > 0:
                capped[s] = 0
                base -= 1
        return capped
    budget = cap - base
    for s in _PIPELINE_STAGES:
        if budget <= 0:
            break
        want = targets.get(s, 0)
        if want > capped.get(s, 0):
            add = min(want - capped[s], budget)
            capped[s] += add
            budget -= add
    return capped


def _compute_targets() -> dict:
    """Desired workers per stage = min(owner-configured, pending jobs), with model stages hard-capped
    and the whole pool bounded by POOL_MAX_WORKERS. Stages with no pending work get 0."""
    pending = _pending_by_stage()
    targets = {s: 0 for s in _PIPELINE_STAGES}
    if not pending:
        return targets
    all_libs = set()
    for _, libs in pending.values():
        all_libs |= libs
    owner_cfgs = _owner_configs_for_libs(all_libs)
    auto = _auto_suggested()

    def _cfg_max(stage: str) -> int:
        vals = [c[stage] for c in owner_cfgs if stage in c]
        if vals:
            return max(vals)
        ev = os.getenv(_STAGE_ENV[stage])
        if ev is not None and ev.strip() != "":
            try:
                return max(0, int(ev))
            except Exception:
                pass
        return int(auto.get(stage, 0))

    # Honour each stage's configured worker count, limited only by how many batches are actually
    # waiting for that stage (no point spawning 8 sync workers for 3 pending batches).
    for stage, (count, _libs) in pending.items():
        targets[stage] = max(0, min(_cfg_max(stage), count))
    return _apply_global_cap(targets, _global_cap())


def _recover_orphans() -> None:
    """On (re)start, any job left 'running' was orphaned by a crash (e.g., OOM kill) — no live worker
    can own it. Requeue them and surface a clear, visible message on the library so the frontend
    stops showing a silent 'running' that's actually dead."""
    try:
        sb = _sb_client()
        if sb is None:
            return
        rows = sb.table("batch_stage_jobs").select("id, library_id").eq("status", "running").limit(5000).execute().data or []
        if not rows:
            return
        ids = [r["id"] for r in rows]
        lib_ids = {r.get("library_id") for r in rows if r.get("library_id")}
        for i in range(0, len(ids), 200):
            sb.table("batch_stage_jobs").update(
                {"status": "queued", "assigned_worker": None, "started_at": None}
            ).in_("id", ids[i : i + 200]).eq("status", "running").execute()
        for lib in lib_ids:
            sb.table("libraries").update(
                {"pipeline_error": "Processing was interrupted (the server restarted — possibly out of "
                                   "memory). It is resuming automatically."}
            ).eq("id", lib).neq("pipeline_status", "completed").execute()
        print(f"[pool] recovered {len(ids)} orphaned 'running' jobs across {len(lib_ids)} libraries (prior crash/OOM)")
    except Exception as exc:
        print(f"[pool] orphan recovery error: {exc}")


def _autoscale_loop(stop_event) -> None:
    tick = max(2, int(float(os.getenv("POOL_TICK_SECONDS", "6"))))
    print(f"[pool-autoscaler] started (global cap {_global_cap()}, model-stage cap "
          f"{os.getenv('POOL_MODEL_STAGE_MAX', '1')}, every {tick}s)")
    while not stop_event.is_set():
        try:
            reconcile_pool(_compute_targets())
        except Exception as exc:
            print(f"[pool-autoscaler] error: {exc}")
        for _ in range(tick):
            if stop_event.is_set():
                break
            time.sleep(1)
    print("[pool-autoscaler] stopped")


def reconcile_pool(targets: dict) -> dict:
    """Scale stages to `targets` live. Scale-up spawns workers (they just claim queued
    jobs); scale-down signals the extra workers to exit on their next loop check."""
    applied = {}
    with _POOL_MUTEX:
        for stage, target in (targets or {}).items():
            if stage not in _STAGE_TARGETS:
                continue
            try:
                target = max(0, int(target))
            except Exception:
                continue
            alive = _alive_workers(stage)
            if target > len(alive):
                _spawn_stage(stage, target - len(alive))
            elif target < len(alive):
                for w in alive[target:]:
                    w["stop"].set()
            applied[stage] = target
    return applied


def get_pool_status(user_id: str | None = None) -> dict:
    """Pool status for the Settings UI. When `user_id` is given, `configured` reflects THAT user's
    own saved counts (so each account sees its own numbers) merged over the auto plan; otherwise it
    reflects the counts currently driving the live pool (latest writer)."""
    auto = _auto_suggested()
    if user_id is not None:
        user_cfg = _user_worker_config(user_id)
        configured = {stage: int(user_cfg.get(stage, auto.get(stage, 0))) for stage in _STAGE_TARGETS}
    else:
        configured = _resolve_counts()
    return {
        "auto_suggested": auto,
        "configured": configured,
        "running": {stage: len(_alive_workers(stage)) for stage in _STAGE_TARGETS},
        "started": _POOL_STARTED,
    }


def start_worker_pool():
    global _POOL_STARTED, _MASTER_STOP, _EXTRA_PROCS
    if _POOL_STARTED:
        print("[worker-pool] already started in this process.")
        return mp.Event(), []

    if not _acquire_pool_lock():
        # Another pool is running; avoid spawning duplicates.
        return mp.Event(), []

    # CUDA + multiprocessing requires spawn on many platforms (and is the safest default in Colab).
    try:
        mp.set_start_method("spawn", force=True)
    except RuntimeError:
        pass

    print(f"Worker pool: demand-driven (global cap {_global_cap()}). Stage workers are spawned only "
          f"when their stage has pending work, sized by the processing library owner's config.")

    # A prior crash/OOM leaves jobs 'running' with no owner — requeue + surface to the user.
    _recover_orphans()

    _MASTER_STOP = mp.Event()
    _EXTRA_PROCS = []
    _STAGE_WORKERS.clear()
    # Batch creator (claims library_preprocess jobs) — single.
    pp = mp.Process(target=preprocess_worker, args=(1, _MASTER_STOP))
    pp.start()
    _EXTRA_PROCS.append(pp)
    # Stale-job watchdog.
    wp = mp.Process(target=_watchdog_proc, args=(_MASTER_STOP,))
    wp.start()
    _EXTRA_PROCS.append(wp)
    # Autoscaler thread (lives in THIS process so it can manage _STAGE_WORKERS): spawns/stops stage
    # workers based on pending work. No stage workers are pre-spawned.
    global _AUTOSCALER_STARTED
    if not _AUTOSCALER_STARTED:
        t = threading.Thread(target=_autoscale_loop, args=(_MASTER_STOP,), daemon=True, name="pool-autoscaler")
        t.start()
        _AUTOSCALER_STARTED = True

    # chat_retriever polls the chat queue (not batch_stage_jobs), so it isn't autoscaled — spawn it
    # once per its resolved config.
    cr = int(_resolve_counts().get("chat_retriever", 0) or 0)
    if cr > 0:
        _spawn_stage("chat_retriever", cr)

    _POOL_STARTED = True
    return _MASTER_STOP, _all_procs()


def stop_worker_pool(stop_event=None, procs=None):
    global _POOL_STARTED
    if _MASTER_STOP is not None:
        _MASTER_STOP.set()
    for lst in _STAGE_WORKERS.values():
        for w in lst:
            w["stop"].set()
    for p in _all_procs():
        try:
            p.join(timeout=5)
        except Exception:
            pass
    _STAGE_WORKERS.clear()
    _POOL_STARTED = False
