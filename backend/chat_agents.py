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

from llm_compat import completion_kwargs


# Query classes, following the Loong taxonomy adapted to Synapse.
QUERY_CLASSES = (
    "SPOTLIGHT",       # answer lives in one place / a few chunks of one doc
    "MULTI_HOP",       # needs a chain of facts (A -> B -> C), good for curiosity hops
    "COMPARISON",      # compare 2+ entities/docs; evidence is spread across them
    "AGGREGATION",     # count / sum / list-all across many docs
    "MULTI_ENTITY",    # facts about many entities; completeness matters (MEBench)
    "CONVERSATIONAL",  # greeting / meta / no library lookup needed
)


def _clean_model_id(raw: Optional[str], default: str) -> str:
    """Tolerate stray inline comments / spaces in env model values (a model ID never contains
    whitespace), e.g. `CHAT_GPT_MODEL=gpt-5.5  # comment` -> `gpt-5.5`."""
    s = (raw or "").strip()
    if s.startswith("#"):
        s = ""
    s = s.split()[0] if s else ""
    return s or default


def _model_for(role_env: str) -> str:
    """Resolve the model for an agent role, falling back to the shared chat model."""
    base = _clean_model_id(os.getenv("CHAT_GPT_MODEL"), "gpt-5.5-2026-04-23")
    return _clean_model_id(os.getenv(role_env), base)


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
    '  "sub_queries": [string],\n'
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
    "- sub_queries: for SPOTLIGHT or CONVERSATIONAL, return []. For MULTI_HOP / COMPARISON / "
    "AGGREGATION / MULTI_ENTITY, decompose the question into 2-4 SPECIFIC, self-contained retrieval "
    "sub-queries that together fully cover it (e.g. one per entity to compare, or one per reasoning "
    "step). Each must be searchable on its own.\n"
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
        "sub_queries": [],
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
            **completion_kwargs(mdl, max_tokens=300, temperature=0.1),
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
    raw_subs = j.get("sub_queries")
    subs: List[str] = []
    if isinstance(raw_subs, list):
        for s in raw_subs:
            s = str(s).strip()
            if s and s.lower() != sq.lower() and s not in subs:
                subs.append(s)
    return {
        "query_class": qc,
        "needs_retrieval": needs,
        "search_query": sq,
        "sub_queries": subs[:4],
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
            **completion_kwargs(mdl, max_tokens=900, temperature=0.1),
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


# ---------------------------------------------------------------------------
# Completeness critic agent (self-reflective gap-finding)
# ---------------------------------------------------------------------------

_CRITIC_SYSTEM = (
    "You are the Completeness Critic in Synapse. You are given the USER_QUERY, a DRAFT_ANSWER, and "
    "the EVIDENCE the draft was built from. Judge whether the draft FULLY answers the query, and find "
    "what is still missing — the failure mode is omitting required entities, numbers, comparisons, or "
    "reasoning steps.\n\n"
    "Return ONLY this JSON object:\n"
    '{ "complete": boolean, "missing": [string], "reason": string }\n\n'
    "Rules:\n"
    "- complete=true ONLY if every part of the query is addressed and no required entity/number/"
    "comparison/step is missing or unsupported.\n"
    "- missing: 1-4 SPECIFIC, self-contained retrieval sub-queries that would fill the gaps (what to "
    "search for next). Return [] if complete.\n"
    "- Judge strictly against what the query asks — do NOT request tangential detail the user didn't ask "
    "for. Better to be complete than exhaustive.\n"
    "- reason: one short sentence."
)


def critique_answer(
    client,
    query: str,
    draft: str,
    evidence: str,
    *,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Completeness critic. Examines the draft answer against the query + evidence and returns whether
    it is complete and, if not, specific retrieval sub-queries to fill the gaps. Never raises:
    returns {complete: True, missing: []} on any failure (so the loop ends safely).
    """
    mdl = model or _model_for("CHAT_CRITIC_MODEL")
    user = (
        f"USER_QUERY:\n{query}\n\nDRAFT_ANSWER:\n{draft}\n\nEVIDENCE:\n{evidence}\n"
    )
    try:
        out = client.chat.completions.create(
            model=mdl,
            messages=[
                {"role": "system", "content": _CRITIC_SYSTEM},
                {"role": "user", "content": user},
            ],
            **completion_kwargs(mdl, max_tokens=400, temperature=0.1),
        )
        j = _json_object(out.choices[0].message.content or "")
    except Exception:
        return {"complete": True, "missing": [], "reason": "critic-failed"}

    complete = bool(j.get("complete"))
    missing: List[str] = []
    raw = j.get("missing")
    if isinstance(raw, list):
        for m in raw:
            m = str(m).strip()
            if m and m not in missing:
                missing.append(m)
    missing = missing[:4]
    if complete:
        missing = []
    return {
        "complete": complete or not missing,
        "missing": missing,
        "reason": str(j.get("reason") or "").strip(),
    }


# ── CRAG: grade retrieval relevance/sufficiency BEFORE answering ──────────────────────
_GRADE_SYSTEM = (
    "You are a retrieval grader (Corrective RAG). Given a USER_QUERY and the retrieved EVIDENCE, "
    "judge whether the evidence is RELEVANT to the query and SUFFICIENT to answer it well. "
    "Return STRICT JSON:\n"
    "- relevant: true|false\n"
    "- sufficient: true|false\n"
    "- confidence: number between 0 and 1\n"
    "- reason: one short sentence."
)


def grade_retrieval(client, query: str, evidence: str, *, model: Optional[str] = None) -> Dict[str, Any]:
    """Grade whether the retrieved evidence can answer the query. Used to decide whether to
    broaden retrieval before answering. Never raises — defaults to relevant/sufficient so a
    grader failure never blocks an answer."""
    mdl = model or _model_for("CHAT_GRADER_MODEL")
    user = f"USER_QUERY:\n{query}\n\nEVIDENCE:\n{(evidence or '')[:6000]}\n"
    try:
        out = client.chat.completions.create(
            model=mdl,
            messages=[{"role": "system", "content": _GRADE_SYSTEM}, {"role": "user", "content": user}],
            **completion_kwargs(mdl, max_tokens=200, temperature=0.0),
        )
        j = _json_object(out.choices[0].message.content or "")
    except Exception:
        return {"relevant": True, "sufficient": True, "confidence": 1.0, "reason": "grader-failed"}
    try:
        conf = float(j.get("confidence"))
    except Exception:
        conf = 0.5
    return {
        "relevant": bool(j.get("relevant", True)),
        "sufficient": bool(j.get("sufficient", True)),
        "confidence": conf,
        "reason": str(j.get("reason") or "").strip(),
    }


# ── Faithfulness: verify the answer's claims are supported by the evidence ────────────
_FAITHFUL_SYSTEM = (
    "You are a faithfulness verifier. Given an ANSWER and the EVIDENCE it must be grounded in, "
    "find specific factual claims in the ANSWER that are NOT supported by the EVIDENCE "
    "(hallucinations). Ignore general framing/transitions; focus on concrete facts, numbers, names. "
    "Return STRICT JSON:\n"
    "- faithful: true|false (true if every specific claim is supported)\n"
    "- unsupported: array of short strings, each paraphrasing one unsupported claim (max 5)\n"
    "- reason: one short sentence."
)


def verify_faithfulness(client, answer: str, evidence: str, *, model: Optional[str] = None) -> Dict[str, Any]:
    """Detect unsupported claims in the answer relative to the evidence. Never raises — defaults
    to faithful so a verifier failure never corrupts a good answer."""
    mdl = model or _model_for("CHAT_FAITHFUL_MODEL")
    user = f"ANSWER:\n{(answer or '')[:6000]}\n\nEVIDENCE:\n{(evidence or '')[:8000]}\n"
    try:
        out = client.chat.completions.create(
            model=mdl,
            messages=[{"role": "system", "content": _FAITHFUL_SYSTEM}, {"role": "user", "content": user}],
            **completion_kwargs(mdl, max_tokens=400, temperature=0.0),
        )
        j = _json_object(out.choices[0].message.content or "")
    except Exception:
        return {"faithful": True, "unsupported": [], "reason": "verifier-failed"}
    uns: List[str] = []
    raw = j.get("unsupported")
    if isinstance(raw, list):
        for u in raw:
            u = str(u).strip()
            if u and u not in uns:
                uns.append(u)
    uns = uns[:5]
    return {
        "faithful": bool(j.get("faithful", True)) or not uns,
        "unsupported": uns,
        "reason": str(j.get("reason") or "").strip(),
    }
