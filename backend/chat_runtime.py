import os
import json
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import boto3
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

# R2 (read-only here) — used to pull per-document visual manifests for inline answer figures.
_R2_BUCKET = os.getenv("R2_BUCKET") or ""
_s3 = boto3.client(
    "s3",
    endpoint_url=(os.getenv("R2_ENDPOINT") or None),
    aws_access_key_id=(os.getenv("R2_ACCESS_KEY") or None),
    aws_secret_access_key=(os.getenv("R2_SECRET_KEY") or None),
)


def fetch_r2_json(key: str) -> Optional[Dict[str, Any]]:
    """Best-effort read of a JSON object from R2 (returns None on any failure)."""
    if not key or not _R2_BUCKET:
        return None
    try:
        obj = _s3.get_object(Bucket=_R2_BUCKET, Key=key)
        return json.loads(obj["Body"].read())
    except Exception:
        return None


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


def _default_query_instruction() -> str:
    """Model-aware default. BGE-*-en-v1.5 use an asymmetric query instruction; BGE-M3 (and
    most newer models) are instruction-free for dense retrieval, so swapping EMBED_MODEL to
    bge-m3 needs no config. Override either way with CHAT_QUERY_INSTRUCTION."""
    model = (os.getenv("EMBED_MODEL", "BAAI/bge-large-en-v1.5") or "").lower()
    if "m3" in model:
        return ""
    if "bge" in model and "en" in model:
        return "Represent this sentence for searching relevant passages: "
    return ""


def embed_query(text: str) -> List[float]:
    # Passages are embedded raw (no instruction); the query may carry a retrieval instruction
    # for BGE-en models (asymmetric s2p). Auto-selected per model; override via env.
    instr = os.getenv("CHAT_QUERY_INSTRUCTION", _default_query_instruction())
    q = f"{instr}{text}" if instr else text
    emb = _get_embedder().encode([q], normalize_embeddings=True, show_progress_bar=False)
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
    organization_id: Optional[str],
    library_ids: List[str],
    query_text: str,
    top_k: int = 8,
    cross_org: bool = False,
) -> List[Dict[str, Any]]:
    """
    Level-1 lexical retrieval via Postgres full-text search (BM25-like ts_rank_cd over a
    GIN-indexed tsvector). Strong on exact terms, names, numbers, identifiers — the cases
    dense vectors miss. Falls back to the old ILIKE scan if the FTS RPC isn't installed yet,
    so deployments without docs/supabase-fts.sql keep working.
    """
    library_ids = [str(x) for x in (library_ids or []) if str(x)]
    if not library_ids or not (query_text or "").strip():
        return []

    rpc_name = os.getenv("CHAT_FTS_RPC", "keyword_search_chunks_fts").strip() or "keyword_search_chunks_fts"
    try:
        resp = supabase.rpc(
            rpc_name,
            {
                "p_library_ids": library_ids,
                "p_query": query_text,
                "p_match_count": max(20, int(top_k) * 4),
            },
        ).execute()
        rows = resp.data or []
        out: List[Dict[str, Any]] = []
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
                    "score": float(r.get("score") or 0.0),
                }
            )
        if out:
            return out
    except Exception:
        pass
    # Fallback: the previous ILIKE scan (used until the FTS migration is applied).
    return _keyword_search_ilike(organization_id, library_ids, query_text, top_k, cross_org)


def _keyword_search_ilike(
    organization_id: Optional[str],
    library_ids: List[str],
    query_text: str,
    top_k: int = 8,
    cross_org: bool = False,
) -> List[Dict[str, Any]]:
    """Legacy ILIKE lexical fallback. cross_org=True filters by library_id only."""
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
            q = (
                supabase.table("chunk_embeddings")
                .select("chunk_id,doc_id,library_id,page_start,page_end,text,embedding_text")
            )
            if not cross_org and organization_id:
                q = q.eq("organization_id", organization_id)
            res = (
                q.eq("library_id", lib_id)
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
    organization_id: Optional[str],
    library_ids: List[str],
    query_vec: List[float],
    top_k: int = 8,
    cross_org: bool = False,
) -> List[Dict[str, Any]]:
    """
    Returns chunk rows with at least:
      chunk_id, doc_id, library_id, page_start, page_end, text, score
    Strategy:
      1) Try Supabase RPC `match_chunk_embeddings` if user created it.
      2) Fallback: pull a limited set of rows + compute cosine locally (OK for small libs).

    cross_org=True (TEAM chat): use the by-libraries RPC so pooled libraries spanning members'
    organizations are all searched (org filter dropped; access authorized before the call).
    """
    library_ids = [str(x) for x in (library_ids or []) if str(x)]
    if not library_ids:
        return []

    try:
        if cross_org:
            rpc_name = os.getenv("CHAT_MATCH_RPC_BY_LIB", "match_chunk_embeddings_by_libraries").strip() \
                or "match_chunk_embeddings_by_libraries"
            params = {
                "p_library_ids": library_ids,
                "p_query_embedding": query_vec,
                "p_match_count": int(top_k),
            }
        else:
            rpc_name = os.getenv("CHAT_MATCH_RPC", "match_chunk_embeddings").strip() or "match_chunk_embeddings"
            params = {
                "p_organization_id": organization_id,
                "p_library_ids": library_ids,
                "p_query_embedding": query_vec,
                "p_match_count": int(top_k),
            }
        resp = supabase.rpc(rpc_name, params).execute()
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
            out = expand_neighbor_chunks(organization_id, library_ids, out, cross_org=cross_org)
        return out
    except Exception:
        # If RPC isn't installed (or pgvector can't serialize), fall back to keyword search.
        query_text = os.getenv("CHAT_LAST_QUERY_TEXT", "")  # optional hook
        if query_text:
            return keyword_search_chunks(organization_id, library_ids, query_text, top_k=top_k, cross_org=cross_org)
        return []


# ── Hybrid retrieval: RRF fusion + cross-encoder rerank ──────────────────────────────

def rrf_fuse(ranked_lists: List[List[Dict[str, Any]]], k: int = 60, top_k: Optional[int] = None) -> List[Dict[str, Any]]:
    """Reciprocal Rank Fusion of several ranked chunk lists (e.g. vector + keyword).
    score(d) = sum over lists of 1/(k + rank). Dedupes by chunk_id; keeps the first row seen."""
    scores: Dict[str, float] = {}
    best: Dict[str, Dict[str, Any]] = {}
    for lst in ranked_lists:
        for rank, row in enumerate(lst or []):
            cid = str(row.get("chunk_id") or "")
            if not cid:
                continue
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
            if cid not in best:
                best[cid] = row
    fused = sorted(best.values(), key=lambda r: scores.get(str(r.get("chunk_id")), 0.0), reverse=True)
    for r in fused:
        r["rrf_score"] = scores.get(str(r.get("chunk_id")), 0.0)
    return fused[: int(top_k)] if top_k else fused


_reranker = None


def _get_reranker():
    global _reranker
    if _reranker is not None:
        return _reranker
    from sentence_transformers import CrossEncoder  # type: ignore

    model_id = os.getenv("CHAT_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
    device = os.getenv("CHAT_RERANK_DEVICE", "").strip()
    if not device:
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    _reranker = CrossEncoder(model_id, device=device, max_length=512)
    return _reranker


def rerank_rows(query_text: str, rows: List[Dict[str, Any]], top_k: int) -> List[Dict[str, Any]]:
    """Cross-encoder rerank (bge-reranker-v2-m3) of candidate rows. Gated by CHAT_ENABLE_RERANK.
    Best-effort: on any failure (model missing, OOM) returns the input order truncated."""
    if not rows:
        return rows
    if str(os.getenv("CHAT_ENABLE_RERANK", "1")).strip() in {"0", "false", "False"}:
        return rows[: int(top_k)] if top_k else rows
    cand = rows[: int(os.getenv("CHAT_RERANK_CANDIDATES", "100"))]
    try:
        ce = _get_reranker()
        pairs = [(query_text, str(r.get("text") or "")[:1200]) for r in cand]
        scores = ce.predict(pairs, show_progress_bar=False)
        for r, s in zip(cand, scores):
            r["rerank_score"] = float(s)
        cand.sort(key=lambda r: r.get("rerank_score", 0.0), reverse=True)
        return cand[: int(top_k)] if top_k else cand
    except Exception:
        return rows[: int(top_k)] if top_k else rows


def hybrid_retrieve(
    organization_id: Optional[str],
    library_ids: List[str],
    query_text: str,
    query_vec: List[float],
    top_k: int = 8,
    cross_org: bool = False,
) -> List[Dict[str, Any]]:
    """Level-3 (vector) + Level-1 (FTS keyword) recall, fused with RRF, then cross-encoder
    reranked to the final top_k. The single entry point the chat orchestrator should call."""
    vec_k = max(int(top_k), int(os.getenv("CHAT_HYBRID_VEC_K", "40")))
    kw_k = max(int(top_k), int(os.getenv("CHAT_HYBRID_KW_K", "40")))
    vec = retrieve_chunks(organization_id, library_ids, query_vec, top_k=vec_k, cross_org=cross_org)
    kw = keyword_search_chunks(organization_id, library_ids, query_text, top_k=kw_k, cross_org=cross_org)
    fused = rrf_fuse([vec, kw], k=int(os.getenv("CHAT_RRF_K", "60")))
    if not fused:
        return (vec or kw)[: int(top_k)]
    return rerank_rows(query_text, fused, top_k=top_k)


def cluster_diversify(rows: List[Dict[str, Any]], top_k: int) -> List[Dict[str, Any]]:
    """Level-2 SOFT cluster routing: reorder rows to span topic clusters (round-robin across
    cluster_id, preserving each cluster's internal relevance order). Improves coverage for
    comprehensive/aggregation/comparison queries without the recall loss of hard cluster filtering.
    Best-effort — returns the input truncated if clustering hasn't run or on any failure."""
    if not rows or (top_k and len(rows) <= top_k and top_k <= 1):
        return rows
    ids = [str(r.get("chunk_id")) for r in rows if r.get("chunk_id")]
    if not ids:
        return rows[: int(top_k)] if top_k else rows
    cmap: Dict[str, Any] = {}
    try:
        resp = supabase.table("chunk_embeddings").select("chunk_id, cluster_id").in_("chunk_id", ids[:500]).execute()
        for r in resp.data or []:
            cmap[str(r.get("chunk_id"))] = r.get("cluster_id")
    except Exception:
        return rows[: int(top_k)] if top_k else rows
    if not any(v is not None for v in cmap.values()):
        return rows[: int(top_k)] if top_k else rows  # clustering not available
    from collections import OrderedDict

    buckets: "OrderedDict[Any, List[Dict[str, Any]]]" = OrderedDict()
    for r in rows:
        c = cmap.get(str(r.get("chunk_id")))
        buckets.setdefault(c if c is not None else "_none", []).append(r)
    out: List[Dict[str, Any]] = []
    limit = int(top_k) if top_k else len(rows)
    while len(out) < limit and any(buckets.values()):
        for c in list(buckets.keys()):
            if buckets[c]:
                out.append(buckets[c].pop(0))
                if len(out) >= limit:
                    break
    return out


def expand_neighbor_chunks(
    organization_id: Optional[str],
    library_ids: List[str],
    rows: List[Dict[str, Any]],
    window: int = 1,
    max_add: int = 8,
    cross_org: bool = False,
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
        q = (
            supabase.table("chunk_embeddings")
            .select("chunk_id, doc_id, library_id, page_start, page_end, text, embedding_text")
        )
        if not cross_org and organization_id:
            q = q.eq("organization_id", organization_id)
        res = q.in_("library_id", library_ids).in_("chunk_id", want).execute()
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


def build_context_document(notes: List[Dict[str, Any]], max_chars: int = 14000) -> str:
    """
    Build the *consolidated context document* fed to the Synthesizer.

    Unlike build_evidence_brief (which dumps raw chunk text), this takes the distilled
    notes produced by the Extractor agent (chat_agents.extract_notes) and renders them as
    short, source-anchored bullet points grouped by the sub-question they answer. This is the
    "extract-then-consolidate" novelty: GPT sees compact, attributed evidence rather than
    long raw passages, which reduces lost-in-the-middle errors and makes citations precise.

    Each note dict is expected to carry: text, doc_title, page_start, page_end, and optionally
    sub_query and visual_ids. Falls back gracefully if fields are missing.
    """
    if not notes:
        return ""

    # Group notes by the sub-question they were extracted for (preserve first-seen order).
    groups: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
    for n in notes:
        sq = str(n.get("sub_query") or "").strip() or "Main question"
        groups.setdefault(sq, []).append(n)

    lines: List[str] = ["CONTEXT DOCUMENT (distilled, source-anchored evidence):"]
    used = len(lines[0])
    for sq, items in groups.items():
        header = f"\n## {sq}"
        if used + len(header) > max_chars:
            break
        lines.append(header)
        used += len(header)
        for n in items:
            text = str(n.get("text") or "").strip()
            if not text:
                continue
            title = str(n.get("doc_title") or "").strip() or "Untitled PDF"
            p1 = n.get("page_start")
            p2 = n.get("page_end")
            vis = n.get("visual_ids")
            vis_tag = ""
            if isinstance(vis, list) and vis:
                vis_tag = f", {len(vis)} figure/table"
            block = f"- {text}\n  (source: {title}, p.{p1}-{p2}{vis_tag})"
            if used + len(block) + 1 > max_chars:
                break
            lines.append(block)
            used += len(block) + 1
    return "\n".join(lines)


def fetch_chunk_snippets(chunk_ids: List[str], edge_chars: int = 220) -> Dict[str, Dict[str, str]]:
    """
    For each chunk_id ("<doc_id>_cNNNN"), return the chunk's own VERBATIM text plus a short edge of
    the previous/next chunk — so the UI can show the exact cited passage with a line or two of
    surrounding context, and highlight that passage inside the PDF.

    Returns {chunk_id: {"text": ..., "before": ..., "after": ...}}. Best-effort; missing pieces
    come back as empty strings. One batched query for the chunks and all their neighbours.
    """
    ids = [str(c) for c in (chunk_ids or []) if str(c or "")]
    if not ids:
        return {}

    import re as _re

    out: Dict[str, Dict[str, str]] = {c: {"text": "", "before": "", "after": ""} for c in ids}
    neighbor_map: Dict[str, List[Tuple[str, str]]] = {}
    fetch_ids = set(ids)
    for cid in ids:
        m = _re.match(r"^(.*)_c(\d+)$", cid)
        if not m:
            continue
        base, num_s = m.group(1), m.group(2)
        width = len(num_s)
        num = int(num_s)
        if num - 1 >= 0:
            pid = f"{base}_c{str(num - 1).zfill(width)}"
            neighbor_map.setdefault(pid, []).append((cid, "before"))
            fetch_ids.add(pid)
        nid = f"{base}_c{str(num + 1).zfill(width)}"
        neighbor_map.setdefault(nid, []).append((cid, "after"))
        fetch_ids.add(nid)

    try:
        res = (
            supabase.table("chunk_embeddings")
            .select("chunk_id,text")
            .in_("chunk_id", list(fetch_ids))
            .execute()
        )
    except Exception:
        return out

    by_id: Dict[str, str] = {}
    for r in (res.data or []):
        if isinstance(r, dict):
            by_id[str(r.get("chunk_id"))] = (r.get("text") or "").strip()

    for cid in ids:
        if cid in by_id:
            out[cid]["text"] = by_id[cid]
    for nid, targets in neighbor_map.items():
        txt = by_id.get(nid, "")
        if not txt:
            continue
        for (src_cid, pos) in targets:
            if pos == "before":
                out[src_cid]["before"] = txt[-edge_chars:]
            else:
                out[src_cid]["after"] = txt[:edge_chars]
    return out


def _visual_caption(block: Dict[str, Any]) -> str:
    """Pull a short human caption for a visual from its manifest block."""
    if not isinstance(block, dict):
        return ""
    s = block.get("summary") if isinstance(block.get("summary"), dict) else {}
    short = str((s or {}).get("short_caption") or "").strip()
    if short:
        return short[:300]
    ct = str(block.get("caption_text") or "").strip()
    if ct:
        return ct[:300]
    bullets = (s or {}).get("bullets") or []
    if isinstance(bullets, list) and bullets:
        return str(bullets[0]).strip()[:300]
    kind = str(block.get("kind") or block.get("type") or "figure").title()
    pg = block.get("page")
    return f"{kind}{f' (page {pg})' if pg is not None else ''}"


def fetch_chunk_visuals(chunk_ids: List[str], max_visuals: int = 12) -> List[Dict[str, Any]]:
    """
    For the given chunks, return the figures/tables/charts attached to them — each with its R2
    image key, a human caption (from the per-document visuals manifest), page, and source doc.
    Used to offer the synthesizer relevant visuals it can embed inline in the answer.

    Returns a deduped, ordered list of:
      {visual_id, visual_key, caption, page, kind, doc_id, doc_title}
    """
    ids = [str(c) for c in (chunk_ids or []) if str(c or "")]
    if not ids:
        return []

    try:
        res = (
            supabase.table("chunk_embeddings")
            .select("chunk_id,organization_id,library_id,doc_id,visual_ids,visual_keys")
            .in_("chunk_id", ids)
            .execute()
        )
    except Exception:
        return []

    visuals: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
    docs: Dict[str, Tuple[str, str]] = {}
    for r in (res.data or []):
        if not isinstance(r, dict):
            continue
        org = str(r.get("organization_id") or "")
        lib = str(r.get("library_id") or "")
        doc = str(r.get("doc_id") or "")
        vids = r.get("visual_ids") or []
        vkeys = r.get("visual_keys") or []
        for i, vid in enumerate(vids):
            vid = str(vid or "")
            if not vid or vid in visuals:
                continue
            key = vkeys[i] if i < len(vkeys) else None
            visuals[vid] = {
                "visual_id": vid,
                "visual_key": key,
                "doc_id": doc,
                "caption": "",
                "page": None,
                "kind": None,
            }
            if doc:
                docs[doc] = (org, lib)

    if not visuals:
        return []

    # Read each document's visuals manifest once to resolve captions/pages.
    manifests: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for doc, (org, lib) in docs.items():
        man = fetch_r2_json(f"visuals_manifest/{org}/{lib}/{doc}.json") or {}
        blocks: Dict[str, Dict[str, Any]] = {}
        for b in (man.get("blocks") or []):
            if isinstance(b, dict) and b.get("block_id"):
                blocks[str(b.get("block_id"))] = b
        manifests[doc] = blocks

    titles = hydrate_doc_titles(list(docs.keys()))

    out: List[Dict[str, Any]] = []
    for vid, v in visuals.items():
        block = manifests.get(v["doc_id"], {}).get(vid) or {}
        if not v.get("visual_key"):
            v["visual_key"] = block.get("visual_key")
        if not v.get("visual_key"):
            continue  # no image to show
        v["caption"] = _visual_caption(block)
        v["page"] = block.get("page")
        v["kind"] = block.get("kind") or block.get("type") or "figure"
        v["doc_title"] = (titles.get(v["doc_id"]) or {}).get("doc_title")
        out.append(v)
        if len(out) >= max_visuals:
            break
    return out
