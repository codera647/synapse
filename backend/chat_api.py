import os
import json
import traceback
import re
import hashlib
import threading
from typing import Any, Dict, List, Optional

from env_bootstrap import load_env
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from chat_runtime import (
    build_context_document,
    build_evidence_brief,
    embed_query,
    fetch_chunk_visuals,
    hydrate_doc_titles,
    retrieve_chunks,
)
from chat_agents import critique_answer, extract_notes, merge_notes, plan_query

load_env()

router = APIRouter()


# --- Live "what the agent is doing" status, keyed by client_request_id. The chat request runs
# synchronously in a worker thread; the frontend polls GET /chat/status?rid=... while it waits.
_PROGRESS_LOCK = threading.Lock()
_PROGRESS: Dict[str, str] = {}


def _set_progress(rid: Optional[str], stage: str) -> None:
    if not rid:
        return
    with _PROGRESS_LOCK:
        _PROGRESS[str(rid)] = stage
        # Bound memory if many stale entries accumulate.
        if len(_PROGRESS) > 500:
            for k in list(_PROGRESS.keys())[:200]:
                _PROGRESS.pop(k, None)


def _clear_progress(rid: Optional[str]) -> None:
    if not rid:
        return
    with _PROGRESS_LOCK:
        _PROGRESS.pop(str(rid), None)


@router.get("/chat/status")
def chat_status(rid: str = ""):
    with _PROGRESS_LOCK:
        stage = _PROGRESS.get(str(rid), "")
    return {"stage": stage}


class ChatRequest(BaseModel):
    organization_id: str = Field(..., description="Organization UUID")
    library_ids: List[str] = Field(default_factory=list)
    message: str
    max_hops: int = 4
    top_k: int = 12
    # Reasoning depth: "low" (fast single-pass), "medium" (balanced), "high" (max accuracy).
    thinking_mode: Optional[str] = None
    thread_summary: Optional[str] = None
    history: Optional[List[Dict[str, str]]] = None
    client_request_id: Optional[str] = None
    client_prompt_hash: Optional[str] = None


# Reasoning depth presets:
#   (critic rounds, sub-query count, breadth top-k multiplier, answer max_tokens, detail level)
THINKING_MODES = {
    "low": (0, 0, 1.0, 1600, "concise"),
    "medium": (1, 2, 1.25, 3200, "balanced"),
    "high": (2, 4, 1.5, 5500, "comprehensive"),
}

class CompactRequest(BaseModel):
    organization_id: str
    messages: List[Dict[str, str]]  # {role, content}


def _get_openai_client():
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY (set it in the backend env file)")
    from openai import OpenAI  # type: ignore

    return OpenAI(api_key=api_key)


def _gpt_model() -> str:
    return (os.getenv("CHAT_GPT_MODEL") or "gpt-5.5-2026-04-23").strip() or "gpt-5.5-2026-04-23"

def _max_hops_cap() -> int:
    try:
        return max(0, int(os.getenv("CHAT_MAX_HOPS", "5")))
    except Exception:
        return 5

def _max_topk_cap() -> int:
    try:
        return max(1, int(os.getenv("CHAT_MAX_TOP_K", "20")))
    except Exception:
        return 20

def _strip_and_detect_sources_used(text: str) -> tuple[str, bool]:
    """
    We ask the model to append a final line:
      SOURCES_USED: yes|no
    We strip it from the displayed answer and use it to decide whether to show sources.
    """
    raw = (text or "").strip()
    m = re.search(r"(?im)^\s*SOURCES_USED\s*:\s*(yes|no)\s*$", raw)
    if not m:
        return raw, True  # conservative: if missing, keep sources
    used = m.group(1).lower() == "yes"
    cleaned = re.sub(r"(?im)^\s*SOURCES_USED\s*:\s*(yes|no)\s*$", "", raw).strip()
    return cleaned, used


def _max_row_score(rows: List[Dict[str, Any]]) -> float:
    best = 0.0
    for r in rows or []:
        try:
            s = r.get("score")
            if s is None:
                continue
            fs = float(s)
            if fs > best:
                best = fs
        except Exception:
            continue
    return best


def _min_source_score() -> float:
    try:
        return float(os.getenv("CHAT_MIN_SOURCE_SCORE", "0.18"))
    except Exception:
        return 0.18


def _json_extract(content: str) -> Dict[str, Any]:
    try:
        return json.loads(content)
    except Exception:
        # Try to find a JSON object in the response
        start = content.find("{")
        end = content.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(content[start : end + 1])
            except Exception:
                pass
    return {}


def _compose_user_prompt(user_query: str, convo: str, evidence: str) -> str:
    """
    Build the user message with PRIOR_CONVERSATION, USER_QUERY and EVIDENCE as DISTINCT blocks.

    Critical: the conversation must NOT be merged into the EVIDENCE block. If a prior assistant
    answer sits under "EVIDENCE:", the model copies it verbatim and every turn regurgitates the
    previous turn's answer (an off-by-one bug). Keeping it in its own clearly-labelled, reference-
    only block fixes that.
    """
    blocks: List[str] = []
    if convo:
        blocks.append(f"PRIOR_CONVERSATION (reference only — for resolving pronouns/follow-ups):\n{convo}")
    blocks.append(f"USER_QUERY:\n{user_query}")
    blocks.append(f"EVIDENCE:\n{evidence}")
    return "\n\n".join(blocks) + "\n"


def _followup_decision_prompt(user_query: str, convo: str, evidence: str) -> List[Dict[str, str]]:
    sys = (
        "You are Synapse, a retrieval orchestrator. Decide if the provided EVIDENCE is sufficient to "
        "answer the USER_QUERY.\n"
        "PRIOR_CONVERSATION is only context to interpret the USER_QUERY; do not treat it as evidence.\n"
        "Return STRICT JSON only.\n"
        "If sufficient, set next_action='NA'.\n"
        "If insufficient, set next_action='FOLLOWUP' and provide a single followup_query.\n"
        "Also provide up to 4 sub_queries that would help answer.\n"
        "Schema:\n"
        "{\n"
        "  \"next_action\": \"NA\"|\"FOLLOWUP\",\n"
        "  \"followup_query\": string|null,\n"
        "  \"why_missing\": string,\n"
        "  \"sub_queries\": [{\"query\": string, \"priority\": 1|2|3}]\n"
        "}\n"
    )
    user = _compose_user_prompt(user_query, convo, evidence)
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


_DETAIL_RULES = {
    "concise": "Be concise and direct — answer in as few words as cover the question well.\n",
    "balanced": (
        "Be thorough but focused: cover every part of the question with the relevant facts. Do not "
        "omit relevant detail.\n"
    ),
    "comprehensive": (
        "Be comprehensive: address EVERY part of the question with supporting detail and the key "
        "entities/numbers/comparisons. Prefer completeness over brevity, but never pad with filler.\n"
    ),
}

# How richly to format the answer (Markdown), scaled by the thinking mode.
_FORMAT_RULES = {
    "concise": (
        "Format as light Markdown: **bold** key terms and use a short bullet list only if it helps.\n"
    ),
    "balanced": (
        "Format as clean Markdown: use '##'/'###' headings if the answer has multiple parts, **bold** "
        "key terms, bullet/numbered lists for enumerations and steps, and a Markdown table when "
        "comparing things. Add a fenced code block with a small ASCII diagram (arrows/boxes, e.g. "
        "`A -> B -> C`) when it makes a process or structure clearer.\n"
    ),
    "comprehensive": (
        "Format the answer as polished, well-structured Markdown, like a great explainer:\n"
        "- Organize with prominent '##' and '###' headings so it is easy to scan.\n"
        "- **Bold** the key terms, names, and numbers.\n"
        "- Use bullet or numbered lists for enumerations, steps, and pros/cons.\n"
        "- When you explain a PROCESS, PIPELINE, ARCHITECTURE, or FLOW, include a simple ASCII diagram "
        "inside a fenced code block (e.g. `User Query -> Retriever -> Top-K -> LLM -> Answer`, or "
        "boxes/arrows) to make it visual.\n"
        "- Use a Markdown table to COMPARE two or more things across attributes.\n"
        "- Use '>' blockquotes for definitions or short illustrative examples.\n"
        "- When the answer is long, finish with a short '## Summary'.\n"
    ),
}


def _final_answer_prompt(
    user_query: str,
    convo: str,
    evidence: str,
    visuals: Optional[List[Dict[str, Any]]] = None,
    detail: str = "balanced",
    citations: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, str]]:
    visual_rule = ""
    if visuals:
        visual_rule = (
            "AVAILABLE_VISUALS lists figures/tables/charts from the user's PDFs (each has an id and "
            "caption). These are valuable — when one illustrates, supports, or visualizes a point you "
            "make (an architecture, a process, a result/chart, a comparison table, an example figure), "
            "EMBED it inline by writing a marker on its OWN line exactly: [[VISUAL:<id>]] — right after "
            "the sentence or paragraph it relates to — and add one short sentence explaining what it "
            "shows. FAVOR including relevant visuals: if any caption clearly relates to your answer, "
            "embed it. Include up to 3. Use ONLY ids from AVAILABLE_VISUALS; never invent one. Skip a "
            "visual only if none relate to the answer.\n"
        )
    if citations:
        citation_rule = (
            "Cite sources INLINE like reference chips: right after a sentence or claim that a source "
            "supports, add a marker [[CITE:n]] using the number n from the SOURCES list. Cite the "
            "specific source; one citation per claim is enough — do not over-cite. Use ONLY numbers "
            "present in SOURCES, never invent one. Do NOT write '(Source: ...)' text.\n"
        )
    else:
        citation_rule = "Do NOT add inline citations like '(Source: ...)'. Sources are shown separately.\n"
    sys = (
        "You are Synapse.\n"
        "Answer the USER_QUERY using the EVIDENCE (facts retrieved from the user's PDFs).\n"
        "PRIOR_CONVERSATION is provided ONLY to resolve references (pronouns, 'it', follow-ups). "
        "Do NOT repeat, copy, or restate any earlier answer — write a NEW answer that directly "
        "addresses the current USER_QUERY.\n"
        "If the evidence is insufficient, answer using your general knowledge.\n"
        "If the user asks for a definition/acronym expansion, include 2-4 extra sentences of nearby context or practical meaning when possible.\n"
        + visual_rule
        + _FORMAT_RULES.get(detail, _FORMAT_RULES["balanced"])
        + citation_rule
        + "Do NOT mention whether you did or did not find information in the user's PDFs.\n"
        "Do NOT include chunk_id, doc_id, library_id, embedding ids, or any internal identifiers in the answer.\n"
        + _DETAIL_RULES.get(detail, _DETAIL_RULES["balanced"])
        + "At the very end, output a single line exactly: SOURCES_USED: yes|no (yes only if you actually used the EVIDENCE).\n"
    )
    user = _compose_user_prompt(user_query, convo, evidence)
    if visuals:
        lines = ["AVAILABLE_VISUALS (figures/tables you may embed with [[VISUAL:id]]):"]
        for v in visuals:
            cap = str(v.get("caption") or "").strip() or f"{v.get('kind') or 'figure'}"
            lines.append(f"[{v.get('visual_id')}] {cap} (from {v.get('doc_title') or 'PDF'}, p.{v.get('page')})")
        user = user + "\n" + "\n".join(lines) + "\n"
    if citations:
        lines = ["SOURCES (cite inline with [[CITE:n]] using these numbers):"]
        for c in citations:
            t = str(c.get("doc_title") or "Source")
            pg = c.get("page")
            lines.append(f"[{c.get('n')}] {t}" + (f", p.{pg}" if pg is not None else ""))
        user = user + "\n" + "\n".join(lines) + "\n"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _ungrounded_answer_prompt(user_query: str, convo: str) -> List[Dict[str, str]]:
    sys = (
        "You are Synapse.\n"
        "No relevant sources were retrieved from the user's libraries.\n"
        "Answer the user's question using your general knowledge.\n"
        "Be clear and helpful.\n"
        "Do NOT claim you quoted or verified anything from the user's PDFs.\n"
    )
    convo_prefix = (convo + "\n\n") if convo else ""
    user = f"{convo_prefix}USER_QUERY:\n{user_query}\n"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]

def _conversation_prefix(summary: Optional[str], history: Optional[List[Dict[str, str]]]) -> str:
    parts = []
    if summary:
        parts.append(f"THREAD_SUMMARY:\n{summary.strip()}")
    if history:
        # Keep only the last few turns, and TRUNCATE prior assistant answers so a full previous
        # answer can't be copied wholesale into the next turn (root cause of the off-by-one
        # "answer repeats" bug). User turns are short questions, so keep them intact.
        lines = []
        for m in history[-8:]:
            role = str(m.get("role") or "user")
            content = str(m.get("content") or "").strip()
            if not content:
                continue
            if role == "assistant" and len(content) > 400:
                content = content[:400].rstrip() + " …"
            lines.append(f"{role}: {content}")
        if lines:
            parts.append("RECENT_TURNS:\n" + "\n".join(lines))
    return "\n\n".join(parts).strip()


def _verbose_errors_enabled() -> bool:
    v = str(os.getenv("CHAT_VERBOSE_ERRORS", "1")).strip().lower()
    return v not in {"0", "false", "off", "no"}


def _error_response(exc: Exception, where: str):
    if _verbose_errors_enabled():
        return JSONResponse(
            status_code=500,
            content={
                "error": f"Chat backend crashed in {where}.",
                "exception_type": type(exc).__name__,
                "exception_message": str(exc),
                "traceback": traceback.format_exc()[-8000:],
            },
        )
    raise exc


def _compact_impl(req: CompactRequest):
    if not req.organization_id or not req.messages:
        raise HTTPException(status_code=400, detail="Missing organization_id or messages.")

    client = _get_openai_client()
    model = _gpt_model()

    turns = []
    for m in req.messages[-60:]:
        role = str(m.get("role") or "")
        content = str(m.get("content") or "")
        if not content:
            continue
        turns.append(f"{role}: {content}")

    sys = (
        "You are Synapse. Summarize the conversation so far for future continuation.\n"
        "Return STRICT JSON only: {\"summary\": string, \"title\": string}.\n"
        "The summary must preserve: user goals, constraints, decisions, definitions, and any specific entities/numbers.\n"
        "The title should be short (4-8 words) and describe the chat.\n"
    )
    user = "CONVERSATION:\n" + "\n".join(turns)

    out = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
        temperature=0.2,
        max_tokens=320,
    )
    content = (out.choices[0].message.content or "").strip()
    j = _json_extract(content)
    summary = str(j.get("summary") or "").strip()
    title = str(j.get("title") or "").strip() or "Continuation"
    if not summary:
        raise HTTPException(status_code=500, detail="Failed to generate summary.")
    return {"summary": summary, "title": title}


@router.post("/chat/compact")
def compact(req: CompactRequest):
    try:
        return _compact_impl(req)
    except Exception as exc:
        return _error_response(exc, "/chat/compact")


@router.post("/chat/compact/")
def compact_slash(req: CompactRequest):
    try:
        return _compact_impl(req)
    except Exception as exc:
        return _error_response(exc, "/chat/compact/")


def _retrieve_rows(
    organization_id: str,
    library_ids: List[str],
    query_text: str,
    query_embedding: List[float],
    top_k: int,
    hop: int,
    worker_ctx: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Run one retrieval round for a single (sub-)query.

    Prefers the durable worker queue (parallel vector + keyword + cross-encoder rerank) when a
    worker context is available, and transparently falls back to inline retrieval against the
    same database if workers are unavailable or return nothing. Used by both the initial hop and
    every curiosity hop, so the orchestration above stays mode-agnostic.
    """
    rows: List[Dict[str, Any]] = []
    if worker_ctx:
        try:
            worker_ctx["enqueue"](
                worker_ctx["job_id"],
                organization_id,
                library_ids,
                hop=hop,
                query_text=query_text,
                query_embedding=query_embedding,
                kinds=["vector", "keyword"],
                top_k=top_k,
            )
            results = worker_ctx["wait"](
                worker_ctx["job_id"],
                hop=hop,
                kinds=["vector", "keyword"],
                timeout_s=float(os.getenv("CHAT_HOP_TIMEOUT", "20")),
            )
            for r in results:
                for ch in (r.get("chunks") or []):
                    if isinstance(ch, dict):
                        rows.append(ch)
            if rows:
                return rows
        except Exception:
            rows = []

    # Inline fallback (no queue tables / workers, or workers returned nothing).
    os.environ["CHAT_LAST_QUERY_TEXT"] = query_text
    rows = retrieve_chunks(organization_id, library_ids, query_embedding, top_k=top_k)
    if not rows:
        try:
            from chat_runtime import keyword_search_chunks

            rows = keyword_search_chunks(organization_id, library_ids, query_text, top_k=top_k)
        except Exception:
            rows = []
    return rows


def _hydrate_titles(rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Attach doc_title to each row (so the LLM cites PDF names) and return the full doc meta map."""
    doc_ids = sorted({str(r.get("doc_id")) for r in rows if str(r.get("doc_id") or "")})
    meta = hydrate_doc_titles(doc_ids)
    for rr in rows:
        did = str(rr.get("doc_id") or "")
        if did and did in meta:
            rr["doc_title"] = meta[did].get("doc_title") or None
    return meta


def _build_sources_from(
    items: List[Dict[str, Any]],
    meta: Dict[str, Dict[str, Any]],
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """
    Build the source PDF list from notes (preferred — only the docs actually cited) or rows.
    Dedupes by chunk_id (falling back to doc+page), preserving order, and hydrates the gdrive /
    storage fields the frontend uses to open the source PDF.
    """
    sources: List[Dict[str, Any]] = []
    seen = set()
    for r in items:
        cid = str(r.get("chunk_id") or "")
        key = cid or f"{r.get('doc_id')}:{r.get('page_start')}:{r.get('page_end')}"
        if key in seen:
            continue
        seen.add(key)
        did = str(r.get("doc_id") or "")
        m = meta.get(did) or {}
        sources.append(
            {
                "library_id": r.get("library_id"),
                "doc_id": r.get("doc_id"),
                "doc_title": m.get("doc_title") or r.get("doc_title"),
                "storage_path_raw": m.get("storage_path_raw"),
                "path_in_source": m.get("path_in_source"),
                "gdrive_file_id": m.get("gdrive_file_id"),
                "page_start": r.get("page_start"),
                "page_end": r.get("page_end"),
                "chunk_id": r.get("chunk_id"),
                "score": r.get("score"),
            }
        )
        if len(sources) >= limit:
            break

    # Attach the verbatim chunk text + a little neighbour context, used by the frontend for the
    # hover popover and to highlight the passage inside the in-app PDF viewer. Best-effort.
    try:
        from chat_runtime import fetch_chunk_snippets

        cids = [str(s.get("chunk_id")) for s in sources if s.get("chunk_id")]
        snips = fetch_chunk_snippets(cids)
        for s in sources:
            info = snips.get(str(s.get("chunk_id") or "")) or {}
            s["snippet"] = info.get("text") or None
            s["context_before"] = info.get("before") or None
            s["context_after"] = info.get("after") or None
    except Exception:
        pass

    return sources


def _chat_impl(req: ChatRequest):
    """
    Multi-agent retrieval pipeline (Phase 1).

      Planner (classify + rewrite + retrieval gate)
        -> Retriever (workers or inline, hop 0)
        -> Extractor (distill chunks into source-anchored notes)
        -> [ CuriousLLM hop controller -> Retriever -> Extractor ] x max_hops
        -> Context-Document builder
        -> Synthesizer (final grounded answer)
        -> source PDFs (only the docs that contributed evidence)

    Response contract is unchanged (answer/sources/followups/*_hash) plus an additive
    `query_class` field for debugging/demo. See docs/retrieval-pipeline-design.md.
    """
    if not req.organization_id or not req.message.strip():
        raise HTTPException(status_code=400, detail="Missing organization_id or message.")
    if not req.library_ids:
        raise HTTPException(status_code=400, detail="Select at least one processed library.")

    top_k = max(3, min(int(req.top_k or 10), _max_topk_cap()))
    max_hops = max(0, min(int(req.max_hops or 2), _max_hops_cap()))
    convo = _conversation_prefix(req.thread_summary, req.history)
    server_prompt_hash = hashlib.sha1((req.message or "").strip().encode("utf-8")).hexdigest()
    extractor_on = str(os.getenv("CHAT_ENABLE_EXTRACTOR", "1")).strip() not in {"0", "false", "False"}
    max_tokens = int(os.getenv("CHAT_MAX_TOKENS", "1500"))

    org = req.organization_id
    libs = req.library_ids

    client = _get_openai_client()
    model = _gpt_model()

    followups: List[Dict[str, Any]] = []

    rid = req.client_request_id

    # --- Planner: chain-of-thought classify + query rewrite + decompose + retrieval gate.
    _set_progress(rid, "Understanding your question")
    plan = plan_query(client, req.message, convo)
    query_class = plan.get("query_class") or "SPOTLIGHT"
    search_query = plan.get("search_query") or req.message
    # Reasoning depth (user-selectable): low / medium / high.
    mode = (req.thinking_mode or os.getenv("CHAT_DEFAULT_THINKING_MODE", "medium")).strip().lower()
    if mode not in THINKING_MODES:
        mode = "medium"
    mode_rounds, mode_subqs, breadth_mult, mode_answer_tokens, mode_detail = THINKING_MODES[mode]
    # Env can cap the deepest setting (e.g. to avoid the proxy timeout on slow models).
    max_critic_rounds = min(mode_rounds, max(0, int(os.getenv("CHAT_MAX_CRITIC_ROUNDS", "2"))))
    sub_queries = (plan.get("sub_queries") or [])[:mode_subqs]
    # Output length scales with the mode (env CHAT_ANSWER_MAX_TOKENS overrides if set).
    answer_max_tokens = int(os.getenv("CHAT_ANSWER_MAX_TOKENS") or mode_answer_tokens)
    # "Complex" queries get the deep treatment (multi-query recall + completeness critic loop);
    # spotlight/simple queries use the fast single-pass path. (Adaptive routing — Loong.)
    complex_query = query_class in {"MULTI_HOP", "COMPARISON", "AGGREGATION", "MULTI_ENTITY"}

    def _ungrounded_payload() -> Dict[str, Any]:
        ans = client.chat.completions.create(
            model=model,
            messages=_ungrounded_answer_prompt(req.message, convo),
            temperature=0.3,
            max_tokens=max_tokens,
        )
        answer = (ans.choices[0].message.content or "").strip()
        return {
            "answer": answer,
            "sources": [],
            "followups": [],
            "query_class": query_class,
            "client_request_id": req.client_request_id,
            "client_prompt_hash": req.client_prompt_hash,
            "server_prompt_hash": server_prompt_hash,
        }

    # Conversational queries (greetings/meta) skip retrieval entirely.
    if not plan.get("needs_retrieval", True):
        return _ungrounded_payload()

    # --- Worker context (optional; _retrieve_rows falls back to inline transparently).
    use_workers = str(os.getenv("CHAT_USE_WORKERS", "1")).strip() not in {"0", "false", "False"}
    worker_ctx: Optional[Dict[str, Any]] = None
    chat_job_id: Optional[str] = None
    mark_chat_job_done = None
    mark_chat_job_failed = None
    if use_workers:
        try:
            from chat_queue import (
                create_chat_job,
                enqueue_retrieval_tasks,
                wait_hop_results,
                mark_chat_job_done as _mark_done,
                mark_chat_job_failed as _mark_failed,
            )

            job = create_chat_job(org, libs, req.message, top_k=top_k, max_hops=max_hops)
            chat_job_id = str(job.get("id"))
            worker_ctx = {"job_id": chat_job_id, "enqueue": enqueue_retrieval_tasks, "wait": wait_hop_results}
            mark_chat_job_done = _mark_done
            mark_chat_job_failed = _mark_failed
        except Exception:
            worker_ctx = None
            chat_job_id = None

    try:
        # --- Retrieval state + helper. Multi-query recall up front, then (for complex queries) a
        # draft -> completeness-critic -> gap-fill -> revise loop. Simple queries stay single-pass.
        rows: List[Dict[str, Any]] = []
        notes: List[Dict[str, Any]] = []
        meta: Dict[str, Dict[str, Any]] = {}
        seen_chunks: set = set()
        hop_counter = 0

        # Breadth for comparison/aggregation/multi-entity: cast a wider net per query (Loong).
        # The multiplier scales with the thinking mode.
        eff_top_k = top_k
        if query_class in {"COMPARISON", "AGGREGATION", "MULTI_ENTITY"} and breadth_mult > 1.0:
            eff_top_k = min(_max_topk_cap(), max(top_k, int(top_k * breadth_mult)))

        def _retrieve_only(query_text: str, k: int) -> List[Dict[str, Any]]:
            """Retrieve for one (sub-)query, merge new chunks into rows, return only the fresh ones."""
            nonlocal hop_counter
            hop_counter += 1
            qv = embed_query(query_text)
            fetched = _retrieve_rows(org, libs, query_text, qv, k, hop_counter, worker_ctx)
            fresh: List[Dict[str, Any]] = []
            for r in fetched:
                cid = str(r.get("chunk_id") or "")
                if cid and cid in seen_chunks:
                    continue
                rows.append(r)
                fresh.append(r)
                if cid:
                    seen_chunks.add(cid)
            return fresh

        def _ingest_notes(query_text: str, fresh: List[Dict[str, Any]]) -> None:
            """Hydrate titles, then distill a batch of fresh rows into notes in ONE Extractor call."""
            nonlocal meta
            if not fresh:
                return
            meta = _hydrate_titles(rows)
            if extractor_on:
                notes.extend(extract_notes(client, query_text, fresh, sub_query=query_text))

        # --- Initial retrieval: rewritten query + (for complex queries) the planned sub-queries.
        # Retrieve for all, union, then extract once (keeps call-count bounded for deep queries).
        initial_queries = [search_query]
        if complex_query:
            for sq in sub_queries:
                if sq and sq.lower() not in {q.lower() for q in initial_queries}:
                    initial_queries.append(sq)
        _set_progress(rid, "Searching your libraries")
        initial_fresh: List[Dict[str, Any]] = []
        for q in initial_queries[:5]:
            initial_fresh.extend(_retrieve_only(q, eff_top_k))
        _set_progress(rid, "Reading the most relevant passages")
        _ingest_notes(search_query, initial_fresh)

        if not rows:
            payload = _ungrounded_payload()
            if mark_chat_job_done and chat_job_id:
                try:
                    mark_chat_job_done(chat_job_id, payload)
                except Exception:
                    pass
            return payload

        if not meta:
            meta = _hydrate_titles(rows)
        context_doc = build_context_document(notes) or build_evidence_brief(rows)

        inline_cites_on = str(os.getenv("CHAT_INLINE_CITATIONS", "1")).strip() not in {"0", "false", "False"}

        def _build_cites() -> List[Dict[str, Any]]:
            """Numbered list of the source documents currently in evidence (for inline [[CITE:n]])."""
            out: List[Dict[str, Any]] = []
            seen: set = set()
            for it in (notes if notes else rows):
                did = str(it.get("doc_id") or "")
                if not did or did in seen:
                    continue
                seen.add(did)
                m = meta.get(did) or {}
                out.append(
                    {
                        "n": len(out) + 1,
                        "doc_id": did,
                        "doc_title": m.get("doc_title") or it.get("doc_title"),
                        "gdrive_file_id": m.get("gdrive_file_id"),
                        "page": it.get("page_start"),
                    }
                )
                if len(out) >= 12:
                    break
            return out

        def _synthesize(visuals: Optional[List[Dict[str, Any]]] = None,
                        citations: Optional[List[Dict[str, Any]]] = None) -> str:
            out = client.chat.completions.create(
                model=model,
                messages=_final_answer_prompt(
                    req.message, convo, context_doc, visuals=visuals or None,
                    detail=mode_detail, citations=citations or None,
                ),
                temperature=0.2,
                max_tokens=answer_max_tokens,
            )
            return (out.choices[0].message.content or "").strip()

        # --- Draft answer.
        _set_progress(rid, "Drafting an answer")
        final_cites = _build_cites() if inline_cites_on else []
        draft = _synthesize(citations=final_cites)

        # --- Completeness-critic loop (complex queries only): find gaps -> retrieve -> revise.
        if complex_query and max_critic_rounds > 0:
            for _crit_round in range(max_critic_rounds):
                _set_progress(rid, "Reviewing the answer for gaps")
                verdict = critique_answer(client, req.message, draft, context_doc)
                if verdict.get("complete") or not verdict.get("missing"):
                    break
                _set_progress(rid, "Digging deeper into the sources")
                round_fresh: List[Dict[str, Any]] = []
                for mq in verdict["missing"][:4]:
                    followups.append({"hop": len(followups) + 1, "query": mq})
                    round_fresh.extend(_retrieve_only(mq, max(4, eff_top_k // 2)))
                if not round_fresh:
                    break  # nothing new surfaced — stop rather than spin
                _ingest_notes(req.message, round_fresh)
                context_doc = build_context_document(notes) or build_evidence_brief(rows)
                _set_progress(rid, "Revising the answer")
                final_cites = _build_cites() if inline_cites_on else []
                draft = _synthesize(citations=final_cites)  # revise with the augmented evidence

        # --- Gather figures/tables for the converged evidence, then do the FINAL synthesis with
        # inline visuals (one extra call only when there are visuals to place).
        source_items = notes if notes else rows
        available_visuals: List[Dict[str, Any]] = []
        if str(os.getenv("CHAT_ENABLE_VISUALS", "1")).strip() not in {"0", "false", "False"}:
            try:
                # Gather candidate figures/tables from ALL retrieved chunks (broader recall), so the
                # synthesizer has more relevant visuals to choose from — not just the cited ones.
                vis_chunk_ids = [str(r.get("chunk_id")) for r in rows if r.get("chunk_id")]
                available_visuals = fetch_chunk_visuals(vis_chunk_ids, max_visuals=16)
            except Exception:
                available_visuals = []

        if available_visuals:
            _set_progress(rid, "Writing the final answer with figures")
            final_cites = _build_cites() if inline_cites_on else []
            answer = _synthesize(visuals=available_visuals, citations=final_cites)
        else:
            answer = draft
        # UI renders sources separately; strip any inline "(Source: ...)" the model might emit.
        answer = re.sub(r"\(\s*Source\s*:[^)]+\)", "", answer, flags=re.IGNORECASE).strip()
        answer, sources_used = _strip_and_detect_sources_used(answer)

        # --- Resolve the [[VISUAL:id]] markers the model placed: keep valid ones, strip the rest.
        visuals_out: List[Dict[str, Any]] = []
        if available_visuals:
            vis_by_id = {str(v.get("visual_id")): v for v in available_visuals}
            referenced = [m.strip() for m in re.findall(r"\[\[VISUAL:([^\]]+)\]\]", answer)]
            valid_ids: List[str] = []
            for vid in referenced:
                v = vis_by_id.get(vid)
                if v and vid not in valid_ids and len(valid_ids) < 3:
                    valid_ids.append(vid)
                    visuals_out.append(
                        {
                            "visual_id": v.get("visual_id"),
                            "visual_key": v.get("visual_key"),
                            "caption": v.get("caption"),
                            "page": v.get("page"),
                            "kind": v.get("kind"),
                            "doc_id": v.get("doc_id"),
                            "doc_title": v.get("doc_title"),
                        }
                    )
            valid_set = set(valid_ids)
            # Strip any marker that didn't resolve (hallucinated id or over the cap).
            answer = re.sub(
                r"[ \t]*\[\[VISUAL:([^\]]+)\]\][ \t]*",
                lambda m: m.group(0) if m.group(1).strip() in valid_set else "",
                answer,
            ).strip()

        # --- Resolve the [[CITE:n]] inline source-reference markers: keep valid ones, strip the rest.
        citations_out: List[Dict[str, Any]] = []
        if final_cites:
            cite_by_n = {str(c.get("n")): c for c in final_cites}
            referenced = {m.strip() for m in re.findall(r"\[\[CITE:([^\]]+)\]\]", answer)}
            for n in sorted(referenced, key=lambda x: int(x) if x.isdigit() else 9999):
                c = cite_by_n.get(n)
                if c:
                    citations_out.append(
                        {
                            "n": c.get("n"),
                            "doc_id": c.get("doc_id"),
                            "doc_title": c.get("doc_title"),
                            "gdrive_file_id": c.get("gdrive_file_id"),
                            "page": c.get("page"),
                        }
                    )
            valid_cite = set(cite_by_n.keys())
            answer = re.sub(
                r"\[\[CITE:([^\]]+)\]\]",
                lambda m: m.group(0) if m.group(1).strip() in valid_cite else "",
                answer,
            )

        # --- Sources: prefer the docs that actually contributed notes; fall back to all rows.
        sources = _build_sources_from(source_items, meta, limit=20)

        # Show sources if the model says it used evidence OR retrieval confidence is high
        # (prevents hiding sources due to a bad self-report).
        retrieval_confident = _max_row_score(rows) >= _min_source_score()
        if not sources_used and not retrieval_confident:
            sources = []

        payload = {
            "answer": answer,
            "sources": sources,
            "visuals": visuals_out,
            "citations": citations_out,
            "followups": followups,
            "query_class": query_class,
            "thinking_mode": mode,
            "client_request_id": req.client_request_id,
            "client_prompt_hash": req.client_prompt_hash,
            "server_prompt_hash": server_prompt_hash,
        }
        if mark_chat_job_done and chat_job_id:
            try:
                mark_chat_job_done(chat_job_id, payload)
            except Exception:
                pass
        return payload
    except Exception as exc:
        if mark_chat_job_failed and chat_job_id:
            try:
                mark_chat_job_failed(chat_job_id, str(exc))
            except Exception:
                pass
        raise


@router.post("/chat")
def chat(req: ChatRequest):
    try:
        return _chat_impl(req)
    except Exception as exc:
        return _error_response(exc, "/chat")
    finally:
        _clear_progress(req.client_request_id)


@router.post("/chat/")
def chat_slash(req: ChatRequest):
    try:
        return _chat_impl(req)
    except Exception as exc:
        return _error_response(exc, "/chat/")
    finally:
        _clear_progress(req.client_request_id)
