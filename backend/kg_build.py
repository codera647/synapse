"""
backend/kg_build.py

On-demand knowledge-graph build for a processed library. Runs in a background daemon thread (the
/kg/build endpoint returns immediately); progress is written to kg_graphs and polled by the frontend.

Steps: load the library's chunks (chunk_embeddings) -> extract entities+relations per chunk (parallel,
cheap model) -> resolve to canonical nodes + weighted edges -> store. Cancelable + records errors.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Dict, List

from chat_runtime import supabase
import kg_extract
import kg_resolve


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _update(graph_id: str, **fields) -> None:
    fields["updated_at"] = _now_iso()
    try:
        supabase.table("kg_graphs").update(fields).eq("id", graph_id).execute()
    except Exception as exc:
        print(f"[kg] failed to update graph {graph_id}: {exc}")


def _status(graph_id: str) -> str:
    try:
        res = supabase.table("kg_graphs").select("status").eq("id", graph_id).single().execute()
        return str((res.data or {}).get("status") or "")
    except Exception:
        return ""


def _load_chunks(library_id: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset, page = 0, 1000
    while True:
        r = (supabase.table("chunk_embeddings")
             .select("chunk_id, doc_id, text")
             .eq("library_id", library_id)
             .range(offset, offset + page - 1).execute().data or [])
        rows.extend(r)
        if len(r) < page:
            break
        offset += page
    return rows


def build_graph(graph_id: str, org_id: str, library_id: str) -> None:
    try:
        _update(graph_id, status="building", stage="Loading documents", progress_current=0)
        chunks = _load_chunks(library_id)
        total = len(chunks)
        if total == 0:
            _update(graph_id, status="error", error="No processed chunks for this library.")
            return
        _update(graph_id, progress_total=total, stage="Reading documents & extracting entities")

        ent_mentions: List[Dict[str, Any]] = []
        relations: List[Dict[str, Any]] = []
        lock = threading.Lock()
        done = {"n": 0}
        canceled = {"v": False}

        def work(row: Dict[str, Any]):
            if canceled["v"]:
                return
            res = kg_extract.extract_triples(row.get("text") or "")
            cid = row.get("chunk_id")
            ents = [
                {"name": e.get("name"), "type": e.get("type"), "description": e.get("description"), "chunk_id": cid}
                for e in res.get("entities", []) if isinstance(e, dict) and e.get("name")
            ]
            rels = [
                {"source": r.get("source"), "relation": r.get("relation"), "target": r.get("target"),
                 "description": r.get("description"), "chunk_id": cid}
                for r in res.get("relations", []) if isinstance(r, dict) and r.get("source") and r.get("target")
            ]
            with lock:
                ent_mentions.extend(ents)
                relations.extend(rels)
                done["n"] += 1
                n = done["n"]
            if n % 5 == 0:
                if _status(graph_id) == "canceled":
                    canceled["v"] = True
                _update(graph_id, progress_current=n)

        workers = max(1, int(os.getenv("KG_EXTRACT_WORKERS", "8")))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(work, row) for row in chunks]
            for _ in as_completed(futs):
                if canceled["v"]:
                    break

        if canceled["v"] or _status(graph_id) == "canceled":
            _update(graph_id, status="canceled", stage="Canceled")
            return

        _update(graph_id, stage="Resolving entities", progress_current=total)
        nodes, edges = kg_resolve.resolve(ent_mentions, relations)
        if not nodes:
            _update(graph_id, status="error", error="No entities could be extracted from this library.")
            return

        _update(graph_id, stage="Saving graph")
        node_rows = [{
            "id": n["id"], "graph_id": graph_id, "organization_id": org_id, "library_id": library_id,
            "name": n["name"], "type": n["type"], "description": n["description"],
            "mention_count": n["mention_count"], "source_chunk_ids": n["source_chunk_ids"],
        } for n in nodes]
        edge_rows = [{
            "id": e["id"], "graph_id": graph_id, "organization_id": org_id,
            "source_node_id": e["source_node_id"], "target_node_id": e["target_node_id"],
            "relation": e["relation"], "description": e["description"],
            "weight": e["weight"], "source_chunk_ids": e["source_chunk_ids"],
        } for e in edges]

        for i in range(0, len(node_rows), 500):
            supabase.table("kg_nodes").insert(node_rows[i:i + 500]).execute()
        for i in range(0, len(edge_rows), 500):
            supabase.table("kg_edges").insert(edge_rows[i:i + 500]).execute()

        _update(graph_id, status="done", stage="Done", node_count=len(nodes), edge_count=len(edges))
        print(f"[kg] graph {graph_id}: {len(nodes)} nodes, {len(edges)} edges from {total} chunks")
    except Exception as exc:
        import traceback
        print(f"[kg] build failed: {exc}\n{traceback.format_exc()[-2000:]}")
        _update(graph_id, status="error", error=str(exc)[:500])


def start_build(graph_id: str, org_id: str, library_id: str) -> None:
    threading.Thread(target=build_graph, args=(graph_id, org_id, library_id), daemon=True).start()
