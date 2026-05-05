import os
import re
import time
from typing import Any, Dict, List

from env_bootstrap import load_env

from chat_queue import (
    claim_retrieval_task,
    complete_retrieval_task,
    fail_retrieval_task,
)
from chat_runtime import retrieve_chunks

load_env()

WORKER_ID = os.getenv("WORKER_ID", "chat-retriever-1")


def _keywords(q: str) -> List[str]:
    q = (q or "").strip().lower()
    toks = re.findall(r"[a-z0-9][a-z0-9_\-]{2,}", q)
    stop = {
        "the",
        "and",
        "for",
        "with",
        "from",
        "that",
        "this",
        "what",
        "when",
        "where",
        "which",
        "who",
        "how",
        "into",
        "about",
        "their",
        "there",
        "have",
        "has",
        "had",
        "are",
        "was",
        "were",
        "will",
        "would",
        "can",
        "could",
        "should",
        "may",
        "might",
        "also",
    }
    out = []
    for t in toks:
        if t in stop:
            continue
        if len(t) <= 2:
            continue
        out.append(t)
    return out[:12]


def _keyword_search(organization_id: str, library_ids: List[str], query_text: str, top_k: int) -> List[Dict[str, Any]]:
    """
    Cheap lexical fallback using PostgREST filters.
    Not as good as proper FTS/BM25, but helpful for names/numbers when vector misses.
    """
    from chat_queue import supabase  # reuse client

    kws = _keywords(query_text)
    if not kws:
        return []

    # Use only a few terms to keep query reasonable.
    terms = kws[:4]
    pattern = "|".join([re.escape(t) for t in terms])
    # PostgREST: ilike any of terms by OR chaining.
    # Note: supabase-py supports .or_() with a raw expression.
    or_expr = ",".join([f"text.ilike.*{t}*" for t in terms])

    results: List[Dict[str, Any]] = []
    for lib_id in library_ids[:8]:
        q = (
            supabase.table("chunk_embeddings")
            .select("chunk_id,doc_id,library_id,page_start,page_end,text")
            .eq("organization_id", organization_id)
            .eq("library_id", lib_id)
            .or_(or_expr)
            .limit(max(30, int(top_k) * 5))
        )
        res = q.execute()
        for r in (res.data or []):
            if isinstance(r, dict):
                # Heuristic base score so the chat API can decide to show sources even if the model
                # accidentally reports SOURCES_USED: no.
                r["score"] = 0.2
                results.append(r)

    # Lightweight rerank with a cross-encoder if enabled.
    try:
        if int(os.getenv("CHAT_ENABLE_RERANK", "1")) != 1:
            return results[:top_k]
    except Exception:
        return results[:top_k]

    rerank_model = os.getenv("CHAT_RERANK_MODEL", "BAAI/bge-reranker-base").strip() or "BAAI/bge-reranker-base"
    try:
        from sentence_transformers import CrossEncoder  # type: ignore

        ce = CrossEncoder(rerank_model, device=os.getenv("CHAT_RERANK_DEVICE", "cuda" if os.getenv("CUDA_VISIBLE_DEVICES") else "cpu"))
        pairs = []
        kept = []
        for r in results[:300]:
            txt = str(r.get("text") or "").strip()
            if not txt:
                continue
            pairs.append((query_text, txt[:1200]))
            kept.append(r)
        if not pairs:
            return results[:top_k]
        scores = ce.predict(pairs)
        scored = []
        for r, sc in zip(kept, scores):
            rr = dict(r)
            rr["score"] = float(sc)
            scored.append(rr)
        scored.sort(key=lambda x: float(x.get("score") or 0), reverse=True)
        return scored[:top_k]
    except Exception:
        return results[:top_k]


def run_task(task: Dict[str, Any]) -> Dict[str, Any]:
    kind = str(task.get("kind") or "")
    organization_id = str(task.get("organization_id") or "")
    library_ids = task.get("library_ids") or []
    if not isinstance(library_ids, list):
        library_ids = []

    payload = task.get("payload") or {}
    query_text = str(payload.get("query_text") or "")
    top_k = int(payload.get("top_k") or 10)
    query_embedding = payload.get("query_embedding")

    if kind == "vector":
        if not isinstance(query_embedding, list) or not query_embedding:
            return {"chunks": []}
        chunks = retrieve_chunks(organization_id, library_ids, query_embedding, top_k=top_k)
        return {"chunks": chunks}

    if kind == "keyword":
        chunks = _keyword_search(organization_id, library_ids, query_text, top_k=top_k)
        return {"chunks": chunks}

    return {"chunks": []}


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("CHAT_IDLE_LIMIT", "600"))
    while True:
        task = claim_retrieval_task(WORKER_ID)
        if not task:
            idle += 1
            if idle >= idle_limit:
                print("No chat retrieval tasks remaining. Exiting.")
                return
            time.sleep(0.5)
            continue
        idle = 0
        try:
            result = run_task(task)
            complete_retrieval_task(task["id"], result)
        except Exception as exc:
            fail_retrieval_task(task["id"], str(exc))
            time.sleep(0.2)


if __name__ == "__main__":
    worker_loop()
