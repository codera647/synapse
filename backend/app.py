"""
backend/app.py

Production entrypoint for running Synapse backend on a long-lived GPU host
(GCP L4 / EC2).

This wraps:
  - FastAPI HTTP API (health/readiness, hardware, pipeline control, chat)
  - background worker pool (sync/layout/extraction/caption/chunk/embed, etc.)

Run (from the backend/ directory, because modules use flat imports):
  cd backend && uvicorn app:app --host 0.0.0.0 --port 8000

Disable the worker pool (API-only mode) with WORKERS_ENABLED=0.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Centralized env loading + HF cache setup happens on import of config/env_bootstrap.
from config import CONFIG
from hardware import auto_worker_plan
from worker_bootstrap import start_worker_pool, stop_worker_pool

# Optional routers — kept import-guarded so the API still boots if an optional
# dependency (e.g. OpenAI for chat) isn't configured yet.
try:
    from chat_api import router as chat_router  # type: ignore
except Exception:  # pragma: no cover
    chat_router = None

try:
    from pipeline_api import router as pipeline_router  # type: ignore
except Exception:  # pragma: no cover
    pipeline_router = None

try:
    from agent_api import router as agent_router  # type: ignore
except Exception:  # pragma: no cover
    agent_router = None

try:
    from kg_api import router as kg_router  # type: ignore
except Exception:  # pragma: no cover
    kg_router = None

try:
    from library_files_api import router as library_files_router  # type: ignore
except Exception:  # pragma: no cover
    library_files_router = None


app = FastAPI(title="Synapse Backend", version="1.0.0")

# Allow a comma-separated list of origins (prod frontend + localhost during dev).
_origins = [o.strip() for o in CONFIG.frontend_origin.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """Liveness: the process is up and serving."""
    return {"ok": True}


@app.get("/hardware")
def hardware():
    """CPU/RAM/VRAM + the auto-computed worker plan."""
    return auto_worker_plan()


@app.get("/ready")
def ready():
    """
    Readiness: is the backend actually configured to do work?
    Reports required-config presence and GPU availability without raising.
    """
    cfg_ok = bool(CONFIG.supabase_url and CONFIG.supabase_service_role_key)
    storage_ok = bool(CONFIG.r2_endpoint and CONFIG.r2_bucket)
    chat_ok = bool(CONFIG.openai_api_key)
    gpu = None
    try:
        import torch  # type: ignore

        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        gpu = None
    return {
        "ready": cfg_ok and storage_ok,
        "supabase_configured": cfg_ok,
        "storage_configured": storage_ok,
        "chat_configured": chat_ok,
        "gpu": gpu,
        "workers_enabled": CONFIG.workers_enabled,
        "hf_home": CONFIG.hf_home,
    }


if chat_router is not None:
    app.include_router(chat_router)

if pipeline_router is not None:
    app.include_router(pipeline_router)

if agent_router is not None:
    app.include_router(agent_router)

if kg_router is not None:
    app.include_router(kg_router)

if library_files_router is not None:
    app.include_router(library_files_router)


_worker_stop = None
_worker_procs = None


@app.on_event("startup")
def on_startup():
    global _worker_stop, _worker_procs
    # Let operators disable background workers (API-only mode) if needed.
    if not CONFIG.workers_enabled:
        print("[startup] WORKERS_ENABLED=0 -> API-only mode (no worker pool).")
        return
    _worker_stop, _worker_procs = start_worker_pool()


@app.on_event("shutdown")
def on_shutdown():
    if _worker_stop and _worker_procs:
        stop_worker_pool(_worker_stop, _worker_procs)
