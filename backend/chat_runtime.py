import os
import json
from typing import Any, Dict, List, Optional, Tuple

from env_bootstrap import load_env
from supabase import create_client

load_env()


def _get_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


SUPABASE_URL = _get_env("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = _get_env("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


_embedder = None


def _get_embedder():
    global _embedder
    if _embedder is not None:
        return _embedder
    from sentence_transformers import SentenceTransformer  # type: ignore

    model_id = os.getenv("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    device = os.getenv("EMBED_DEVICE", "").strip()
    if not device:
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    _embedder = SentenceTransformer(model_id, device=device)
    return _embedder


def embed_query(text: str) -> List[float]:
    emb = _get_embedder().encode([text], normalize_embeddings=True, show_progress_bar=False)
    # numpy -> list
    try:
        import numpy as np

        if isinstance(emb, np.ndarray):
            return emb[0].astype("float32").tolist()
    except Exception:
        pass
    return [float(x) for x in emb[0]]

def _keywords(q: str) -> List[str]:
    import re

    q = (q or "").strip().lower()
    toks = re.findall(r"[a-z0-9][a-z0-9_\-]{2,}", q)
    stop = {
        "the","and","for","with","from","that","this","what","when","where","which","who","how",
        "into","about","their","there","have","has","had","are","was","were","will","would","can",
        "could","should","may","might","also",
    }
    out: List[str] = []
    for t in toks:
        if t in stop:
            continue
        if len(t) <= 2:
            continue
        out.append(t)
    return out[:12]

def keyword_search_chunks(
    organization_id: str,
    library_ids: List[str],
    query_text: str,
    top_k: int = 8,
) -> List[Dict[str, Any]]:
    """
    Cheap lexical fallback (works even if the vector match RPC isn't installed).
    Not as strong as BM25/FTS, but saves us from hard failures.
    """
    library_ids = [str(x) for x in (library_ids or []) if str(x)]
    if not library_ids:
        return []

    kws = _keywords(query_text)
    if not kws:
        return []

    terms = kws[:4]
    # PostgREST OR expression
    or_expr = ",".join([f"text.ilike.*{t}*" for t in terms])

    results: List[Dict[str, Any]] = []
    limit = max(40, int(top_k) * 8)
    for lib_id in library_ids[:8]:
        try:
            res = (
                supabase.table("chunk_embeddings")
                .select("chunk_id,doc_id,library_id,page_start,page_end,text,embedding_text")
                .eq("organization_id", organization_id)
                .eq("library_id", lib_id)
                .or_(or_expr)
                .order("updated_at", desc=True)
                .limit(limit)
                .execute()
            )
        except Exception:
            continue
        for r in (res.data or []):
            if not isinstance(r, dict):
                continue
            results.append(
                {
                    "chunk_id": r.get("chunk_id"),
                    "doc_id": r.get("doc_id"),
                    "library_id": r.get("library_id"),
                    "page_start": r.get("page_start"),
                    "page_end": r.get("page_end"),
                    "text": r.get("text") or r.get("embedding_text"),
                    # Heuristic score so downstream can treat these as confident-enough sources.
                    "score": 0.2,
                }
            )
    return results[: max(1, int(top_k))]

def _cosine_topk_from_rows(query_vec: List[float], rows: List[Dict[str, Any]], k: int) -> List[Dict[str, Any]]:
    # Fallback when RPC isn't available: rows must include `embedding` as list[float].
    try:
        import numpy as np

        q = np.array(query_vec, dtype="float32")
        q = q / (np.linalg.norm(q) + 1e-9)
        mats = []
        keep = []
        for r in rows:
            v = r.get("embedding")
            if not isinstance(v, list) or not v:
                continue
            mats.append(np.array(v, dtype="float32"))
            keep.append(r)
        if not mats:
            return []
        M = np.vstack(mats)
        M = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)
        sims = (M @ q).reshape(-1)
        idx = np.argsort(-sims)[: max(1, int(k))]
        out = []
        for i in idx.tolist():
            r = dict(keep[i])
            r["score"] = float(sims[i])
            out.append(r)
        return out
    except Exception:
        return rows[:k]


def retrieve_chunks(
    organization_id: str,
    library_ids: List[str],
    query_vec: List[float],
    top_k: int = 8,
) -> List[Dict[str, Any]]:
    """
    Returns chunk rows with at least:
      chunk_id, doc_id, library_id, page_start, page_end, text, score
    Strategy:
      1) Try Supabase RPC `match_chunk_embeddings` if user created it.
      2) Fallback: pull a limited set of rows + compute cosine locally (OK for small libs).
    """
    library_ids = [str(x) for x in (library_ids or []) if str(x)]
    if not library_ids:
        return []

    rpc_name = os.getenv("CHAT_MATCH_RPC", "match_chunk_embeddings").strip() or "match_chunk_embeddings"
    try:
        resp = supabase.rpc(
            rpc_name,
            {
                "p_organization_id": organization_id,
                "p_library_ids": library_ids,
                "p_query_embedding": query_vec,
                "p_match_count": int(top_k),
            },
        ).execute()
        rows = resp.data or []
        # normalize shape
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            out.append(
                {
                    "chunk_id": r.get("chunk_id"),
                    "doc_id": r.get("doc_id"),
                    "library_id": r.get("library_id"),
                    "page_start": r.get("page_start"),
                    "page_end": r.get("page_end"),
                    "text": r.get("text") or r.get("embedding_text"),
                    "score": r.get("score") or r.get("similarity"),
                }
            )
        if str(os.getenv("CHAT_EXPAND_NEIGHBORS", "1")).strip() not in {"0", "false", "False"}:
            out = expand_neighbor_chunks(organization_id, library_ids, out)
        return out
    except Exception:
        # If RPC isn't installed (or pgvector can't serialize), fall back to keyword search.
        query_text = os.getenv("CHAT_LAST_QUERY_TEXT", "")  # optional hook
        if query_text:
            return keyword_search_chunks(organization_id, library_ids, query_text, top_k=top_k)
        return []


def expand_neighbor_chunks(
    organization_id: str,
    library_ids: List[str],
    rows: List[Dict[str, Any]],
    window: int = 1,
    max_add: int = 8,
) -> List[Dict[str, Any]]:
    """
    Expand retrieval with adjacent chunk_ids for the same doc when chunk_id follows:
      <doc_uuid>_cNNNN
    This gives the model neighboring context without an extra vector search.
    """
    if not rows or max_add <= 0:
        return rows

    import re as _re

    seen = {str(r.get("chunk_id") or "") for r in rows if str(r.get("chunk_id") or "")}
    want: List[str] = []

    for r in rows:
        cid = str(r.get("chunk_id") or "")
        if not cid:
            continue
        m = _re.match(r"^([0-9a-fA-F-]{32,})_c(\d{4})$", cid)
        if not m:
            continue
        prefix = m.group(1)
        idx = int(m.group(2))
        for d in range(1, window + 1):
            for n in (idx - d, idx + d):
                if n < 0:
                    continue
                ncid = f"{prefix}_c{n:04d}"
                if ncid in seen:
                    continue
                want.append(ncid)
                seen.add(ncid)
                if len(want) >= max_add:
                    break
            if len(want) >= max_add:
                break
        if len(want) >= max_add:
            break

    if not want:
        return rows

    try:
        res = (
            supabase.table("chunk_embeddings")
            .select("chunk_id, doc_id, library_id, page_start, page_end, text, embedding_text")
            .eq("organization_id", organization_id)
            .in_("library_id", library_ids)
            .in_("chunk_id", want)
            .execute()
        )
        extra = []
        for r in (res.data or []):
            if not isinstance(r, dict):
                continue
            extra.append(
                {
                    "chunk_id": r.get("chunk_id"),
                    "doc_id": r.get("doc_id"),
                    "library_id": r.get("library_id"),
                    "page_start": r.get("page_start"),
                    "page_end": r.get("page_end"),
                    "text": r.get("embedding_text") or r.get("text"),
                    "score": None,
                }
            )
        return rows + extra
    except Exception:
        return rows


def hydrate_doc_titles(doc_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    doc_ids = [str(x) for x in (doc_ids or []) if str(x)]
    if not doc_ids:
        return {}
    # Keep this compatible with our actual schema: documents has `path_in_source` + `gdrive_file_id`,
    # but not `source_path`.
    res = (
        supabase.table("documents")
        .select("id,title,storage_path_raw,path_in_source,gdrive_file_id")
        .in_("id", doc_ids)
        .execute()
    )
    out: Dict[str, Dict[str, Any]] = {}
    for r in (res.data or []):
        if not isinstance(r, dict):
            continue
        out[str(r.get("id"))] = {
            "doc_title": r.get("title"),
            "storage_path_raw": r.get("storage_path_raw"),
            "path_in_source": r.get("path_in_source"),
            "gdrive_file_id": r.get("gdrive_file_id"),
        }
    return out


def build_evidence_brief(rows: List[Dict[str, Any]], max_chars: int = 14000) -> str:
    """
    Compact evidence fed to GPT: keep it human-friendly (title + pages), and avoid leaking internal ids
    that might get copied into the final answer.
    """
    parts = []
    used = 0
    for r in rows:
        doc_title = str(r.get("doc_title") or "").strip()
        p1 = r.get("page_start")
        p2 = r.get("page_end")
        txt = (r.get("text") or "").strip()
        if not txt:
            continue
        title_part = f"{doc_title}" if doc_title else "Untitled PDF"
        header = f"[pdf={title_part} pages={p1}-{p2} score={r.get('score')}]"
        snippet = txt[:1200]
        block = f"{header}\n{snippet}"
        if used + len(block) + 2 > max_chars:
            break
        parts.append(block)
        used += len(block) + 2
    return "\n\n".join(parts)
