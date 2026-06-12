"""
chat_agents.py — agent prompts + helpers for Synapse's multi-agent retrieval pipeline.

This module holds the *reasoning agents* that wrap the existing retrieval building blocks
(chat_runtime.embed_query / retrieve_chunks / keyword_search_chunks and the durable
chat_retriever_worker queue). The orchestration that calls them lives in chat_api._chat_impl.

Phase 1 agents (see docs/retrieval-pipeline-design.md):
  - plan_query()   : Planner. Chain-of-thought classify + query rewrite + retrieval gate.
  - extract_notes(): Extractor. Distill retrieved chunks into short, source-anchored notes
                     (the "extract-then-consolidate" step; output feeds build_context_document).

Every agent reads its model from a per-role env var, all defaulting to CHAT_GPT_MODEL
(itself defaulting to gpt-4o-mini), so individual roles can be upgraded later without code
changes. Decision locked with the user: gpt-4o-mini for every agent for now.
"""

import json
import os
import re
from typing import Any, Dict, List, Optional


# Query classes, following the Loong taxonomy adapted to Synapse.
QUERY_CLASSES = (
    "SPOTLIGHT",       # answer lives in one place / a few chunks of one doc
    "MULTI_HOP",       # needs a chain of facts (A -> B -> C), good for curiosity hops
    "COMPARISON",      # compare 2+ entities/docs; evidence is spread across them
    "AGGREGATION",     # count / sum / list-all across many docs
    "MULTI_ENTITY",    # facts about many entities; completeness matters (MEBench)
    "CONVERSATIONAL",  # greeting / meta / no library lookup needed
)


def _model_for(role_env: str) -> str:
    """Resolve the model for an agent role, falling back to the shared chat model."""
    base = (os.getenv("CHAT_GPT_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"
    return (os.getenv(role_env) or base).strip() or base


def _json_object(text: str) -> Dict[str, Any]:
    """Best-effort parse of a JSON object from a model response."""
    if not text:
        return {}
    text = text.strip()
    # Strip ```json fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        pass
    # Fall back to the first {...} block.
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group(0))
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}
    return {}


# ---------------------------------------------------------------------------
# Planner agent
# ---------------------------------------------------------------------------

_PLANNER_SYSTEM = (
    "You are the Planner in Synapse, a research assistant that answers questions using a "
    "library of the user's PDFs. Think step by step about what the user is really asking, then "
    "return a plan as STRICT JSON.\n\n"
    "Return ONLY this JSON object:\n"
    "{\n"
    '  "query_class": one of '
    "[\"SPOTLIGHT\",\"MULTI_HOP\",\"COMPARISON\",\"AGGREGATION\",\"MULTI_ENTITY\",\"CONVERSATIONAL\"],\n"
    '  "needs_retrieval": boolean,\n'
    '  "search_query": string,\n'
    '  "reason": string\n'
    "}\n\n"
    "Guidance:\n"
    "- query_class: SPOTLIGHT = answer is in one place; MULTI_HOP = needs a chain of facts; "
    "COMPARISON = compare two or more things; AGGREGATION = count/sum/list across documents; "
    "MULTI_ENTITY = facts about many entities where completeness matters; CONVERSATIONAL = "
    "greetings, thanks, or meta questions about the assistant that need no document lookup.\n"
    "- needs_retrieval: false ONLY for CONVERSATIONAL; true otherwise.\n"
    "- search_query: rewrite the user's message into a single self-contained retrieval query. "
    "Resolve pronouns and references using the conversation, expand acronyms if obvious, and keep "
    "the important entities/keywords. Do NOT answer the question here.\n"
    "- reason: one short sentence."
)


def plan_query(client, message: str, convo: str = "", model: Optional[str] = None) -> Dict[str, Any]:
    """
    Planner agent. Classifies the query, decides whether retrieval is needed, and rewrites the
    message into a retrieval-optimized search query. Never raises: returns a safe default plan
    (treat as SPOTLIGHT needing retrieval, using the raw message) if anything goes wrong.
    """
    mdl = model or _model_for("CHAT_PLANNER_MODEL")
    default = {
        "query_class": "SPOTLIGHT",
        "needs_retrieval": True,
        "search_query": (message or "").strip(),
        "reason": "default",
    }
    msg = (message or "").strip()
    if not msg:
        return default

    user = msg if not convo else f"{convo}\n\nCURRENT USER MESSAGE:\n{msg}"
    try:
        out = client.chat.completions.create(
            model=mdl,
            messages=[
                {"role": "system", "content": _PLANNER_SYSTEM},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
            max_tokens=300,
        )
        j = _json_object(out.choices[0].message.content or "")
    except Exception:
        return default

    qc = str(j.get("query_class") or "").strip().upper()
    if qc not in QUERY_CLASSES:
        qc = "SPOTLIGHT"
    sq = str(j.get("search_query") or "").strip() or msg
    needs = j.get("needs_retrieval")
    if not isinstance(needs, bool):
        needs = qc != "CONVERSATIONAL"
    # Safety: conversational must skip retrieval; everything else must use it.
    needs = False if qc == "CONVERSATIONAL" else True
    return {
        "query_class": qc,
        "needs_retrieval": needs,
        "search_query": sq,
        "reason": str(j.get("reason") or "").strip(),
    }


# ---------------------------------------------------------------------------
# Extractor agent
# ---------------------------------------------------------------------------

_EXTRACTOR_SYSTEM = (
    "You are the Extractor in Synapse. You are given a QUERY and a list of PASSAGES retrieved "
    "from the user's PDF library. Pull out ONLY the facts that help answer the query, as short "
    "self-contained notes, and attribute each to the passage it came from.\n\n"
    "Return ONLY this JSON object:\n"
    '{ "notes": [ { "note": string, "source": "P<number>" }, ... ] }\n\n'
    "Rules:\n"
    "- A note must be a single, specific, self-contained fact (include the entity/number/date). "
    "Do not write vague notes like 'the paper discusses X'.\n"
    "- source must be the exact passage id (e.g. \"P0\") the note came from. One source per note.\n"
    "- If a passage is irrelevant to the query, skip it. If NOTHING is relevant, return "
    '{ "notes": [] }.\n'
    "- Do not invent facts that are not in the passages. Do not answer the query yourself."
)


def extract_notes(
    client,
    query: str,
    rows: List[Dict[str, Any]],
    *,
    model: Optional[str] = None,
    max_passages: int = 24,
    passage_chars: int = 1100,
    sub_query: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Extractor agent. Distills retrieved chunk rows into short, source-anchored notes.

    Each returned note carries the source chunk's attribution so the context document and the
    final sources list stay grounded:
        {text, sub_query, doc_id, doc_title, library_id, page_start, page_end, chunk_id, score, visual_ids}

    Never raises: returns [] on any failure so the caller can fall back to build_evidence_brief.
    """
    if not rows:
        return []
    mdl = model or _model_for("CHAT_EXTRACTOR_MODEL")
    sq = (sub_query or query or "").strip()

    passages: List[str] = []
    idx_map: List[Dict[str, Any]] = []
    for r in rows[:max_passages]:
        txt = (r.get("text") or "").strip()
        if not txt:
            continue
        i = len(idx_map)
        title = str(r.get("doc_title") or "").strip() or "Untitled PDF"
        passages.append(
            f"[P{i}] (pdf={title} pages={r.get('page_start')}-{r.get('page_end')})\n{txt[:passage_chars]}"
        )
        idx_map.append(r)

    if not passages:
        return []

    user = f"QUERY:\n{query}\n\nPASSAGES:\n" + "\n\n".join(passages)
    try:
        out = client.chat.completions.create(
            model=mdl,
            messages=[
                {"role": "system", "content": _EXTRACTOR_SYSTEM},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
            max_tokens=900,
        )
        j = _json_object(out.choices[0].message.content or "")
    except Exception:
        return []

    raw_notes = j.get("notes")
    if not isinstance(raw_notes, list):
        return []

    notes: List[Dict[str, Any]] = []
    for item in raw_notes:
        if not isinstance(item, dict):
            continue
        text = str(item.get("note") or "").strip()
        if not text:
            continue
        src = str(item.get("source") or "").strip()
        m = re.search(r"\d+", src)
        if not m:
            continue
        ridx = int(m.group(0))
        if ridx < 0 or ridx >= len(idx_map):
            continue
        r = idx_map[ridx]
        notes.append(
            {
                "text": text,
                "sub_query": sq,
                "doc_id": r.get("doc_id"),
                "doc_title": r.get("doc_title"),
                "library_id": r.get("library_id"),
                "page_start": r.get("page_start"),
                "page_end": r.get("page_end"),
                "chunk_id": r.get("chunk_id"),
                "score": r.get("score"),
                "visual_ids": r.get("visual_ids"),
            }
        )
    return notes


def merge_notes(existing: List[Dict[str, Any]], new: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Append new notes, dropping near-duplicates by (chunk_id, normalized text)."""
    seen = set()
    out: List[Dict[str, Any]] = []
    for n in list(existing or []) + list(new or []):
        key = (str(n.get("chunk_id") or ""), " ".join(str(n.get("text") or "").lower().split()))
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
    return out
