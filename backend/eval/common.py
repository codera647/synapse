"""Shared utilities for the Synapse evaluation harness.

Reuses the backend's env + clients so the harness behaves exactly like production:
- Supabase service-role client (create org/library/documents, poll pipeline, read chunk pages)
- R2 (boto3) for uploading raw benchmark files
- HTTP to the running FastAPI backend for /retrieve and /chat
- A live OpenAI spend estimator with a hard cap (protects the small credit pool)

Run modules from the backend/ dir, e.g.:  python -m eval.run_queries --config eval/config.yaml
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

# Make the backend package importable when run as `python -m eval.<mod>` from backend/.
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

import requests  # noqa: E402  (backend dep)

try:
    from env_bootstrap import load_env  # noqa: E402
    load_env()
except Exception:
    pass


# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------
def load_config(path: str) -> Dict[str, Any]:
    import yaml

    p = Path(path)
    if not p.is_absolute():
        p = _BACKEND_DIR / path
    with open(p, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def eval_dir() -> Path:
    return _BACKEND_DIR / "eval"


def run_dir(cfg: Dict[str, Any]) -> Path:
    d = eval_dir() / "runs" / str(cfg.get("run_id") or "demo")
    d.mkdir(parents=True, exist_ok=True)
    return d


def data_dir(cfg: Dict[str, Any]) -> Path:
    raw = (cfg.get("dataset") or {}).get("local_dir") or "data/double_bench"
    d = eval_dir() / raw if not os.path.isabs(raw) else Path(raw)
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------------------
# Clients
# --------------------------------------------------------------------------------------
_SB = None


def get_supabase():
    global _SB
    if _SB is None:
        from supabase import create_client

        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _SB = create_client(url, key)
    return _SB


def get_r2():
    """Returns (s3_client, bucket_name)."""
    import boto3

    s3 = boto3.client(
        "s3",
        endpoint_url=os.getenv("R2_ENDPOINT") or None,
        aws_access_key_id=os.getenv("R2_ACCESS_KEY") or None,
        aws_secret_access_key=os.getenv("R2_SECRET_KEY") or None,
    )
    return s3, os.environ["R2_BUCKET"]


def get_openai():
    from openai import OpenAI

    return OpenAI()  # picks up OPENAI_API_KEY from env


# --------------------------------------------------------------------------------------
# Backend HTTP
# --------------------------------------------------------------------------------------
def backend_post(cfg: Dict[str, Any], path: str, body: Dict[str, Any], timeout: float = 300.0) -> Dict[str, Any]:
    base = (cfg.get("backend_url") or "http://127.0.0.1:8000").rstrip("/")
    url = f"{base}/{path.lstrip('/')}"
    r = requests.post(url, json=body, timeout=timeout)
    r.raise_for_status()
    return r.json()


# --------------------------------------------------------------------------------------
# JSONL helpers
# --------------------------------------------------------------------------------------
def write_jsonl(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def append_jsonl(path: Path, row: Dict[str, Any]) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not Path(path).exists():
        return out
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


# --------------------------------------------------------------------------------------
# Spend estimator + hard cap
# --------------------------------------------------------------------------------------
def approx_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


class SpendTracker:
    """Estimates OpenAI spend from token counts and enforces a hard cap so a run can never
    overrun the credit pool. Prices are $/1M tokens from config (rough — tune to real prices)."""

    def __init__(self, prices: Dict[str, Dict[str, float]], cap_usd: float):
        self.prices = prices or {}
        self.cap_usd = float(cap_usd)
        self.spent = 0.0
        self.by_model: Dict[str, float] = {}

    def _price(self, model: str) -> Dict[str, float]:
        if model in self.prices:
            return self.prices[model]
        # fall back to a moderately-priced default
        return {"input": 2.5, "output": 10.0}

    def add(self, model: str, in_tokens: int, out_tokens: int) -> float:
        p = self._price(model)
        cost = (in_tokens / 1_000_000) * p.get("input", 2.5) + (out_tokens / 1_000_000) * p.get("output", 10.0)
        self.spent += cost
        self.by_model[model] = self.by_model.get(model, 0.0) + cost
        return cost

    def add_flat(self, usd: float, label: str = "generation") -> float:
        """Charge a flat estimated amount (e.g. an agentic /chat call whose tokens we can't see)."""
        usd = float(usd)
        self.spent += usd
        self.by_model[label] = self.by_model.get(label, 0.0) + usd
        return usd

    def add_usage(self, model: str, usage: Any) -> float:
        """Charge from an OpenAI usage object (preferred — uses real token counts)."""
        try:
            it = int(getattr(usage, "prompt_tokens", 0) or 0)
            ot = int(getattr(usage, "completion_tokens", 0) or 0)
        except Exception:
            it, ot = 0, 0
        return self.add(model, it, ot)

    def remaining(self) -> float:
        return max(0.0, self.cap_usd - self.spent)

    def exceeded(self) -> bool:
        return self.spent >= self.cap_usd


def now_ms() -> int:
    return int(time.time() * 1000)
