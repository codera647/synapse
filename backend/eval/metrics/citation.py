"""Citation accuracy — do the pages Synapse actually cites match the ground-truth evidence pages?

Precision = |cited ∩ evidence| / |cited|   (are the citations correct?)
Recall    = |cited ∩ evidence| / |evidence| (did it cite all the needed pages?)
Computed per judged query over the query's document, then averaged.
"""

from __future__ import annotations

from typing import Any, Dict, List, Set


def _evidence_pages(row: Dict[str, Any]) -> Set[int]:
    pages: Set[int] = set()
    for hop in (row.get("evidence_chain") or []):
        pages |= set(int(p) for p in hop)
    pages |= set(int(p) for p in (row.get("evidence_pages") or []))
    return pages


def _cited_pages(row: Dict[str, Any], offset: int) -> Set[int]:
    doc_id = str(row.get("bench_doc_id"))
    pages: Set[int] = set()
    for c in (row.get("chat") or {}).get("citations", []) or []:
        if str(c.get("bench_doc_id")) == doc_id and c.get("page") is not None:
            try:
                pages.add(int(c.get("page")) + offset)
            except Exception:
                pass
    return pages


def score_rows(rows: List[Dict[str, Any]], offset: int = 0) -> Dict[str, Any]:
    precisions: List[float] = []
    recalls: List[float] = []
    n_with_citations = 0
    for row in rows:
        if "answer" not in (row.get("chat") or {}):
            continue
        ev = _evidence_pages(row)
        cited = _cited_pages(row, offset)
        if not ev:
            continue
        if cited:
            n_with_citations += 1
            inter = len(cited & ev)
            precisions.append(inter / len(cited))
            recalls.append(inter / len(ev))
        else:
            recalls.append(0.0)  # no citations => zero recall (precision undefined, skip)
    avg = lambda xs: round(sum(xs) / len(xs), 4) if xs else None
    return {
        "precision": avg(precisions),
        "recall": avg(recalls),
        "answers_with_citations": n_with_citations,
        "n": len(recalls),
    }
