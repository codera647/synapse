"""
backend/config.py

Single source of truth for environment-derived configuration on a long-lived
GPU host (GCP L4 / EC2). This module is intentionally light: it does NOT replace
the per-worker `os.getenv(...)` calls (those stay for conservative compatibility),
it centralizes the values that were fragile or Colab-specific so they are easy to
audit and override in one place.

Import side effects:
  - loads env via env_bootstrap.load_env()
  - pins the HuggingFace cache directory (HF_HOME) to a stable, on-disk location
    so models download once and survive process restarts (Colab re-downloaded
    every session; a GPU instance should not).

Usage:
  from config import CONFIG
  CONFIG.r2_bucket, CONFIG.qwen_model, CONFIG.embed_device, ...
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from typing import Optional

from env_bootstrap import load_env

load_env()


def _bool(name: str, default: bool = False) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _str(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _default_hf_home() -> str:
    # Prefer an explicit value, then a stable per-user cache, then a temp fallback.
    explicit = _str("HF_HOME") or _str("HUGGINGFACE_HUB_CACHE")
    if explicit:
        return explicit
    home = os.path.expanduser("~")
    if home and os.path.isdir(home):
        return os.path.join(home, ".cache", "huggingface")
    return os.path.join(tempfile.gettempdir(), "hf-cache")


def _ensure_hf_home() -> str:
    hf_home = _default_hf_home()
    try:
        os.makedirs(hf_home, exist_ok=True)
    except Exception:
        pass
    # Set both so transformers / huggingface_hub / sentence-transformers agree.
    os.environ.setdefault("HF_HOME", hf_home)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", hf_home)
    os.environ.setdefault("TRANSFORMERS_CACHE", hf_home)
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", hf_home)
    return hf_home


def _default_pool_lock() -> str:
    # Cross-platform writable default (Colab used /tmp directly).
    return _str("WORKER_POOL_LOCK") or os.path.join(
        tempfile.gettempdir(), "synapse_worker_pool.lock"
    )


@dataclass(frozen=True)
class Config:
    # --- Supabase ---
    supabase_url: str = field(default_factory=lambda: _str("SUPABASE_URL"))
    supabase_service_role_key: str = field(
        default_factory=lambda: _str("SUPABASE_SERVICE_ROLE_KEY")
    )

    # --- Object storage (S3-compatible: R2 / AWS S3) ---
    r2_endpoint: str = field(default_factory=lambda: _str("R2_ENDPOINT"))
    r2_bucket: str = field(default_factory=lambda: _str("R2_BUCKET"))
    r2_access_key: str = field(default_factory=lambda: _str("R2_ACCESS_KEY"))
    r2_secret_key: str = field(default_factory=lambda: _str("R2_SECRET_KEY"))

    # --- Chat / OpenAI ---
    openai_api_key: str = field(default_factory=lambda: _str("OPENAI_API_KEY"))
    chat_gpt_model: str = field(
        default_factory=lambda: _str("CHAT_GPT_MODEL", "gpt-4o-mini")
    )

    # --- Models (IDs + devices are env-overridable) ---
    embed_model: str = field(
        default_factory=lambda: _str("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    )
    embed_device: str = field(default_factory=lambda: _str("EMBED_DEVICE"))
    qwen_model: str = field(
        default_factory=lambda: _str("VIS_QWEN_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
    )
    doclayout_repo: str = field(
        default_factory=lambda: _str("DOCLAYOUT_YOLO_REPO", "juliozhao/DocLayout-YOLO-DocStructBench")
    )

    # --- HTTP API ---
    frontend_origin: str = field(
        default_factory=lambda: _str("FRONTEND_ORIGIN", "http://localhost:3000")
    )
    workers_enabled: bool = field(default_factory=lambda: _bool("WORKERS_ENABLED", True))

    # --- Worker pool ---
    worker_pool_lock: str = field(default_factory=_default_pool_lock)

    # --- HF cache (resolved + exported on import) ---
    hf_home: str = field(default_factory=_ensure_hf_home)

    def require(self, *names: str) -> None:
        """Raise a clear error if any required attribute is empty."""
        missing = [n for n in names if not getattr(self, n, "")]
        if missing:
            raise RuntimeError("Missing required config: " + ", ".join(missing))


CONFIG = Config()
