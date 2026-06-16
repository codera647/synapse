"""
backend/agent_agents.py

Claude reasoning steps for Agent mode (Phase 1: visuals). Mirrors chat_agents.py: each function
builds a prompt, calls agent_llm, and returns parsed JSON / text with safe defaults. The
orchestration that sequences them lives in agent_api.py.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from agent_llm import agent_complete_json, agent_complete_text

DATA_CHART_KINDS = ("bar", "line", "pie", "scatter", "area")
DIAGRAM_KINDS = ("flowchart",)


# ── PLAN ───────────────────────────────────────────────────────────────────────────────────
_PLAN_SYSTEM = (
    "You are the Planner for Synapse Agent mode. The user wants you to CREATE VISUALS (charts and/or "
    "diagrams) from their data. You are given the user's request, a summary of the available data "
    "sources (uploaded files + documents in the selected libraries), and the visual types the user "
    "allowed. Decide what to build.\n\n"
    "Return STRICT JSON:\n"
    "{\n"
    '  "intent": string,                       // one sentence restating what to visualize\n'
    '  "ambiguous": boolean,\n'
    '  "clarifying_questions": [ {"question": string, "why": string, "options": [string]} ],\n'
    '  "assumptions": [string],                 // choices you made when proceeding without asking\n'
    '  "data_needs": [ {\n'
    '     "id": string, "description": string,\n'
    '     "source_kind": "upload"|"library_structured"|"library_unstructured",\n'
    '     "source_ref": string|null,           // upload_id or doc_id\n'
    '     "sheet_hint": string|null, "columns_wanted": [string] } ],\n'
    '  "proposed_visuals": [ {\n'
    '     "id": string, "kind": "bar"|"line"|"pie"|"scatter"|"area"|"flowchart",\n'
    '     "title": string, "data_need_ids": [string], "rationale": string } ],\n'
    '  "recommendations": [string]\n'
    "}\n\n"
    "RULES:\n"
    "- Set ambiguous=true with clarifying_questions (MAX 2) ONLY when proceeding would likely produce "
    "the WRONG artifact (genuinely unresolvable: which data, which metric, or which comparison). "
    "Otherwise set ambiguous=false, pick the best interpretation, and record every choice in "
    "assumptions. Default to PROCEEDING — the user prefers a good artifact with stated assumptions "
    "over being asked.\n"
    "- proposed_visuals[].kind MUST be one of the allowed visual types given. Map each visual to the "
    "data_needs it uses. Prefer the chart type that best fits the data; note better alternatives in "
    "recommendations.\n"
    "- For a flowchart, you usually need a 'library_unstructured' data_need describing what process/"
    "algorithm to diagram (it will be retrieved as text).\n"
    "- source_kind=library_structured / upload for spreadsheets/CSVs (exact numbers); "
    "library_unstructured for PDFs/text/code."
)


def _safe_list(v: Any) -> List[Any]:
    return v if isinstance(v, list) else []


def plan(query: str, sources_summary: str, visual_types: List[str], *,
         history: Optional[List[Dict[str, str]]] = None, mode: str = "high") -> Dict[str, Any]:
    user = (
        f"USER REQUEST:\n{query}\n\n"
        f"ALLOWED VISUAL TYPES: {', '.join(visual_types) or 'bar, line, pie, scatter, area, flowchart'}\n\n"
        f"AVAILABLE DATA SOURCES:\n{sources_summary or '(none provided — ask or infer from the request)'}"
    )
    out = agent_complete_json(_PLAN_SYSTEM, user, mode=mode, history=history) or {}
    out.setdefault("intent", (query or "").strip()[:200])
    out["ambiguous"] = bool(out.get("ambiguous"))
    out["clarifying_questions"] = _safe_list(out.get("clarifying_questions"))[:2]
    out["assumptions"] = _safe_list(out.get("assumptions"))
    out["data_needs"] = _safe_list(out.get("data_needs"))
    out["proposed_visuals"] = _safe_list(out.get("proposed_visuals"))
    out["recommendations"] = _safe_list(out.get("recommendations"))
    return out


# ── EXTRACT SERIES (unstructured) ───────────────────────────────────────────────────────────
_EXTRACT_SYSTEM = (
    "You extract a small numeric/tabular dataset from retrieved document text, to be charted. "
    "Return STRICT JSON:\n"
    "{ \"found\": boolean, \"columns\": [string], \"rows\": [[value]], \"unit\": string|null, "
    "\"source_notes\": [string], \"confidence\": number }\n"
    "- Only use values actually present in the text. If the text has no chartable data, return "
    "found=false. Keep numbers as numbers (not strings). confidence in [0,1]."
)


def extract_series(description: str, context: str, columns_wanted: List[str], *, mode: str = "medium") -> Dict[str, Any]:
    user = (
        f"WHAT TO EXTRACT: {description}\n"
        f"DESIRED COLUMNS (hint): {', '.join(columns_wanted) or '(decide from the data)'}\n\n"
        f"DOCUMENT TEXT:\n{context[:12000]}"
    )
    out = agent_complete_json(_EXTRACT_SYSTEM, user, mode=mode) or {}
    out["found"] = bool(out.get("found"))
    out["columns"] = _safe_list(out.get("columns"))
    out["rows"] = _safe_list(out.get("rows"))
    out["source_notes"] = _safe_list(out.get("source_notes"))
    return out


# ── MAKE SPEC ──────────────────────────────────────────────────────────────────────────────
_SPEC_SYSTEM = (
    "You author ONE visual spec from a data preview. Return STRICT JSON:\n"
    "{\n"
    '  "id": string, "format": "vega_lite"|"mermaid",\n'
    '  "vega_lite_spec": object|null,   // Vega-Lite v5; OMIT data values (they are bound later); '
    "use encoding field names EXACTLY as the provided columns\n"
    '  "mermaid_text": string|null,     // for flowchart: a valid Mermaid \"flowchart TD\" diagram\n'
    '  "data_binding": {"x_field": string|null, "y_field": string|null, "series_field": string|null},\n'
    '  "alt_text": string\n'
    "}\n\n"
    "RULES:\n"
    "- For bar/line/pie/scatter/area: format=vega_lite. Provide a complete v5 spec with a 'mark' and "
    "'encoding' that references ONLY the provided column names. Do NOT include a 'data' block. Set a "
    "clear title. Choose sensible field types (quantitative/nominal/temporal).\n"
    "- For flowchart: format=mermaid, mermaid_text only (no vega). Use 'flowchart TD'. Keep node "
    "labels short; no HTML.\n"
    "- alt_text: one sentence describing the visual for accessibility."
)


def make_spec(visual: Dict[str, Any], data_preview: Dict[str, Any], *, mode: str = "high") -> Dict[str, Any]:
    preview = {
        "columns": data_preview.get("columns"),
        "dtypes": data_preview.get("dtypes"),
        "unit": data_preview.get("unit"),
        "sample_rows": (data_preview.get("sample_rows") or [])[:15],
    }
    user = (
        f"VISUAL: kind={visual.get('kind')} title={visual.get('title')!r}\n"
        f"RATIONALE: {visual.get('rationale')}\n\n"
        f"DATA PREVIEW (columns + sample only; full data is bound later):\n{json.dumps(preview, default=str)[:6000]}"
    )
    out = agent_complete_json(_SPEC_SYSTEM, user, mode=mode) or {}
    out.setdefault("id", visual.get("id"))
    out.setdefault("format", "mermaid" if visual.get("kind") == "flowchart" else "vega_lite")
    out.setdefault("data_binding", {})
    out.setdefault("alt_text", visual.get("title") or "")
    return out


# ── REPAIR SPEC ────────────────────────────────────────────────────────────────────────────
_REPAIR_SYSTEM = (
    "A visual spec failed validation. Fix it and return the SAME JSON shape as the spec authoring "
    "step ({id, format, vega_lite_spec, mermaid_text, data_binding, alt_text}). Address every error "
    "exactly; keep field names within the allowed columns; do not add a data block to Vega-Lite."
)


def repair_spec(fmt: str, broken: Dict[str, Any], errors: List[str], columns: List[str], *, mode: str = "high") -> Dict[str, Any]:
    user = (
        f"FORMAT: {fmt}\nALLOWED COLUMNS: {columns}\nERRORS: {errors}\n\n"
        f"BROKEN SPEC JSON:\n{json.dumps(broken, default=str)[:8000]}"
    )
    out = agent_complete_json(_REPAIR_SYSTEM, user, mode=mode) or {}
    out.setdefault("format", fmt)
    out.setdefault("data_binding", broken.get("data_binding") or {})
    out.setdefault("alt_text", broken.get("alt_text") or "")
    return out


# ── NARRATE ────────────────────────────────────────────────────────────────────────────────
_NARRATE_SYSTEM = (
    "You are Synapse Agent. Write a SHORT markdown summary (3-6 sentences) of the visuals you just "
    "created for the user: what each shows and the key takeaway from the data. Then, if there are "
    "assumptions or recommendations, mention them briefly. Be concrete and reference the data. Do "
    "not invent numbers beyond what the artifacts contain."
)


def narrate(query: str, artifacts_summary: str, assumptions: List[str], recommendations: List[str], *, mode: str = "medium") -> str:
    user = (
        f"USER REQUEST: {query}\n\n"
        f"ARTIFACTS CREATED:\n{artifacts_summary}\n\n"
        f"ASSUMPTIONS: {assumptions}\nRECOMMENDATIONS: {recommendations}"
    )
    return agent_complete_text(_NARRATE_SYSTEM, user, mode=mode)
