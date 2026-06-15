"""Honesty / overconfidence breakdown (paper Figure 5).

For each judged query, cross retrieval success with whether Synapse stood behind a grounded answer:
  hit  & attempt : retrieved the right pages AND answered with grounding
  hit  & refuse  : retrieved the right pages BUT abstained (grounding suppressed / no sources)
  miss & attempt : did NOT retrieve the right pages but answered anyway (overconfident)
  miss & refuse  : did NOT retrieve AND abstained (epistemic humility — the good failure)

`attempt` = NOT chat.abstained (abstained means no grounded source backed the answer).
"""

from __future__ import annotations

from typing import Any, Dict, List

from eval.metrics.retrieval import hit_at_k


def classify(row: Dict[str, Any], k: int = 5, offset: int = 0):
    chat = row.get("chat") or {}
    if "answer" not in chat:
        return None  # not judged
    hit = hit_at_k(row, k, offset)
    if hit is None:
        return None
    attempt = not bool(chat.get("abstained"))
    if hit and attempt:
        return "hit_attempt"
    if hit and not attempt:
        return "hit_refuse"
    if (not hit) and attempt:
        return "miss_attempt"
    return "miss_refuse"


def score_rows(rows: List[Dict[str, Any]], k: int = 5, offset: int = 0) -> Dict[str, Any]:
    counts = {"hit_attempt": 0, "hit_refuse": 0, "miss_attempt": 0, "miss_refuse": 0}
    total = 0
    for row in rows:
        c = classify(row, k, offset)
        if c is None:
            continue
        counts[c] += 1
        total += 1
    pct = {kk: (round(v / total, 4) if total else None) for kk, v in counts.items()}
    # "overconfidence" = answered without retrieving the evidence (miss & attempt)
    overconfidence = round(counts["miss_attempt"] / total, 4) if total else None
    return {"counts": counts, "fraction": pct, "n": total, "overconfidence_rate": overconfidence}
