# worker_bootstrap.py
import os
import time
import signal
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
_POOL_LOCK_PATH = os.getenv("WORKER_POOL_LOCK", "/tmp/synapse_worker_pool.lock")


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


def start_worker_pool():
    global _POOL_STARTED
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

    plan = auto_worker_plan()
    count = plan["sync_workers"]
    extract_count = int(os.getenv("EXTRACT_WORKERS", str(plan.get("extract_workers") or 2)))
    caption_count = int(os.getenv("CAPTION_WORKERS", "1"))
    chunk_count = int(os.getenv("CHUNK_WORKERS", "1"))
    embed_count = int(os.getenv("EMBED_WORKERS", str(plan.get("embed_workers") or 0)))
    # Clustering is currently disabled in Synapse (we may re-enable later).
    # Default to 0 so a missing env var never spawns unexpected cluster workers.
    cluster_count = int(os.getenv("CLUSTER_WORKERS", "0"))
    chat_retriever_count = int(os.getenv("CHAT_RETRIEVER_WORKERS", "0"))

    # For GPU stages, more processes often *reduces* throughput due to contention.
    # Default to a single layout worker when a GPU is present; allow env override.
    default_layout = 1 if plan.get("gpu") else 1
    layout_count = int(os.getenv("LAYOUT_WORKERS", str(default_layout)))
    print("Worker plan:", plan)
    print("Layout workers:", layout_count)
    print("Extract workers:", extract_count)
    print("Caption workers:", caption_count)
    print("Chunk workers:", chunk_count)
    print("Embed workers:", embed_count)
    print("Cluster workers:", cluster_count)
    print("Chat retriever workers:", chat_retriever_count)

    stop_event = mp.Event()
    procs = []
    # One preprocess worker creates batches; N sync workers process batches in parallel.
    procs.append(mp.Process(target=preprocess_worker, args=(1, stop_event)))
    procs[-1].start()

    for i in range(count):
        p = mp.Process(target=sync_batch_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(layout_count):
        p = mp.Process(target=layout_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(extract_count):
        p = mp.Process(target=extraction_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(caption_count):
        p = mp.Process(target=caption_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(chunk_count):
        p = mp.Process(target=chunk_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(embed_count):
        p = mp.Process(target=embed_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(cluster_count):
        p = mp.Process(target=cluster_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)
    for i in range(chat_retriever_count):
        p = mp.Process(target=chat_retriever_worker, args=(i + 1, stop_event))
        p.start()
        procs.append(p)

    _POOL_STARTED = True
    return stop_event, procs

def stop_worker_pool(stop_event, procs):
    stop_event.set()
    for p in procs:
        p.join(timeout=5)
