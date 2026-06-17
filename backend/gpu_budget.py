"""
backend/gpu_budget.py

Dynamic GPU VRAM budgeting so per-stage worker counts can never OOM the GPU —
*without* hardcoding a worker cap.

Why: each GPU pipeline stage (layout_parser, image_captioning, embedding) runs as
separate processes that EACH lazy-load their own model copy into VRAM. So "N workers
for a stage" ~= N model copies, and VRAM use grows linearly with the user's chosen
count → CUDA OOM when N is set too high.

How: the autoscaler (the single, mutex-guarded thread that spawns workers) asks this
module how many model workers actually fit in VRAM and spawns no more than that. The
per-model footprint is LEARNED at runtime (measured around the first real job of each
model stage) and grown when a CUDA OOM is observed, so nothing is hardcoded per model.
The user's chosen count is still honoured up to whatever the hardware can hold; extra
capacity simply isn't spawned (its jobs stay queued and are picked up as workers free).

No torch import here on purpose: this is imported by the CUDA-free parent process, so
VRAM is read via `nvidia-smi` (which does not initialise a CUDA context).
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from contextlib import contextmanager
from typing import Dict, Optional

_STATE_PATH = os.getenv("GPU_BUDGET_FILE") or os.path.join(tempfile.gettempdir(), "synapse_gpu_budget.json")
_LOCK_PATH = _STATE_PATH + ".lock"

# Pipeline order: earlier stages get VRAM priority when the budget is tight.
_ORDER = ["layout_parser", "text_extraction", "image_captioning", "chunking", "embedding", "clustering"]


def _headroom() -> float:
    """Fraction of VRAM kept free for activations/fragmentation (NOT a worker count)."""
    try:
        h = float(os.getenv("GPU_VRAM_HEADROOM", "0.12"))
    except Exception:
        h = 0.12
    return min(0.5, max(0.0, h))


# ── tiny cross-process file lock (stale-safe) ────────────────────────────────────────
@contextmanager
def _locked():
    fd = None
    for _ in range(100):
        try:
            fd = os.open(_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_RDWR)
            break
        except FileExistsError:
            # steal a stale lock (holder died) after a short grace period
            try:
                if time.time() - os.path.getmtime(_LOCK_PATH) > 5:
                    os.remove(_LOCK_PATH)
                    continue
            except Exception:
                pass
            time.sleep(0.02)
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
                os.remove(_LOCK_PATH)
            except Exception:
                pass


def _read() -> dict:
    try:
        with open(_STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _write(d: dict) -> None:
    try:
        with open(_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(d, f)
    except Exception:
        pass


# ── VRAM via nvidia-smi (no CUDA context) ────────────────────────────────────────────
def _smi(query: str) -> Optional[int]:
    """First GPU's `query` (e.g. memory.total / memory.free) in MB, or None."""
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        line = (out.stdout or "").strip().splitlines()[0]
        return int(line.split(",")[0].strip())
    except Exception:
        return None


def vram_total_mb() -> int:
    s = _read()
    t = int(s.get("vram_total_mb") or 0)
    if t > 0:
        return t
    t = _smi("memory.total") or 0
    if t > 0:
        with _locked():
            s = _read()
            s["vram_total_mb"] = t
            _write(s)
    return t


def free_mb() -> Optional[int]:
    return _smi("memory.free")


def usable_budget_mb() -> float:
    """The VRAM ceiling the SUM of resident model footprints must stay under."""
    t = vram_total_mb()
    return t * (1.0 - _headroom()) if t > 0 else 0.0


# ── learned per-stage footprints ─────────────────────────────────────────────────────
def footprint_mb(stage: str) -> Optional[float]:
    v = (_read().get("footprint_mb") or {}).get(stage)
    return float(v) if v else None


def _store_footprint(stage: str, mb: float) -> None:
    if mb <= 0:
        return
    with _locked():
        s = _read()
        fp = s.setdefault("footprint_mb", {})
        fp[stage] = max(float(fp.get(stage, 0.0)), float(mb))
        _write(s)


def record_drop(stage: str, free_before_mb: Optional[int]) -> None:
    """Call right after a model stage's FIRST job: footprint = how much VRAM the load +
    inference consumed (device-free dropped by this much). Only the first model worker of
    a stage runs (1 slot until measured), so the reading is clean."""
    if free_before_mb is None:
        return
    now = free_mb()
    if now is None:
        return
    used = free_before_mb - now
    if used > 0:
        _store_footprint(stage, used)


def bump_footprint(stage: str, factor: float = 1.25) -> None:
    """Observed an OOM (or near-miss) for this stage → grow the estimate so the next
    autoscale tick spawns fewer workers. Self-correcting if the measurement was optimistic."""
    cur = footprint_mb(stage)
    if cur:
        _store_footprint(stage, cur * factor)
    else:
        b = usable_budget_mb()
        if b > 0:
            _store_footprint(stage, b)  # force a single slot until a real measurement lands


def note_exception(stage: str, exc: BaseException) -> None:
    msg = str(exc).lower()
    if "out of memory" in msg or "cuda" in msg or "cublas" in msg:
        bump_footprint(stage)


# ── the actual admission decision ────────────────────────────────────────────────────
def slots_for(stage: str) -> int:
    """How many workers of one model stage fit in VRAM on their own. Large number when
    there is no GPU (CPU path is not VRAM-bound); 1 until the footprint is measured."""
    b = usable_budget_mb()
    if b <= 0:
        return 1_000_000
    fp = footprint_mb(stage)
    if not fp or fp <= 0:
        return 1
    return max(1, int(b // fp))


def pack_model_targets(desired: Dict[str, int]) -> Dict[str, int]:
    """Bound desired model-stage worker counts to the VRAM budget. Policy:

    1. Every active model stage gets at least 1 worker — this is the existing safe default
       (one model copy per stage), so we never regress, never deadlock, and the stage's
       footprint always gets measured on its first job.
    2. A stage may scale ABOVE 1 only once its footprint is measured, and only while the
       extra copy's footprint still fits the budget (earliest pipeline stage first).

    Without a GPU (no budget), returns the desired counts unchanged (no VRAM gating)."""
    b = usable_budget_mb()
    if b <= 0:
        return dict(desired)
    stages = [s for s in _ORDER if s in desired] + [s for s in desired if s not in _ORDER]
    out = {s: (1 if desired.get(s, 0) > 0 else 0) for s in desired}
    # VRAM assumed used by the 1-each baseline; an unmeasured active stage is charged the
    # whole budget so it conservatively blocks others from scaling up until it's measured.
    used = sum((footprint_mb(s) or b) * out[s] for s in stages)
    # scale up only MEASURED stages, earliest first, while the next copy fits
    changed = True
    while changed:
        changed = False
        for s in stages:
            fp = footprint_mb(s)
            if fp and out[s] < desired.get(s, 0) and used + fp <= b:
                out[s] += 1
                used += fp
                changed = True
    return out
