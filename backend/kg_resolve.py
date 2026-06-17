"""
backend/kg_resolve.py

Entity resolution: merge entity mentions extracted from many chunks into canonical nodes, and dedup
relations into weighted edges. v1 uses normalized-name matching (reliable, cheap). Embedding-based
near-duplicate merging is a later refinement.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Tuple

_STOP_TYPES = {"", "thing", "other"}


def _norm(name: str) -> str:
    s = (name or "").lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s+", " ", s)
    # drop a leading article
    s = re.sub(r"^(the|a|an)\s+", "", s)
    return s.strip()


def resolve(entity_mentions: List[Dict[str, Any]], relations: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """entity_mentions: [{name, type, description, chunk_id}]; relations: [{source, relation, target,
    description, chunk_id}]. Returns (nodes, edges)."""
    nodes_by_key: Dict[str, Dict[str, Any]] = {}
    for m in entity_mentions:
        key = _norm(m.get("name"))
        if not key or len(key) < 2:
            continue
        n = nodes_by_key.get(key)
        if not n:
            n = {
                "id": str(uuid.uuid4()),
                "name": (m.get("name") or key).strip()[:160],
                "type": (m.get("type") or "concept").strip().lower()[:40] or "concept",
                "descriptions": [],
                "chunk_ids": set(),
                "mention_count": 0,
            }
            nodes_by_key[key] = n
        n["mention_count"] += 1
        d = (m.get("description") or "").strip()
        if d:
            n["descriptions"].append(d)
        cid = m.get("chunk_id")
        if cid:
            n["chunk_ids"].add(str(cid))

    nodes: List[Dict[str, Any]] = []
    for key, n in nodes_by_key.items():
        # pick the longest description as the representative (usually the most informative).
        desc = max(n["descriptions"], key=len) if n["descriptions"] else None
        nodes.append({
            "id": n["id"],
            "name": n["name"],
            "type": n["type"] if n["type"] not in _STOP_TYPES else "concept",
            "description": (desc or "")[:500] or None,
            "mention_count": n["mention_count"],
            "source_chunk_ids": sorted(n["chunk_ids"]),
        })

    key_to_id = {key: n["id"] for key, n in nodes_by_key.items()}

    edges_by_key: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for r in relations:
        s_id = key_to_id.get(_norm(r.get("source")))
        t_id = key_to_id.get(_norm(r.get("target")))
        if not s_id or not t_id or s_id == t_id:
            continue
        rel = (r.get("relation") or "related to").strip()[:60] or "related to"
        ek = (s_id, rel.lower(), t_id)
        e = edges_by_key.get(ek)
        if not e:
            e = {
                "id": str(uuid.uuid4()),
                "source_node_id": s_id,
                "target_node_id": t_id,
                "relation": rel,
                "description": (r.get("description") or "").strip()[:300] or None,
                "weight": 0,
                "source_chunk_ids": set(),
            }
            edges_by_key[ek] = e
        e["weight"] += 1
        cid = r.get("chunk_id")
        if cid:
            e["source_chunk_ids"].add(str(cid))

    edges = []
    for e in edges_by_key.values():
        e["source_chunk_ids"] = sorted(e["source_chunk_ids"])
        edges.append(e)
    return nodes, edges
