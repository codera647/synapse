"""
Centralized environment loading for non-Colab deployments.

Colab notebooks historically used /workspace/.env. On EC2 (or other hosts) we
keep secrets outside the repo and provide them via:
  - systemd EnvironmentFile, or
  - SYNAPSE_ENV_FILE pointing to a .env file, or
  - repo-root .env (dev only)
"""

from __future__ import annotations

import os
from dotenv import load_dotenv


def load_env() -> None:
    # Prefer explicit env file if set.
    env_path = (os.getenv("SYNAPSE_ENV_FILE") or "").strip()
    if env_path and os.path.exists(env_path):
        load_dotenv(env_path)
        return

    # Legacy Colab path.
    if os.path.exists("/workspace/.env"):
        load_dotenv("/workspace/.env")
        return

    # Local dev fallback.
    if os.path.exists(".env"):
        load_dotenv(".env")

