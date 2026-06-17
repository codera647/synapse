"""
backend/kg_api.py

Knowledge-graph HTTP API. Builds run in a background thread (kg_build); the frontend polls /kg/status
and fetches /kg/graph when done.

  POST /kg/build    -> create a kg_graphs row + start the build
  GET  /kg/status   -> build progress for a graph or the latest for a library
  GET  /kg/graph    -> nodes + edges for the latest done graph of a library (server-side pruned)
  POST /kg/cancel   -> request cancel
  POST /kg/delete   -> drop a graph
"""

from __future__ import annotations

import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from env_bootstrap import load_env
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from chat_runtime import supabase
import kg_build

load_env()
router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(exc: Exception, where: str):
    return JSONResponse(status_code=500, content={
        "error": f"KG backend crashed in {where}.", "exception_type": type(exc).__name__,
        "exception_message": str(exc), "traceback": traceback.format_exc()[-6000:],
    })


class KGBuildReq(BaseModel):
    organization_id: str
    library_id: str
    created_by_user_id: Optional[str] = None
    rebuild: bool = False


@router.post("/kg/build")
def kg_build_route(req: KGBuildReq):
    try:
        if not req.organization_id or not req.library_id:
            raise HTTPException(status_code=400, detail="Missing organization_id or library_id.")
        # Reuse an in-flight/done graph unless rebuild is requested.
        existing = (supabase.table("kg_graphs")
                    .select("id, status")
                    .eq("library_id", req.library_id).eq("organization_id", req.organization_id)
                    .order("created_at", desc=True).limit(1).execute().data or [])
        if existing and not req.rebuild and existing[0].get("status") in ("queued", "building", "done"):
            return {"graph_id": existing[0]["id"], "status": existing[0]["status"], "reused": True}

        graph_id = str(uuid.uuid4())
        supabase.table("kg_graphs").insert({
            "id": graph_id, "organization_id": req.organization_id, "library_id": req.library_id,
            "created_by_user_id": req.created_by_user_id, "status": "queued", "stage": "Queued",
        }).execute()
        kg_build.start_build(graph_id, req.organization_id, req.library_id)
        return {"graph_id": graph_id, "status": "queued", "reused": False}
    except HTTPException:
        raise
    except Exception as exc:
        return _err(exc, "/kg/build")


@router.get("/kg/status")
def kg_status_route(graph_id: str = "", library_id: str = "", organization_id: str = ""):
    try:
        q = supabase.table("kg_graphs").select(
            "id, library_id, status, stage, progress_current, progress_total, node_count, edge_count, error, updated_at"
        )
        if graph_id:
            q = q.eq("id", graph_id)
        elif library_id:
            q = q.eq("library_id", library_id)
        else:
            raise HTTPException(status_code=400, detail="Pass graph_id or library_id.")
        if organization_id:
            q = q.eq("organization_id", organization_id)
        rows = q.order("created_at", desc=True).limit(1).execute().data or []
        return {"graph": rows[0] if rows else None}
    except HTTPException:
        raise
    except Exception as exc:
        return _err(exc, "/kg/status")


@router.get("/kg/graph")
def kg_graph_route(library_id: str = "", graph_id: str = "", organization_id: str = "",
                   min_weight: int = Query(1, ge=1), max_nodes: int = Query(400, ge=10, le=2000)):
    try:
        g = supabase.table("kg_graphs").select("id, library_id, status, node_count, edge_count")
        if graph_id:
            g = g.eq("id", graph_id)
        elif library_id:
            g = g.eq("library_id", library_id).eq("status", "done")
        else:
            raise HTTPException(status_code=400, detail="Pass library_id or graph_id.")
        if organization_id:
            g = g.eq("organization_id", organization_id)
        grows = g.order("created_at", desc=True).limit(1).execute().data or []
        if not grows:
            return {"graph": None, "nodes": [], "edges": []}
        graph = grows[0]
        gid = graph["id"]

        nodes = (supabase.table("kg_nodes")
                 .select("id, name, type, description, mention_count, source_chunk_ids")
                 .eq("graph_id", gid).order("mention_count", desc=True).limit(max_nodes).execute().data or [])
        keep = {n["id"] for n in nodes}
        edges_all = (supabase.table("kg_edges")
                     .select("id, source_node_id, target_node_id, relation, description, weight, source_chunk_ids")
                     .eq("graph_id", gid).gte("weight", min_weight).limit(5000).execute().data or [])
        edges = [e for e in edges_all if e["source_node_id"] in keep and e["target_node_id"] in keep]
        return {"graph": graph, "nodes": nodes, "edges": edges}
    except HTTPException:
        raise
    except Exception as exc:
        return _err(exc, "/kg/graph")


class KGIdReq(BaseModel):
    organization_id: str
    graph_id: str


@router.post("/kg/cancel")
def kg_cancel_route(req: KGIdReq):
    try:
        supabase.table("kg_graphs").update({"status": "canceled", "updated_at": _now_iso()}) \
            .eq("id", req.graph_id).eq("organization_id", req.organization_id) \
            .in_("status", ["queued", "building"]).execute()
        return {"ok": True}
    except Exception as exc:
        return _err(exc, "/kg/cancel")


@router.post("/kg/delete")
def kg_delete_route(req: KGIdReq):
    try:
        supabase.table("kg_graphs").delete() \
            .eq("id", req.graph_id).eq("organization_id", req.organization_id).execute()
        return {"ok": True}
    except Exception as exc:
        return _err(exc, "/kg/delete")
