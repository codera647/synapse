"""Latency / throughput (paper Figure 6 style).

Reports retrieval-only and end-to-end (deep chat) latency percentiles, plus rough throughput.
All timings come from the `metrics.elapsed_ms` the backend now returns on /retrieve and /chat.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def _pctl(values: List[float], p: float) -> Optional[float]:
    if not values:
        return None
    xs = sorted(values)
    i = min(len(xs) - 1, int(round((p / 100.0) * (len(xs) - 1))))
    return round(xs[i], 1)


def _summary(ms: List[float]) -> Dict[str, Any]:
    if not ms:
        return {"n": 0}
    return {
        "n": len(ms),
        "mean_ms": round(sum(ms) / len(ms), 1),
        "p50_ms": _pctl(ms, 50),
        "p90_ms": _pctl(ms, 90),
        "p99_ms": _pctl(ms, 99),
        "throughput_per_min": round(60000.0 / (sum(ms) / len(ms)), 2),
    }


def score_rows(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    retr = [r["retrieve"]["elapsed_ms"] for r in rows
            if (r.get("retrieve") or {}).get("elapsed_ms") is not None]
    chat = [r["chat"]["elapsed_ms"] for r in rows
            if (r.get("chat") or {}).get("elapsed_ms") is not None]
    return {"retrieval_only": _summary([float(x) for x in retr]),
            "end_to_end_deep_chat": _summary([float(x) for x in chat])}
