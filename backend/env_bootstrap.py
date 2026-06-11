"""
Centralized environment loading for non-Colab deployments.

On a GPU instance (GCP / EC2) we keep secrets outside the repo and provide them via:
  - systemd EnvironmentFile, or
  - SYNAPSE_ENV_FILE pointing to a .env file, or
  - repo-root .env (dev only)

The legacy Colab path (/workspace/.env) is still accepted last, so old notebooks
keep working, but it is no longer the primary mechanism.
"""

from __future__ import annotations

import os
from dotenv import load_dotenv


def load_env() -> None:
    # Prefer an explicit env file if set (recommended on a server).
    env_path = (os.getenv("SYNAPSE_ENV_FILE") or "").strip()
    if env_path and os.path.exists(env_path):
        load_dotenv(env_path)
        return

    # Local dev fallback (repo root).
    if os.path.exists(".env"):
        load_dotenv(".env")
        return

    # Legacy Colab path (kept last for backward compatibility only).
    if os.path.exists("/workspace/.env"):
        load_dotenv("/workspace/.env")
