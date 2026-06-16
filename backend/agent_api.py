"""
backend/agent_api.py

Agent mode HTTP API (Phase 1: visuals). Mirrors chat_api.py patterns (progress polling, verbose
error responses, sync handler in a worker thread). Reuses the retrieval stack and persists runs/
messages/artifacts to Supabase via the service-role client (realtime broadcasts to teammates).

Endpoints:
  POST /agent/upload          -> store a runtime file in R2 + register it (preview if structured)
  POST /agent/run             -> plan -> (clarify | acquire -> spec -> render) -> persist + return
  GET  /agent/status?rid=     -> live "what the agent is doing"
  GET  /agent/artifact/file   -> stream a rendered PNG / spec JSON from R2 (agents/ prefix)
"""

from __future__ import annotations

import json
import os
import threading
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from env_bootstrap import load_env
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from chat_runtime import supabase, embed_query, hybrid_retrieve, hydrate_doc_titles
import agent_agents as aa
import agent_specs as asp
import agent_data as adata

load_env()

router = APIRouter()

_ALL_VISUAL_TYPES = ["bar", "line", "pie", "scatter", "area", "flowchart"]
_STRUCTURED_KINDS = {"upload", "library_structured", "library"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Progress (poll like /chat/status) ─────────────────────────────────────────────────────────
_PROGRESS_LOCK = threading.Lock()
_PROGRESS: Dict[str, str] = {}


def _set_progress(rid: Optional[str], stage: str) -> None:
    if not rid:
        return
    with _PROGRESS_LOCK:
        _PROGRESS[str(rid)] = stage
        if len(_PROGRESS) > 500:
            for k in list(_PROGRESS.keys())[:200]:
                _PROGRESS.pop(k, None)


def _clear_progress(rid: Optional[str]) -> None:
    if not rid:
        return
    with _PROGRESS_LOCK:
        _PROGRESS.pop(str(rid), None)


@router.get("/agent/status")
def agent_status(rid: str = ""):
    with _PROGRESS_LOCK:
        stage = _PROGRESS.get(str(rid), "")
    return {"stage": stage}


def _verbose_errors_enabled() -> bool:
    return str(os.getenv("CHAT_VERBOSE_ERRORS", "1")).strip().lower() in {"1", "true", "yes", "on"}


def _error_response(exc: Exception, where: str):
    if _verbose_errors_enabled():
        return JSONResponse(
            status_code=500,
            content={
                "error": f"Agent backend crashed in {where}.",
                "exception_type": type(exc).__name__,
                "exception_message": str(exc),
                "traceback": traceback.format_exc()[-8000:],
            },
        )
    raise exc


# ── Persistence helpers (service-role; realtime broadcasts to teammates) ───────────────────────
def _insert_message(run_id: str, org_id: str, role: str, content: str,
                    created_by: Optional[str] = None, status: str = "done") -> Optional[str]:
    try:
        res = supabase.table("agent_messages").insert({
            "run_id": run_id, "organization_id": org_id, "role": role,
            "content": content, "status": status, "created_by_user_id": created_by,
        }).execute()
        return str((res.data or [{}])[0].get("id")) if res.data else None
    except Exception as exc:
        print(f"[agent] failed to persist message: {exc}")
        return None


def _ensure_run(run_id: Optional[str], org_id: str, created_by: Optional[str],
                library_ids: List[str], title: str) -> str:
    if run_id:
        supabase.table("agent_runs").update({"status": "running", "updated_at": _now_iso()}) \
            .eq("id", run_id).eq("organization_id", org_id).execute()
        return run_id
    rid = str(uuid.uuid4())
    supabase.table("agent_runs").insert({
        "id": rid, "organization_id": org_id, "created_by_user_id": created_by,
        "title": (title or "New agent run")[:120], "selected_library_ids": library_ids,
        "status": "running",
    }).execute()
    return rid


def _set_run_status(run_id: str, org_id: str, status: str) -> None:
    try:
        supabase.table("agent_runs").update({"status": status, "updated_at": _now_iso()}) \
            .eq("id", run_id).eq("organization_id", org_id).execute()
    except Exception:
        pass


# ── Data acquisition ───────────────────────────────────────────────────────────────────────────
def _series_from_extract(ext: Dict[str, Any]) -> Dict[str, Any]:
    columns = [str(c) for c in (ext.get("columns") or [])]
    data_rows = ext.get("rows") or []
    series = {c: [(r[i] if i < len(r) else None) for r in data_rows] for i, c in enumerate(columns)}
    dtypes = {c: adata._infer_dtype(series[c]) for c in columns}
    for c in columns:
        if dtypes[c] == "number":
            series[c] = [adata._to_number(v) for v in series[c]]
    sample = [{c: (series[c][i] if i < len(series[c]) else None) for c in columns}
              for i in range(min(20, len(data_rows)))]
    return {"columns": columns, "dtypes": dtypes, "sample_rows": sample, "series": series,
            "unit": ext.get("unit"), "row_count": len(data_rows)}


def _acquire(data_need: Dict[str, Any], org_id: str, library_ids: List[str]):
    """Return (preview_with_series, sources_meta) or (None, []) if no chartable data."""
    kind = str(data_need.get("source_kind") or "")
    ref = data_need.get("source_ref")
    sheet = data_need.get("sheet_hint")
    desc = str(data_need.get("description") or "")
    cols_wanted = [str(c) for c in (data_need.get("columns_wanted") or [])]

    # Structured: exact re-parse (upload or library doc).
    if kind in _STRUCTURED_KINDS and ref:
        tab = adata.load_structured(org_id, kind, str(ref), sheet=sheet)
        if tab and tab.get("columns"):
            meta = [{"name": tab.get("source_name"), "source_ref": ref, "confidence": 1.0}]
            return tab, meta

    # Unstructured upload: parse to text + extract.
    if kind == "upload" and ref:
        row = adata.fetch_upload_row(str(ref), org_id)
        if row and row.get("storage_key"):
            try:
                import document_parsers
                raw = adata.fetch_r2_bytes(row["storage_key"])
                ir = document_parsers.parse_to_ir(row.get("mime_type"), row.get("filename"), raw)
                context = _ir_to_text(ir)
                ext = aa.extract_series(desc, context, cols_wanted)
                if ext.get("found"):
                    return _series_from_extract(ext), [{"name": row.get("filename"), "source_ref": ref, "confidence": ext.get("confidence")}]
            except Exception as exc:
                print(f"[agent] unstructured upload parse failed: {exc}")

    # Unstructured library: retrieve + extract.
    if library_ids and desc:
        try:
            qv = embed_query(desc)
            rows = hybrid_retrieve(org_id, library_ids, desc, qv, top_k=12)
            meta = hydrate_doc_titles([r.get("doc_id") for r in rows]) if rows else {}
            context = "\n\n".join(
                f"[{(meta.get(r.get('doc_id')) or {}).get('doc_title', 'doc')} p{r.get('page_start')}] {r.get('text', '')}"
                for r in rows[:12]
            )
            if context.strip():
                ext = aa.extract_series(desc, context, cols_wanted)
                if ext.get("found"):
                    srcs = [{"doc_id": r.get("doc_id"),
                             "doc_title": (meta.get(r.get("doc_id")) or {}).get("doc_title"),
                             "confidence": ext.get("confidence")} for r in rows[:3]]
                    return _series_from_extract(ext), srcs
        except Exception as exc:
            print(f"[agent] unstructured retrieval failed: {exc}")

    return None, []


def _ir_to_text(ir: Optional[Dict[str, Any]], max_chars: int = 12000) -> str:
    if not ir:
        return ""
    parts: List[str] = []
    for page in ir.get("pages", []):
        for b in page.get("blocks", []):
            t = str(b.get("text") or "").strip()
            if t:
                parts.append(t)
    return ("\n\n".join(parts))[:max_chars]


def _structured_preview(org_id: str, kind: str, ref: str, name: str) -> Optional[str]:
    tab = adata.load_structured(org_id, kind, ref)
    if not tab:
        return None
    return (f"- {name} (id={ref}, {kind}): columns={tab.get('columns')}, "
            f"dtypes={tab.get('dtypes')}, rows={tab.get('row_count')}")


def _build_sources_summary(org_id: str, library_ids: List[str], upload_ids: List[str]) -> str:
    lines: List[str] = []
    # Uploads
    for uid in upload_ids or []:
        row = adata.fetch_upload_row(uid, org_id)
        if not row:
            continue
        name = row.get("filename") or uid
        if row.get("kind") == "structured":
            prev = _structured_preview(org_id, "upload", uid, name)
            lines.append(prev or f"- {name} (id={uid}, upload, structured)")
        else:
            lines.append(f"- {name} (id={uid}, upload, unstructured text/pdf)")
    # Library docs
    docs = adata.list_library_documents(org_id, library_ids)
    for d in docs[:60]:
        did = d.get("id")
        title = d.get("title") or did
        structured = adata.is_structured(title, d.get("mime_type") or "")
        if structured:
            prev = _structured_preview(org_id, "library_structured", did, title)
            lines.append(prev or f"- {title} (doc_id={did}, library_structured)")
        else:
            lines.append(f"- {title} (doc_id={did}, library_unstructured)")
    return "\n".join(lines)


# ── Spec -> artifact ───────────────────────────────────────────────────────────────────────────
def _build_artifact(run_id: str, org_id: str, visual: Dict[str, Any], preview: Dict[str, Any]) -> Dict[str, Any]:
    artifact_id = str(uuid.uuid4())
    spec = aa.make_spec(visual, preview)
    fmt = str(spec.get("format") or ("mermaid" if visual.get("kind") == "flowchart" else "vega_lite"))
    art: Dict[str, Any] = {
        "artifact_id": artifact_id, "kind": visual.get("kind"), "format": fmt,
        "title": visual.get("title") or spec.get("title") or "Visual",
        "alt_text": spec.get("alt_text") or "", "spec_key": None, "png_key": None,
        "mermaid_text": None, "render_status": "ok", "errors": [],
    }

    if fmt == "mermaid":
        text = str(spec.get("mermaid_text") or "")
        ok, errs = asp.validate_mermaid(text)
        if not ok:
            spec = aa.repair_spec("mermaid", spec, errs, [])
            text = str(spec.get("mermaid_text") or "")
            ok, errs = asp.validate_mermaid(text)
        if not ok:
            art["render_status"] = "render_failed"
            art["errors"] = errs
        art["mermaid_text"] = text
        return art

    # vega_lite
    columns = list(preview.get("columns") or [])
    vspec = spec.get("vega_lite_spec") or {}
    ok, errs = asp.validate_vega(vspec, columns)
    if not ok:
        spec = aa.repair_spec("vega_lite", spec, errs, columns)
        vspec = spec.get("vega_lite_spec") or {}
        ok, errs = asp.validate_vega(vspec, columns)
    if not ok:
        art["render_status"] = "render_failed"
        art["errors"] = errs
        return art

    bound = asp.bind_data(vspec, preview.get("series") or {}, spec.get("data_binding"))
    spec_key = f"agents/{run_id}/{artifact_id}.json"
    adata.put_r2_json(spec_key, bound)
    art["spec_key"] = spec_key
    png = asp.render_vega_png(bound)
    if png:
        png_key = f"agents/{run_id}/{artifact_id}.png"
        adata.put_r2_png(png_key, png)
        art["png_key"] = png_key
    return art


# ── Request model ──────────────────────────────────────────────────────────────────────────────
class AgentRunRequest(BaseModel):
    organization_id: Optional[str] = None
    created_by_user_id: Optional[str] = None
    library_ids: List[str] = Field(default_factory=list)
    upload_ids: List[str] = Field(default_factory=list)
    message: str = ""
    action: str = "visuals"  # visuals | docs | pdf
    visual_types: List[str] = Field(default_factory=list)
    thinking_mode: Optional[str] = None
    history: List[Dict[str, str]] = Field(default_factory=list)
    client_request_id: Optional[str] = None
    run_id: Optional[str] = None


def _gather_doc_context(org_id: str, library_ids: List[str], upload_ids: List[str], query: str):
    """Assemble source content for a document: parsed uploads + retrieved library passages."""
    parts: List[str] = []
    sources_meta: List[Dict[str, Any]] = []
    summary_lines: List[str] = []

    for uid in upload_ids or []:
        row = adata.fetch_upload_row(uid, org_id)
        if not row:
            continue
        name = row.get("filename") or uid
        try:
            if row.get("kind") == "structured":
                tab = adata.load_structured(org_id, "upload", uid)
                if tab:
                    parts.append(f"FILE {name} (table): columns={tab['columns']}; sample={tab['sample_rows'][:10]}")
            else:
                import document_parsers
                raw = adata.fetch_r2_bytes(row["storage_key"])
                ir = document_parsers.parse_to_ir(row.get("mime_type"), name, raw)
                parts.append(f"FILE {name}:\n{_ir_to_text(ir, 6000)}")
            summary_lines.append(f"- {name} (uploaded)")
            sources_meta.append({"name": name, "source_ref": uid})
        except Exception as exc:
            print(f"[agent] doc upload context failed: {exc}")

    if library_ids:
        try:
            qv = embed_query(query)
            rows = hybrid_retrieve(org_id, library_ids, query, qv, top_k=int(os.getenv("AGENT_DOC_TOPK", "24")))
            meta = hydrate_doc_titles([r.get("doc_id") for r in rows]) if rows else {}
            seen = set()
            for r in rows:
                title = (meta.get(r.get("doc_id")) or {}).get("doc_title", "doc")
                parts.append(f"[{title} p{r.get('page_start')}] {r.get('text', '')}")
                if r.get("doc_id") not in seen:
                    seen.add(r.get("doc_id"))
                    summary_lines.append(f"- {title}")
                    sources_meta.append({"doc_id": r.get("doc_id"), "doc_title": title})
        except Exception as exc:
            print(f"[agent] doc retrieval failed: {exc}")

    return ("\n\n".join(parts))[:24000], "\n".join(summary_lines), sources_meta


def _prior_documents(org_id: str, run_id: str) -> str:
    """Full text of documents already created earlier in this run, so follow-ups like 'make a PDF of
    the paper you wrote' can reuse/transform them instead of hallucinating a new one."""
    try:
        res = (supabase.table("agent_artifacts")
               .select("title, markdown_text, created_at")
               .eq("run_id", run_id).eq("organization_id", org_id)
               .in_("format", ["document", "pdf"])
               .order("created_at", desc=True).limit(3).execute())
    except Exception:
        return ""
    parts = []
    for a in (res.data or []):
        md = (a.get("markdown_text") or "").strip()
        if md:
            parts.append(f"PREVIOUSLY CREATED DOCUMENT — {a.get('title')}:\n{md}")
    return "\n\n".join(parts)


def _run_image_impl(req: "AgentRunRequest", run_id: str, rid: Optional[str], org_id: str) -> Dict[str, Any]:
    _set_progress(rid, "Generating image")
    artifact_id = str(uuid.uuid4())
    title = (req.message or "Image").strip()[:80]
    file_key: Optional[str] = None
    render_status = "ok"
    errors: List[str] = []
    try:
        import agent_image
        png = agent_image.generate_image(req.message)
        file_key = f"agents/{run_id}/{artifact_id}.png"
        adata.put_r2_png(file_key, png)
    except Exception as exc:
        render_status = "render_failed"
        errors = [str(exc)]
        print(f"[agent] image generation failed: {exc}")

    art: Dict[str, Any] = {
        "artifact_id": artifact_id, "kind": "image", "format": "image", "title": title,
        "file_key": file_key, "png_key": file_key, "render_status": render_status, "errors": errors,
    }
    narrative = "Here's the image I generated." if file_key else (
        f"I couldn't generate the image: {errors[0] if errors else 'unknown error'}"
    )
    msg_id = _insert_message(run_id, org_id, "assistant", narrative)
    try:
        supabase.table("agent_artifacts").insert({
            "id": artifact_id, "run_id": run_id, "message_id": msg_id, "organization_id": org_id,
            "kind": "image", "format": "image", "title": title,
            "file_key": file_key, "png_key": file_key, "render_status": render_status,
        }).execute()
    except Exception as exc:
        print(f"[agent] failed to persist image artifact: {exc}")
    _set_run_status(run_id, org_id, "done")

    return {"status": "done", "run_id": run_id, "message_id": msg_id, "narrative": narrative,
            "assumptions": [], "recommendations": [], "artifacts": [art], "client_request_id": rid}


def _run_document_impl(req: "AgentRunRequest", run_id: str, rid: Optional[str], org_id: str, mode: str) -> Dict[str, Any]:
    want_pdf = req.action == "pdf"
    _set_progress(rid, "Reading your sources")
    context, sources_summary, sources_meta = _gather_doc_context(org_id, req.library_ids, req.upload_ids, req.message)

    # Prepend any documents already created in this conversation so the agent can reference/transform them.
    prior = _prior_documents(org_id, run_id)
    if prior:
        context = prior + ("\n\n" + context if context else "")
        sources_summary = "- (a document you created earlier in this chat)\n" + sources_summary

    _set_progress(rid, "Writing the document")
    doc = aa.write_document(req.message, context, sources_summary, history=req.history, mode=mode)
    title = doc.get("title") or "Document"
    markdown = doc.get("markdown") or ""

    artifact_id = str(uuid.uuid4())
    art: Dict[str, Any] = {
        "artifact_id": artifact_id, "kind": "pdf" if want_pdf else "document",
        "format": "pdf" if want_pdf else "document", "title": title,
        "markdown_text": markdown, "file_key": None, "render_status": "ok",
        "data_sources": sources_meta,
    }
    if want_pdf and markdown.strip():
        _set_progress(rid, "Rendering PDF")
        try:
            import agent_docs
            pdf_bytes = agent_docs.render_markdown_pdf(title, markdown)
            if pdf_bytes:
                file_key = f"agents/{run_id}/{artifact_id}.pdf"
                adata.put_r2_bytes(file_key, pdf_bytes, "application/pdf")
                art["file_key"] = file_key
            else:
                art["render_status"] = "render_failed"
        except Exception as exc:
            print(f"[agent] pdf render failed: {exc}")
            art["render_status"] = "render_failed"

    narrative = f"I've drafted **{title}** from your sources. You can read it below" + (
        " or download the PDF." if art.get("file_key") else "."
    )
    msg_id = _insert_message(run_id, org_id, "assistant", narrative)
    try:
        supabase.table("agent_artifacts").insert({
            "id": artifact_id, "run_id": run_id, "message_id": msg_id, "organization_id": org_id,
            "kind": art["kind"], "format": art["format"], "title": title,
            "markdown_text": markdown, "file_key": art.get("file_key"),
            "data_sources": sources_meta, "render_status": art["render_status"],
        }).execute()
    except Exception as exc:
        print(f"[agent] failed to persist document artifact: {exc}")
    _set_run_status(run_id, org_id, "done")

    return {"status": "done", "run_id": run_id, "message_id": msg_id, "narrative": narrative,
            "assumptions": [], "recommendations": [], "artifacts": [art], "client_request_id": rid}


def _agent_run_impl(req: AgentRunRequest) -> Dict[str, Any]:
    if not req.organization_id or not (req.message or "").strip():
        raise HTTPException(status_code=400, detail="Missing organization_id or message.")
    org_id = req.organization_id
    rid = req.client_request_id
    mode = (req.thinking_mode or "high").lower()
    visual_types = [v for v in (req.visual_types or _ALL_VISUAL_TYPES) if v in _ALL_VISUAL_TYPES] or _ALL_VISUAL_TYPES

    run_id = _ensure_run(req.run_id, org_id, req.created_by_user_id, req.library_ids, req.message)
    if not req.run_id:
        _insert_message(run_id, org_id, "user", req.message, created_by=req.created_by_user_id)

    # Image action -> OpenAI image generation path.
    if req.action == "image":
        return _run_image_impl(req, run_id, rid, org_id)

    # Docs / PDF action -> document-writing path.
    if req.action in ("docs", "pdf"):
        return _run_document_impl(req, run_id, rid, org_id, mode)

    _set_progress(rid, "Reviewing your data sources")
    sources_summary = _build_sources_summary(org_id, req.library_ids, req.upload_ids)

    _set_progress(rid, "Planning the visuals")
    plan = aa.plan(req.message, sources_summary, visual_types, history=req.history, mode=mode)

    if plan.get("ambiguous") and plan.get("clarifying_questions"):
        qs = plan["clarifying_questions"]
        bullets = "\n".join(f"- {q.get('question')}" for q in qs if isinstance(q, dict))
        _insert_message(run_id, org_id, "clarification",
                        "I need a quick clarification before I build this:\n" + bullets)
        _set_run_status(run_id, org_id, "needs_clarification")
        return {"status": "needs_clarification", "run_id": run_id,
                "clarifying_questions": qs, "assumptions": plan.get("assumptions", []),
                "client_request_id": rid}

    # Acquire data per data_need
    need_by_id: Dict[str, Dict[str, Any]] = {}
    for dn in plan.get("data_needs", []):
        if isinstance(dn, dict) and dn.get("id"):
            _set_progress(rid, f"Loading data: {str(dn.get('description') or '')[:60]}")
            preview, srcs = _acquire(dn, org_id, req.library_ids)
            if preview:
                preview["_sources"] = srcs
                need_by_id[str(dn["id"])] = preview

    # Build each proposed visual
    artifacts: List[Dict[str, Any]] = []
    proposals = plan.get("proposed_visuals", [])
    for idx, vis in enumerate(proposals):
        if not isinstance(vis, dict):
            continue
        if vis.get("kind") not in visual_types:
            continue
        _set_progress(rid, f"Building {vis.get('kind')} chart {idx + 1}/{len(proposals)}")
        dn_ids = [str(x) for x in (vis.get("data_need_ids") or [])]
        preview = next((need_by_id[i] for i in dn_ids if i in need_by_id), None)
        if vis.get("kind") == "flowchart" and preview is None:
            preview = {"columns": [], "series": {}, "sample_rows": []}  # diagram from text/rationale
        if preview is None:
            artifacts.append({"artifact_id": str(uuid.uuid4()), "kind": vis.get("kind"),
                              "format": "vega_lite", "title": vis.get("title"),
                              "render_status": "render_failed",
                              "errors": ["no data could be loaded for this visual"]})
            continue
        try:
            art = _build_artifact(run_id, org_id, vis, preview)
            art["data_sources"] = preview.get("_sources", [])
            artifacts.append(art)
        except Exception as exc:
            artifacts.append({"artifact_id": str(uuid.uuid4()), "kind": vis.get("kind"),
                              "format": "vega_lite", "title": vis.get("title"),
                              "render_status": "render_failed", "errors": [str(exc)]})

    # Narrate
    _set_progress(rid, "Summarizing")
    summary = "\n".join(f"- {a.get('kind')}: {a.get('title')} [{a.get('render_status')}]" for a in artifacts)
    assumptions = plan.get("assumptions", [])
    recommendations = plan.get("recommendations", [])
    try:
        narrative = aa.narrate(req.message, summary, assumptions, recommendations, mode="medium")
    except Exception:
        narrative = "Here are the visuals I created from your data."

    # Persist assistant message + artifacts
    msg_id = _insert_message(run_id, org_id, "assistant", narrative)
    for a in artifacts:
        try:
            supabase.table("agent_artifacts").insert({
                "id": a["artifact_id"], "run_id": run_id, "message_id": msg_id,
                "organization_id": org_id, "kind": a.get("kind"), "format": a.get("format"),
                "title": a.get("title"), "alt_text": a.get("alt_text"),
                "spec_key": a.get("spec_key"), "png_key": a.get("png_key"),
                "mermaid_text": a.get("mermaid_text"),
                "data_sources": a.get("data_sources") or [],
                "assumptions": assumptions, "recommendations": recommendations,
                "render_status": a.get("render_status") or "ok",
            }).execute()
        except Exception as exc:
            print(f"[agent] failed to persist artifact: {exc}")
    _set_run_status(run_id, org_id, "done")

    return {"status": "done", "run_id": run_id, "message_id": msg_id, "narrative": narrative,
            "assumptions": assumptions, "recommendations": recommendations,
            "artifacts": artifacts, "client_request_id": rid}


@router.post("/agent/run")
def agent_run(req: AgentRunRequest):
    try:
        return _agent_run_impl(req)
    except Exception as exc:
        return _error_response(exc, "/agent/run")
    finally:
        _clear_progress(req.client_request_id)


# ── Upload ───────────────────────────────────────────────────────────────────────────────────
def _max_upload_bytes() -> int:
    try:
        return int(float(os.getenv("AGENT_MAX_UPLOAD_MB", "25")) * 1024 * 1024)
    except Exception:
        return 25 * 1024 * 1024


_ALLOWED_UPLOAD_EXT = (
    ".xlsx", ".xlsm", ".csv", ".docx", ".pdf", ".txt", ".md", ".json",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".c", ".cpp", ".h",
)


class AgentUploadDelete(BaseModel):
    organization_id: str
    upload_id: str


@router.post("/agent/upload/delete")
def agent_upload_delete(req: AgentUploadDelete):
    """Remove a runtime upload: delete its R2 object (free space) + its agent_uploads row."""
    try:
        row = adata.fetch_upload_row(req.upload_id, req.organization_id)
        if row and row.get("storage_key"):
            try:
                adata._s3.delete_object(Bucket=adata._R2_BUCKET, Key=row["storage_key"])
            except Exception as exc:
                print(f"[agent] R2 delete failed for {row.get('storage_key')}: {exc}")
        supabase.table("agent_uploads").delete() \
            .eq("id", req.upload_id).eq("organization_id", req.organization_id).execute()
        return {"ok": True}
    except Exception as exc:
        return _error_response(exc, "/agent/upload/delete")


@router.post("/agent/upload")
async def agent_upload(
    file: UploadFile = File(...),
    organization_id: str = Form(...),
    created_by_user_id: Optional[str] = Form(None),
    run_id: Optional[str] = Form(None),
    library_id: Optional[str] = Form(None),
):
    try:
        name = file.filename or "upload"
        ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
        if ext not in _ALLOWED_UPLOAD_EXT:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext or 'unknown'}")
        data = await file.read()
        if len(data) > _max_upload_bytes():
            raise HTTPException(status_code=413, detail="File too large.")

        upload_id = str(uuid.uuid4())
        storage_key = f"agent-uploads/{organization_id}/{upload_id}/{name}"
        adata.put_r2_bytes(storage_key, data, file.content_type or "application/octet-stream")

        structured = adata.is_structured(name, file.content_type or "")
        preview = None
        kind = "unstructured"
        if structured:
            tab = adata.load_tabular(data, name, file.content_type or "")
            if tab:
                kind = "structured"
                preview = {"columns": tab["columns"], "dtypes": tab["dtypes"],
                           "row_count": tab["row_count"], "sample_rows": tab["sample_rows"][:10],
                           "sheets": tab["sheets"]}

        supabase.table("agent_uploads").insert({
            "id": upload_id, "organization_id": organization_id, "run_id": run_id,
            "library_id": library_id, "created_by_user_id": created_by_user_id,
            "filename": name, "mime_type": file.content_type, "storage_key": storage_key,
            "kind": kind, "preview": preview,
        }).execute()

        return {"upload_id": upload_id, "filename": name, "kind": kind, "preview": preview}
    except HTTPException:
        raise
    except Exception as exc:
        return _error_response(exc, "/agent/upload")


# ── Artifact file ──────────────────────────────────────────────────────────────────────────────
@router.get("/agent/artifact/file")
def agent_artifact_file(key: str = Query(..., description="R2 key under agents/")):
    k = (key or "").strip().lstrip("/")
    if not k.startswith("agents/") or ".." in k:
        raise HTTPException(status_code=400, detail="Invalid artifact key.")
    try:
        obj = adata._s3.get_object(Bucket=adata._R2_BUCKET, Key=k)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Artifact not found: {exc}")
    body = obj["Body"]

    def _iter(chunk_size: int = 65536):
        try:
            while True:
                data = body.read(chunk_size)
                if not data:
                    break
                yield data
        finally:
            try:
                body.close()
            except Exception:
                pass

    media = str(obj.get("ContentType") or "")
    if k.endswith(".png"):
        media = "image/png"
    elif k.endswith(".json"):
        media = "application/json"
    elif k.endswith(".pdf"):
        media = "application/pdf"
    elif k.endswith(".md"):
        media = "text/markdown"
    elif not media:
        media = "application/octet-stream"
    return StreamingResponse(_iter(), media_type=media, headers={"Cache-Control": "private, max-age=600"})
