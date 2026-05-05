import os
import json
import traceback
import re
import hashlib
from typing import Any, Dict, List, Optional

from env_bootstrap import load_env
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from chat_runtime import build_evidence_brief, embed_query, hydrate_doc_titles, retrieve_chunks

load_env()

router = APIRouter()


class ChatRequest(BaseModel):
    organization_id: str = Field(..., description="Organization UUID")
    library_ids: List[str] = Field(default_factory=list)
    message: str
    max_hops: int = 4
    top_k: int = 12
    thread_summary: Optional[str] = None
    history: Optional[List[Dict[str, str]]] = None
    client_request_id: Optional[str] = None
    client_prompt_hash: Optional[str] = None

class CompactRequest(BaseModel):
    organization_id: str
    messages: List[Dict[str, str]]  # {role, content}


def _get_openai_client():
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY in /workspace/.env")
    from openai import OpenAI  # type: ignore

    return OpenAI(api_key=api_key)


def _gpt_model() -> str:
    return (os.getenv("CHAT_GPT_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"

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


def _followup_decision_prompt(user_query: str, evidence: str) -> List[Dict[str, str]]:
    sys = (
        "You are Synapse, a retrieval orchestrator. Decide if the provided evidence is sufficient to answer.\n"
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
    user = f"USER_QUERY:\n{user_query}\n\nEVIDENCE:\n{evidence}\n"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _final_answer_prompt(user_query: str, evidence: str) -> List[Dict[str, str]]:
    sys = (
        "You are Synapse.\n"
        "Prefer answering using the EVIDENCE provided.\n"
        "If the evidence is insufficient, answer using your general knowledge.\n"
        "Write a helpful answer, not just a single-line definition.\n"
        "If the user asks for a definition/acronym expansion, include 2-4 extra sentences of nearby context or practical meaning when possible.\n"
        "If helpful, include 2-5 short bullet points (e.g. why it matters, common pitfalls, where it appears).\n"
        "Do NOT mention whether you did or did not find information in the user's PDFs.\n"
        "Do NOT add inline citations like '(Source: ...)'. Sources are shown separately in the UI.\n"
        "Do NOT include chunk_id, doc_id, library_id, embedding ids, or any internal identifiers in the answer.\n"
        "Be concise.\n"
        "At the very end, output a single line exactly: SOURCES_USED: yes|no (yes only if you actually used the EVIDENCE).\n"
    )
    user = f"USER_QUERY:\n{user_query}\n\nEVIDENCE:\n{evidence}\n"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _ungrounded_answer_prompt(user_query: str, convo: str) -> List[Dict[str, str]]:
    sys = (
        "You are Synapse.\n"
        "No relevant sources were retrieved from the user's libraries.\n"
        "Answer the user's question using your general knowledge.\n"
        "Be clear and helpful.\n"
        "Do NOT claim you quoted or verified anything from the user's PDFs.\n"
    )
    user = f"{(convo + '\\n\\n') if convo else ''}USER_QUERY:\n{user_query}\n"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]

def _conversation_prefix(summary: Optional[str], history: Optional[List[Dict[str, str]]]) -> str:
    parts = []
    if summary:
        parts.append(f"THREAD_SUMMARY:\n{summary.strip()}")
    if history:
        # only keep last few turns to avoid growing prompts
        lines = []
        for m in history[-16:]:
            role = str(m.get("role") or "user")
            content = str(m.get("content") or "")
            if not content:
                continue
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


def _chat_impl(req: ChatRequest):
    if not req.organization_id or not req.message.strip():
        raise HTTPException(status_code=400, detail="Missing organization_id or message.")
    if not req.library_ids:
        raise HTTPException(status_code=400, detail="Select at least one processed library.")

    top_k = max(3, min(int(req.top_k or 10), _max_topk_cap()))
    max_hops = max(0, min(int(req.max_hops or 2), _max_hops_cap()))

    use_workers = str(os.getenv("CHAT_USE_WORKERS", "1")).strip() not in {"0", "false", "False"}

    rows: List[Dict[str, Any]] = []
    followups: List[Dict[str, Any]] = []

    convo = _conversation_prefix(req.thread_summary, req.history)
    server_prompt_hash = hashlib.sha1((req.message or "").strip().encode("utf-8")).hexdigest()

    if use_workers:
        try:
            from chat_queue import (
                create_chat_job,
                enqueue_retrieval_tasks,
                wait_hop_results,
                mark_chat_job_done,
                mark_chat_job_failed,
            )

            job = create_chat_job(req.organization_id, req.library_ids, req.message, top_k=top_k, max_hops=max_hops)
            chat_job_id = str(job.get("id"))

            client = _get_openai_client()
            model = _gpt_model()

            # hop 0 retrieval tasks (vector + keyword)
            qvec = embed_query(req.message)
            enqueue_retrieval_tasks(
                chat_job_id,
                req.organization_id,
                req.library_ids,
                hop=0,
                query_text=req.message,
                query_embedding=qvec,
                kinds=["vector", "keyword"],
                top_k=top_k,
            )
            results = wait_hop_results(chat_job_id, hop=0, kinds=["vector", "keyword"], timeout_s=float(os.getenv("CHAT_HOP_TIMEOUT", "20")))
            for r in results:
                for ch in (r.get("chunks") or []):
                    if isinstance(ch, dict):
                        rows.append(ch)

            if not rows:
                ans = client.chat.completions.create(
                    model=model,
                    messages=_ungrounded_answer_prompt(req.message, convo),
                    temperature=0.3,
                    max_tokens=int(os.getenv("CHAT_MAX_TOKENS", "700")),
                )
                answer = (ans.choices[0].message.content or "").strip()
                payload = {
                    "answer": answer,
                    "sources": [],
                    "followups": [],
                    "client_request_id": req.client_request_id,
                    "client_prompt_hash": req.client_prompt_hash,
                    "server_prompt_hash": server_prompt_hash,
                }
                mark_chat_job_done(chat_job_id, payload)
                return payload

            # Curious hop loop: GPT decides follow-up; workers fetch; repeat.
            # Attach doc titles early so the LLM can cite by PDF name (not internal ids).
            doc_ids0 = sorted({str(r.get("doc_id")) for r in rows if str(r.get("doc_id") or "")})
            meta0 = hydrate_doc_titles(doc_ids0)
            for rr in rows:
                did = str(rr.get("doc_id") or "")
                if did and did in meta0:
                    rr["doc_title"] = meta0[did].get("doc_title") or None
            evidence = build_evidence_brief(rows)
            for hop in range(max_hops):
                dec = client.chat.completions.create(
                    model=model,
                    messages=_followup_decision_prompt(req.message, (convo + "\n\n" + evidence).strip() if convo else evidence),
                    temperature=0.2,
                    max_tokens=350,
                )
                content = (dec.choices[0].message.content or "").strip()
                j = _json_extract(content)
                next_action = str(j.get("next_action") or "").upper()
                if next_action == "NA":
                    break
                if next_action != "FOLLOWUP":
                    break
                fq = str(j.get("followup_query") or "").strip()
                if not fq:
                    break
                followups.append({"hop": hop + 1, "query": fq})

                fq_vec = embed_query(fq)
                enqueue_retrieval_tasks(
                    chat_job_id,
                    req.organization_id,
                    req.library_ids,
                    hop=hop + 1,
                    query_text=fq,
                    query_embedding=fq_vec,
                    kinds=["vector", "keyword"],
                    top_k=max(3, top_k // 2),
                )
                hop_results = wait_hop_results(chat_job_id, hop=hop + 1, kinds=["vector", "keyword"], timeout_s=float(os.getenv("CHAT_HOP_TIMEOUT", "20")))
                seen = {str(r.get("chunk_id")) for r in rows if r.get("chunk_id")}
                for hr in hop_results:
                    for ch in (hr.get("chunks") or []):
                        if not isinstance(ch, dict):
                            continue
                        cid = str(ch.get("chunk_id") or "")
                        if cid and cid in seen:
                            continue
                        rows.append(ch)
                        if cid:
                            seen.add(cid)

                # Re-hydrate doc titles as we add more rows.
                doc_ids_h = sorted({str(r.get("doc_id")) for r in rows if str(r.get("doc_id") or "")})
                meta_h = hydrate_doc_titles(doc_ids_h)
                for rr in rows:
                    did = str(rr.get("doc_id") or "")
                    if did and did in meta_h:
                        rr["doc_title"] = meta_h[did].get("doc_title") or None
                evidence = build_evidence_brief(rows)

            ans = client.chat.completions.create(
                model=model,
                messages=_final_answer_prompt(req.message, (convo + "\n\n" + evidence).strip() if convo else evidence),
                temperature=0.2,
                max_tokens=int(os.getenv("CHAT_MAX_TOKENS", "700")),
            )
            answer = (ans.choices[0].message.content or "").strip()
            # UI renders sources separately; strip any inline "(Source: ...)" the model might emit.
            answer = re.sub(r"\(\s*Source\s*:[^)]+\)", "", answer, flags=re.IGNORECASE).strip()
            answer, sources_used = _strip_and_detect_sources_used(answer)

            # Hydrate sources
            doc_ids = [str(r.get("doc_id")) for r in rows if r.get("doc_id")]
            meta = hydrate_doc_titles(doc_ids)
            sources = []
            for r in rows[: min(len(rows), 20)]:
                did = str(r.get("doc_id") or "")
                m = meta.get(did) or {}
                sources.append(
                    {
                        "library_id": r.get("library_id"),
                        "doc_id": r.get("doc_id"),
                        "doc_title": m.get("doc_title"),
                        "storage_path_raw": m.get("storage_path_raw"),
                        "path_in_source": m.get("path_in_source"),
                        "gdrive_file_id": m.get("gdrive_file_id"),
                        "page_start": r.get("page_start"),
                        "page_end": r.get("page_end"),
                        "chunk_id": r.get("chunk_id"),
                        "score": r.get("score"),
                    }
                )

            # Show sources if either:
            # 1) the model says it used evidence, OR
            # 2) retrieval confidence is high (prevents hiding sources due to a bad self-report).
            retrieval_confident = _max_row_score(rows) >= _min_source_score()
            if not sources_used and not retrieval_confident:
                sources = []

            payload = {
                "answer": answer,
                "sources": sources,
                "followups": followups,
                "client_request_id": req.client_request_id,
                "client_prompt_hash": req.client_prompt_hash,
                "server_prompt_hash": server_prompt_hash,
            }
            mark_chat_job_done(chat_job_id, payload)
            return payload
        except Exception as exc:
            try:
                # Best-effort: mark job failed if it exists
                mark_chat_job_failed(chat_job_id, str(exc))  # type: ignore[name-defined]
            except Exception:
                pass
            # fall back to inline mode
            use_workers = False

    # Inline fallback (no queue tables / workers)
    # Provide the query text as a last-resort hint for keyword fallback inside chat_runtime.
    os.environ["CHAT_LAST_QUERY_TEXT"] = req.message
    qvec = embed_query(req.message)
    rows = retrieve_chunks(req.organization_id, req.library_ids, qvec, top_k=top_k)
    if not rows:
        # Keyword fallback when vector RPC isn't installed yet.
        try:
            from chat_runtime import keyword_search_chunks
            rows = keyword_search_chunks(req.organization_id, req.library_ids, req.message, top_k=top_k)
        except Exception:
            rows = []

    if not rows:
        ans = client.chat.completions.create(
            model=model,
            messages=_ungrounded_answer_prompt(req.message, convo),
            temperature=0.3,
            max_tokens=int(os.getenv("CHAT_MAX_TOKENS", "700")),
        )
        answer = (ans.choices[0].message.content or "").strip()
        return {
            "answer": answer,
            "sources": [],
            "followups": [],
            "client_request_id": req.client_request_id,
            "client_prompt_hash": req.client_prompt_hash,
            "server_prompt_hash": server_prompt_hash,
        }

    client = _get_openai_client()
    model = _gpt_model()

    # CuriousLLM-style hop loop (small, budgeted)
    doc_ids0 = sorted({str(r.get("doc_id")) for r in rows if str(r.get("doc_id") or "")})
    meta0 = hydrate_doc_titles(doc_ids0)
    for rr in rows:
        did = str(rr.get("doc_id") or "")
        if did and did in meta0:
            rr["doc_title"] = meta0[did].get("doc_title") or None
    evidence = build_evidence_brief(rows)
    for hop in range(max_hops):
        dec = client.chat.completions.create(
            model=model,
            messages=_followup_decision_prompt(req.message, (convo + "\n\n" + evidence).strip() if convo else evidence),
            temperature=0.2,
            max_tokens=350,
        )
        content = (dec.choices[0].message.content or "").strip()
        j = _json_extract(content)
        next_action = str(j.get("next_action") or "").upper()
        if next_action == "NA":
            break
        if next_action != "FOLLOWUP":
            # If model returns something unexpected, stop rather than looping.
            break
        fq = str(j.get("followup_query") or "").strip()
        if not fq:
            break
        followups.append({"hop": hop + 1, "query": fq})
        fq_vec = embed_query(fq)
        more = retrieve_chunks(req.organization_id, req.library_ids, fq_vec, top_k=max(3, top_k // 2))
        # Merge (dedupe by chunk_id)
        seen = {str(r.get("chunk_id")) for r in rows if r.get("chunk_id")}
        for r in more:
            cid = str(r.get("chunk_id") or "")
            if cid and cid in seen:
                continue
            rows.append(r)
            if cid:
                seen.add(cid)
        doc_ids_h = sorted({str(r.get("doc_id")) for r in rows if str(r.get("doc_id") or "")})
        meta_h = hydrate_doc_titles(doc_ids_h)
        for rr in rows:
            did = str(rr.get("doc_id") or "")
            if did and did in meta_h:
                rr["doc_title"] = meta_h[did].get("doc_title") or None
        evidence = build_evidence_brief(rows)

    # Final answer
    ans = client.chat.completions.create(
        model=model,
        messages=_final_answer_prompt(req.message, (convo + "\n\n" + evidence).strip() if convo else evidence),
        temperature=0.2,
        max_tokens=int(os.getenv("CHAT_MAX_TOKENS", "700")),
    )
    answer = (ans.choices[0].message.content or "").strip()
    answer = re.sub(r"\(\s*Source\s*:[^)]+\)", "", answer, flags=re.IGNORECASE).strip()
    answer, sources_used = _strip_and_detect_sources_used(answer)

    # Hydrate sources
    doc_ids = [str(r.get("doc_id")) for r in rows if r.get("doc_id")]
    meta = hydrate_doc_titles(doc_ids)
    sources = []
    for r in rows[: min(len(rows), 20)]:
        did = str(r.get("doc_id") or "")
        m = meta.get(did) or {}
        sources.append(
            {
                "library_id": r.get("library_id"),
                "doc_id": r.get("doc_id"),
                "doc_title": m.get("doc_title"),
                "storage_path_raw": m.get("storage_path_raw"),
                "path_in_source": m.get("path_in_source"),
                "gdrive_file_id": m.get("gdrive_file_id"),
                "page_start": r.get("page_start"),
                "page_end": r.get("page_end"),
                "chunk_id": r.get("chunk_id"),
                "score": r.get("score"),
            }
        )

    retrieval_confident = _max_row_score(rows) >= _min_source_score()
    if not sources_used and not retrieval_confident:
        sources = []

    return {
        "answer": answer,
        "sources": sources,
        "followups": followups,
        "client_request_id": req.client_request_id,
        "client_prompt_hash": req.client_prompt_hash,
        "server_prompt_hash": server_prompt_hash,
    }


@router.post("/chat")
def chat(req: ChatRequest):
    try:
        return _chat_impl(req)
    except Exception as exc:
        return _error_response(exc, "/chat")


@router.post("/chat/")
def chat_slash(req: ChatRequest):
    try:
        return _chat_impl(req)
    except Exception as exc:
        return _error_response(exc, "/chat/")
