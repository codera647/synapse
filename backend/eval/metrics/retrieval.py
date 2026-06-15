"""Page-level retrieval metrics (DOUBLE-BENCH hit@k).

A retrieved chunk contributes the page span [page_start..page_end] of its document. Evidence is
assumed to live in the query's document (`bench_doc_id`):
  - single-hop: one evidence set (paper Eq.1) -> hit if retrieved pages ∩ evidence ≠ ∅
  - multi-hop:  a chain of evidence sets (Eq.2)  -> hit only if EVERY hop's set is intersected
A per-corpus `page_offset` (config) aligns Synapse's parser page indexing to the benchmark's.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set


def _pages(span_start: Any, span_end: Any, offset: int) -> Set[int]:
    try:
        a = int(span_start) + offset
        b = int(span_end) + offset
    except Exception:
        return set()
    if b < a:
        a, b = b, a
    return set(range(a, b + 1))


def _retrieved_pages_for_doc(row: Dict[str, Any], k: int, doc_id: str, offset: int) -> Set[int]:
    pages: Set[int] = set()
    for r in (row.get("retrieve") or {}).get("results", [])[:k]:
        if str(r.get("bench_doc_id")) == str(doc_id):
            pages |= _pages(r.get("page_start"), r.get("page_end"), offset)
    return pages


def _evidence_sets(row: Dict[str, Any]) -> List[Set[int]]:
    """Normalized evidence: list of page-sets. Single-hop -> 1 set; multi-hop -> 1 set per hop."""
    chain = row.get("evidence_chain") or []
    if chain and any(chain):
        return [set(int(p) for p in hop) for hop in chain if hop]
    ev = row.get("evidence_pages") or []
    return [set(int(p) for p in ev)] if ev else []


def hit_at_k(row: Dict[str, Any], k: int, offset: int = 0) -> Optional[bool]:
    """True/False if the query has evidence labels; None if it can't be scored."""
    ev_sets = _evidence_sets(row)
    if not ev_sets:
        return None
    doc_id = str(row.get("bench_doc_id"))
    retrieved = _retrieved_pages_for_doc(row, k, doc_id, offset)
    if not retrieved:
        return False
    # Every hop's evidence set must be intersected (single-hop has exactly one set).
    return all(bool(retrieved & ev) for ev in ev_sets)


def score_rows(rows: List[Dict[str, Any]], ks=(1, 3, 5), offset: int = 0) -> Dict[str, Any]:
    """Aggregate hit@k overall and broken down by hop-count, language, doc_type, modality."""
    def _empty():
        return {f"hit@{k}": [0, 0] for k in ks}  # [hits, total]

    overall = _empty()
    by: Dict[str, Dict[str, Dict[str, List[int]]]] = {"hops": {}, "language": {}, "doc_type": {}, "modality": {}}

    for row in rows:
        if not (row.get("retrieve") or {}).get("results"):
            # still counts as a miss if it has evidence (retrieval ran but returned nothing)
            pass
        for k in ks:
            h = hit_at_k(row, k, offset)
            if h is None:
                continue
            overall[f"hit@{k}"][1] += 1
            overall[f"hit@{k}"][0] += 1 if h else 0
            for dim in ("hops", "language", "doc_type", "modality"):
                key = str(row.get(dim))
                slot = by[dim].setdefault(key, _empty())
                slot[f"hit@{k}"][1] += 1
                slot[f"hit@{k}"][0] += 1 if h else 0

    def _ratio(d):
        return {k: (round(v[0] / v[1], 4) if v[1] else None, v[1]) for k, v in d.items()}

    return {
        "overall": _ratio(overall),
        "by_hops": {kk: _ratio(vv) for kk, vv in sorted(by["hops"].items())},
        "by_language": {kk: _ratio(vv) for kk, vv in sorted(by["language"].items())},
        "by_doc_type": {kk: _ratio(vv) for kk, vv in sorted(by["doc_type"].items())},
        "by_modality": {kk: _ratio(vv) for kk, vv in sorted(by["modality"].items())},
    }
