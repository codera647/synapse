"""
backend/app.py

Production entrypoint for running Synapse backend on a long-lived host (EC2).

This wraps:
  - FastAPI HTTP API (hardware + chat routes)
  - background worker pool (sync/layout/extraction/chunk/embed, etc.)

Run:
  uvicorn backend.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from hardware import auto_worker_plan
from worker_bootstrap import start_worker_pool, stop_worker_pool

# Optional: chat router (kept separate so the backend can still boot if OpenAI isn't configured yet).
try:
    from chat_api import router as chat_router  # type: ignore
except Exception:  # pragma: no cover
    chat_router = None


def _load_env():
    # On EC2 we typically store env in /etc/synapse/backend.env and export it via systemd.
    # This is a best-effort fallback for local runs.
    env_path = os.getenv("SYNAPSE_ENV_FILE", "").strip()
    if env_path and os.path.exists(env_path):
        load_dotenv(env_path)
        return
    # If running from repo root, this is commonly used.
    if os.path.exists(".env"):
        load_dotenv(".env")


_load_env()

app = FastAPI()

frontend_origin = (os.getenv("FRONTEND_ORIGIN") or "http://localhost:3000").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/hardware")
def hardware():
    return auto_worker_plan()


if chat_router is not None:
    app.include_router(chat_router)


_worker_stop = None
_worker_procs = None


@app.on_event("startup")
def on_startup():
    global _worker_stop, _worker_procs
    # Let operators disable background workers (API-only mode) if needed.
    if str(os.getenv("WORKERS_ENABLED", "1")).strip() in {"0", "false", "False"}:
        return
    _worker_stop, _worker_procs = start_worker_pool()


@app.on_event("shutdown")
def on_shutdown():
    if _worker_stop and _worker_procs:
        stop_worker_pool(_worker_stop, _worker_procs)

