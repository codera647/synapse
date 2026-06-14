import json
import os
import random
import time
from datetime import datetime, timezone

from env_bootstrap import load_env
from supabase import create_client
import boto3


load_env()

WORKER_ID = os.getenv("WORKER_ID", "chunk-1")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


SUPABASE_URL = get_env("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = get_env("SUPABASE_SERVICE_ROLE_KEY")

R2_ENDPOINT = get_env("R2_ENDPOINT")
R2_BUCKET = get_env("R2_BUCKET")
# Optional on AWS if using an Instance Role (recommended).
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY") or ""
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY") or ""

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT or None,
    aws_access_key_id=R2_ACCESS_KEY or None,
    aws_secret_access_key=R2_SECRET_KEY or None,
)


def _pipeline_stages():
    import pipeline_config
    return pipeline_config.pipeline_stages()


def _stage_order(stage: str) -> int:
    stages = _pipeline_stages()
    try:
        return stages.index(stage)
    except ValueError:
        return 10_000


def _is_retryable_supabase_error(exc: Exception) -> bool:
    msg = str(exc) or ""
    m = msg.lower()
    if "json could not be generated" in m:
        return True
    if "bad gateway" in m or "error code 502" in m or " 502" in m:
        return True
    if "web server is down" in m or "error code 521" in m or " 521" in m:
        return True
    if "timeout" in m or "timed out" in m:
        return True
    if "too many requests" in m or " 429" in m:
        return True
    return False


def _sb_execute(query, context: str = "", max_attempts: int | None = None):
    attempts = int(os.getenv("SUPABASE_MAX_RETRIES", "6")) if max_attempts is None else int(max_attempts)
    base = float(os.getenv("SUPABASE_RETRY_BASE_SECONDS", "0.6"))
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return query.execute()
        except Exception as exc:
            last_exc = exc
            if not _is_retryable_supabase_error(exc) or i == attempts - 1:
                raise
            sleep_s = min(20.0, base * (2**i)) * (0.85 + random.random() * 0.3)
            print(f"[supabase-retry] {context or 'query'} attempt={i+1}/{attempts} sleep={sleep_s:.2f}s err={exc}")
            time.sleep(sleep_s)
    if last_exc:
        raise last_exc


_PIPELINE_ABORT_STATUSES = {"canceled", "failed"}


def _get_library_pipeline_status(library_id: str) -> str | None:
    res = _sb_execute(
        supabase.table("libraries").select("pipeline_status").eq("id", library_id).single(),
        context="libraries.select(pipeline_status)",
    )
    if not res.data:
        return None
    return (res.data.get("pipeline_status") or "").lower() or None


def _mark_stage_job_canceled(job_id: str, reason: str):
    _sb_execute(
        supabase.table("batch_stage_jobs")
        .update({"status": "canceled", "last_error": reason, "finished_at": now_iso()})
        .eq("id", job_id)
        .eq("status", "running"),
        context="batch_stage_jobs.update(canceled)",
    )


def _cancel_queued_stage_jobs_for_library(library_id: str, reason: str, exclude_job_id: str | None = None):
    q = (
        supabase.table("batch_stage_jobs")
        .update({"status": "canceled", "last_error": reason, "finished_at": now_iso()})
        .eq("library_id", library_id)
        .eq("status", "queued")
    )
    if exclude_job_id:
        q = q.neq("id", exclude_job_id)
    _sb_execute(q, context="batch_stage_jobs.update(cancel_queued_for_library)")


def fetch_r2_bytes(key: str) -> bytes:
    obj = s3.get_object(Bucket=R2_BUCKET, Key=key)
    return obj["Body"].read()


def fetch_r2_json(key: str) -> dict | None:
    try:
        raw = fetch_r2_bytes(key)
    except Exception:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def put_r2_json(key: str, payload: dict):
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
    )


def _ensure_stage_job_exists(
    org_id: str,
    library_id: str,
    batch_id: str,
    stage: str,
    progress_total: int,
):
    existing = _sb_execute(
        supabase.table("batch_stage_jobs").select("id").eq("batch_id", batch_id).eq("stage", stage).limit(1),
        context=f"batch_stage_jobs.select(exists:{stage})",
    )
    if existing.data:
        return
    _sb_execute(
        supabase.table("batch_stage_jobs").insert(
            {
                "organization_id": org_id,
                "library_id": library_id,
                "batch_id": batch_id,
                "stage": stage,
                "status": "queued",
                "attempts": 0,
                "payload": {},
                "progress_current": 0,
                "progress_total": int(progress_total or 0),
            }
        ),
        context=f"batch_stage_jobs.insert({stage})",
    )


def _count_done_stage_jobs(library_id: str, stage: str) -> int:
    resp = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("id", count="exact")
        .eq("library_id", library_id)
        .eq("stage", stage)
        .eq("status", "done"),
        context=f"batch_stage_jobs.count(done:{stage})",
    )
    return int(resp.count or 0)


def _compute_next_stage(library_id: str) -> str:
    # Earliest stage with any remaining work.
    remaining = _sb_execute(
        supabase.table("batch_stage_jobs").select("stage, status").eq("library_id", library_id).neq("status", "done"),
        context="batch_stage_jobs.select(remaining)",
    )
    stages = [str(r.get("stage") or "") for r in (remaining.data or []) if isinstance(r, dict)]
    stages = [s for s in stages if s]
    if not stages:
        return _pipeline_stages()[-1]
    stages.sort(key=_stage_order)
    return stages[0]


def _update_library_progress(library_id: str, stage: str):
    lib = _sb_execute(
        supabase.table("libraries").select("total_batches").eq("id", library_id).single(),
        context="libraries.select(total_batches)",
    )
    total_batches = int((lib.data or {}).get("total_batches") or 0)
    if total_batches <= 0:
        return

    stages = _pipeline_stages()
    done_total = 0
    for st in stages:
        done_total += _count_done_stage_jobs(library_id, st)

    denom = max(1, total_batches * len(stages))
    progress = round((done_total / denom) * 100, 2)
    # `completed_batches` represents fully-processed batches (i.e. reached the last stage),
    # not "batches completed in the current stage".
    completed_batches = _count_done_stage_jobs(library_id, _pipeline_stages()[-1])
    next_stage = _compute_next_stage(library_id)

    _sb_execute(
        supabase.table("libraries").update(
            {
                "pipeline_status": "running",
                "pipeline_stage": next_stage,
                "completed_batches": completed_batches,
                "pipeline_progress_percent": progress,
            }
        ).eq("id", library_id),
        context="libraries.update(progress)",
    )


def _maybe_finalize_pipeline(library_id: str):
    lib = _sb_execute(
        supabase.table("libraries").select("total_batches").eq("id", library_id).single(),
        context="libraries.select(total_batches.finalize)",
    )
    total_batches = int((lib.data or {}).get("total_batches") or 0)
    if total_batches <= 0:
        return

    stages = _pipeline_stages()
    for st in stages:
        if _count_done_stage_jobs(library_id, st) < total_batches:
            return

    finished = now_iso()
    _sb_execute(
        supabase.table("libraries").update(
            {
                "status": "ready",
                "pipeline_status": "completed",
                "pipeline_stage": stages[-1],
                "pipeline_progress_percent": 100,
                "pipeline_error": None,
                "pipeline_finished_at": finished,
                "completed_batches": total_batches,
            }
        ).eq("id", library_id),
        context="libraries.update(pipeline.completed)",
    )


def claim_chunk_stage_job(worker_id: str):
    # Gate claiming: chunking should only run after BOTH text_extraction and image_captioning are done for the batch.
    jobs = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "chunking")
        .eq("status", "queued")
        .order("created_at")
        .limit(int(os.getenv("CLAIM_SCAN_LIMIT", "25"))),
        context="batch_stage_jobs.select(chunking.queued)",
    )
    rows = jobs.data or []
    if not rows:
        return None

    batch_ids = [r.get("batch_id") for r in rows if r.get("batch_id")]
    if not batch_ids:
        return None

    done_text = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("batch_id")
        .in_("batch_id", batch_ids)
        .eq("stage", "text_extraction")
        .eq("status", "done"),
        context="batch_stage_jobs.select(text_extraction.done.for_chunking)",
    )
    done_caption = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("batch_id")
        .in_("batch_id", batch_ids)
        .eq("stage", "image_captioning")
        .eq("status", "done"),
        context="batch_stage_jobs.select(image_captioning.done.for_chunking)",
    )
    text_batches = {str(r.get("batch_id")) for r in (done_text.data or []) if r.get("batch_id")}
    caption_batches = {str(r.get("batch_id")) for r in (done_caption.data or []) if r.get("batch_id")}
    ready_batches = text_batches.intersection(caption_batches)

    job = None
    for r in rows:
        bid = str(r.get("batch_id") or "")
        if bid and bid in ready_batches:
            job = r
            break
    if not job:
        return None

    claimed = _sb_execute(
        supabase.table("batch_stage_jobs")
        .update(
            {
                "status": "running",
                "assigned_worker": worker_id,
                "started_at": now_iso(),
                "attempts": int(job.get("attempts") or 0) + 1,
            }
        )
        .eq("id", job["id"])
        .eq("status", "queued"),
        context="batch_stage_jobs.update(chunking.claim)",
    )
    if not claimed.data:
        return None
    return claimed.data[0]


def _visual_snippet(block: dict) -> str:
    s = block.get("summary") or {}
    short = (s.get("short_caption") or "").strip()
    bullets = s.get("bullets") or []
    ocr = (block.get("ocr_text") or "").strip()
    table_csv_key = block.get("table_csv_key")
    parts = []
    if short:
        parts.append(f"[VISUAL] {short}")
    for b in bullets[:4]:
        b = str(b).strip()
        if b:
            parts.append(f"- {b}")
    if ocr:
        parts.append("OCR: " + ocr[:400])
    if table_csv_key:
        parts.append(f"(table_csv_key: {table_csv_key})")
    return "\n".join(parts).strip()


def _clean_text(s: str) -> str:
    s = (s or "").replace("\x00", " ").strip()
    return " ".join(s.split())


def _approx_tokens(text: str) -> int:
    # Cheap heuristic to keep chunk sizes bounded without a tokenizer.
    return max(1, int(len(text) / 4))


def _is_heading_like(text: str) -> bool:
    t = _clean_text(text)
    if not t:
        return False
    if len(t) > int(os.getenv("CHUNK_HEADING_MAX_CHARS", "90")):
        return False
    # Section-style headings are often short and do not end with a period.
    if t.endswith(".") and len(t) > 25:
        return False
    # All-caps or Title: patterns.
    if t.upper() == t and any(ch.isalpha() for ch in t) and len(t) <= 60:
        return True
    if t.endswith(":") and len(t) <= 70:
        return True
    # Title-ish: few words, mostly alphabetic.
    words = t.split()
    if 1 <= len(words) <= 8 and sum(w[:1].isalpha() for w in words) >= max(1, len(words) - 1):
        # Avoid false positives like "Table 3" / "Figure 2" (handled as visuals elsewhere).
        low = t.lower()
        if low.startswith("table ") or low.startswith("figure ") or low.startswith("fig "):
            return False
        return True
    return False


def _bbox_sort_key(block: dict) -> tuple:
    # Prefer bbox_img y/x ordering if present to approximate reading order.
    bb = block.get("bbox_img") or None
    if not bb or not isinstance(bb, (list, tuple)) or len(bb) != 4:
        return (int(block.get("page") or 0), 1_000_000, 1_000_000)
    try:
        x1, y1, _x2, _y2 = [float(v) for v in bb]
    except Exception:
        return (int(block.get("page") or 0), 1_000_000, 1_000_000)
    return (int(block.get("page") or 0), y1, x1)


def _make_context_prefix(
    doc_title: str | None,
    section_heading: str | None,
    page_start: int | None,
    page_end: int | None,
) -> str:
    parts = []
    if doc_title:
        parts.append(f"Document: {doc_title}")
    if section_heading:
        parts.append(f"Section: {section_heading}")
    if page_start is not None and page_end is not None:
        if page_start == page_end:
            parts.append(f"Pages: {page_start + 1}")
        else:
            parts.append(f"Pages: {page_start + 1}-{page_end + 1}")
    return " | ".join(parts).strip()


def _contextual_enabled() -> bool:
    return str(os.getenv("CHUNK_CONTEXTUAL", "0")).strip().lower() in {"1", "true", "yes", "on"}


def _contextualize_chunk(doc_anchor: str, chunk_text: str) -> str:
    """Contextual Retrieval (Anthropic): a short situating sentence prepended to the chunk
    before embedding — markedly reduces failed retrievals. Gated by CHUNK_CONTEXTUAL (opt-in:
    one LLM call per chunk at ingest). Best-effort — returns "" on any failure."""
    if not _contextual_enabled():
        return ""
    chunk_text = (chunk_text or "").strip()
    if not chunk_text:
        return ""
    try:
        from openai import OpenAI

        client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        model = os.getenv("CHUNK_CONTEXT_MODEL") or os.getenv("CHAT_GPT_MODEL", "gpt-4o-mini")
        prompt = (
            "<document>\n" + (doc_anchor or "")[:4000] + "\n</document>\n"
            "<chunk>\n" + chunk_text[:2000] + "\n</chunk>\n"
            "Give a short, single-sentence context that situates this chunk within the document "
            "to improve search retrieval. Answer with ONLY the sentence."
        )
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=80,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception:
        return ""


def _semantic_boundaries(block_texts: list[str]) -> set[int]:
    """
    Optional semantic boundary detection using a small embedding model.
    Returns a set of indices i where a new chunk should start (before i).
    Uses GPU if available.
    """
    if os.getenv("CHUNK_SEMANTIC", "0") not in {"1", "true", "yes", "on"}:
        return set()
    try:
        import torch
        from transformers import AutoTokenizer, AutoModel  # type: ignore
    except Exception:
        return set()

    model_id = os.getenv("CHUNK_SEMANTIC_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    batch = int(os.getenv("CHUNK_SEMANTIC_BATCH", "32"))
    thr = float(os.getenv("CHUNK_SEMANTIC_THRESHOLD", "0.25"))  # lower sim -> boundary
    try:
        tok = AutoTokenizer.from_pretrained(model_id)
        mdl = AutoModel.from_pretrained(model_id)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        mdl.to(device)
        mdl.eval()

        def embed(texts: list[str]):
            outs = []
            for i in range(0, len(texts), batch):
                chunk = texts[i : i + batch]
                inp = tok(chunk, padding=True, truncation=True, max_length=256, return_tensors="pt")
                inp = {k: v.to(device) for k, v in inp.items()}
                with torch.no_grad():
                    o = mdl(**inp).last_hidden_state
                    mask = inp["attention_mask"].unsqueeze(-1)
                    pooled = (o * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
                    pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
                    outs.append(pooled.detach().cpu())
            return torch.cat(outs, dim=0)

        vecs = embed([t[:2000] for t in block_texts])
        boundaries: set[int] = set()
        for i in range(1, vecs.shape[0]):
            sim = float((vecs[i - 1] * vecs[i]).sum().item())
            if sim < thr:
                boundaries.add(i)
        return boundaries
    except Exception:
        return set()


def run_chunk_stage_job(stage_job):
    library_id = stage_job["library_id"]
    org_id = stage_job["organization_id"]
    batch_id = stage_job["batch_id"]
    job_id = stage_job["id"]

    # Stop early if canceled/deleted.
    st = _get_library_pipeline_status(library_id)
    if st is None or st in _PIPELINE_ABORT_STATUSES:
        _mark_stage_job_canceled(job_id, f"Aborted (library pipeline_status={st or 'missing'}).")
        return

    batch = _sb_execute(
        supabase.table("library_batches").select("doc_ids, doc_count").eq("id", batch_id).single(),
        context="library_batches.select(doc_ids)",
    )
    doc_ids = (batch.data or {}).get("doc_ids") or []
    total = int(stage_job.get("progress_total") or (batch.data or {}).get("doc_count") or len(doc_ids) or 0)
    current = int(stage_job.get("progress_current") or 0)
    progress_every = int(os.getenv("STAGE_PROGRESS_EVERY", "3"))

    try:
        # Fetch doc titles once (helps contextual retrieval without extra LLM calls).
        docs_by_id: dict[str, dict] = {}
        fetch_chunk = int(os.getenv("DOC_FETCH_CHUNK", "100"))
        for i in range(0, len(doc_ids), fetch_chunk):
            chunk = doc_ids[i : i + fetch_chunk]
            resp = _sb_execute(
                supabase.table("documents").select("id, title").in_("id", chunk),
                context="documents.select(titles)",
            )
            for d in resp.data or []:
                docs_by_id[str(d.get("id"))] = d

        for doc_id in doc_ids:
            st = _get_library_pipeline_status(library_id)
            if st is None or st in _PIPELINE_ABORT_STATUSES:
                _mark_stage_job_canceled(job_id, f"Aborted mid-batch (library pipeline_status={st or 'missing'}).")
                return

            text_key = f"text/{org_id}/{library_id}/{doc_id}.json"
            vis_key = f"visuals_manifest/{org_id}/{library_id}/{doc_id}.json"
            text_doc = fetch_r2_json(text_key) or {}
            vis_doc = fetch_r2_json(vis_key) or {}

            # Build a mapping from text block_id -> attached visual snippets (multi-attach).
            attach: dict[str, list[dict]] = {}
            for vb in (vis_doc.get("blocks") or []):
                if not isinstance(vb, dict):
                    continue
                snippet = _visual_snippet(vb)
                if not snippet:
                    continue
                vid = str(vb.get("block_id") or "")
                vkey = vb.get("visual_key")
                rel = vb.get("related_text_blocks") or []
                rel_ids: list[str] = []
                if isinstance(rel, list):
                    for item in rel:
                        if isinstance(item, dict) and item.get("block_id"):
                            rel_ids.append(str(item.get("block_id")))
                        elif isinstance(item, str):
                            rel_ids.append(item)
                rel_ids = [r for r in rel_ids if r]
                if not rel_ids:
                    continue
                for tid in rel_ids[: int(os.getenv("CHUNK_MAX_VISUAL_ATTACHMENTS", "3"))]:
                    attach.setdefault(str(tid), []).append(
                        {
                            "visual_block_id": vid,
                            "visual_key": vkey,
                            "snippet": snippet,
                        }
                    )

            # Flatten all text blocks in approximate reading order.
            flat_blocks: list[dict] = []
            for p in (text_doc.get("pages") or []):
                page_idx = int(p.get("page") or 0)
                blocks = [b for b in (p.get("blocks") or []) if isinstance(b, dict) and (b.get("kind") or "") == "text"]
                blocks.sort(key=_bbox_sort_key)
                for b in blocks:
                    txt = (b.get("text") or "").strip()
                    if not txt:
                        continue
                    flat_blocks.append(
                        {
                            "page": page_idx,
                            "block_id": str(b.get("block_id") or ""),
                            "text": txt,
                            "bbox_img": b.get("bbox_img"),
                        }
                    )

            # Optional semantic boundaries (GPU-accelerated if available).
            sem_boundaries = _semantic_boundaries([b["text"] for b in flat_blocks])

            # Chunking params (structure-based, with size budget + optional overlap).
            target_tokens = int(os.getenv("CHUNK_TARGET_TOKENS", "400"))
            max_tokens = int(os.getenv("CHUNK_MAX_TOKENS", "650"))
            min_tokens = int(os.getenv("CHUNK_MIN_TOKENS", "120"))
            overlap_blocks = int(os.getenv("CHUNK_OVERLAP_BLOCKS", "1"))
            if overlap_blocks < 0:
                overlap_blocks = 0

            doc_title = _clean_text(str((docs_by_id.get(str(doc_id)) or {}).get("title") or "")) or None

            # Document anchor for Contextual Retrieval (leading text of the doc), computed once.
            doc_context_anchor = ""
            if _contextual_enabled():
                _lead = " ".join((b.get("text") or "") for b in flat_blocks[:40])
                doc_context_anchor = ((doc_title + "\n") if doc_title else "") + _lead[:3500]

            chunks: list[dict] = []
            cur_blocks: list[dict] = []
            cur_heading: str | None = None
            cur_section: str | None = None
            cur_visuals: dict[str, dict] = {}  # visual_block_id -> visual rec

            def flush_chunk(force: bool = False):
                nonlocal cur_blocks, cur_heading, cur_visuals
                if not cur_blocks:
                    return
                text = "\n\n".join(_clean_text(b["text"]) for b in cur_blocks).strip()
                if not text:
                    cur_blocks = []
                    cur_visuals = {}
                    return
                tok = _approx_tokens(text)
                if not force and tok < min_tokens:
                    return

                page_start = int(cur_blocks[0]["page"])
                page_end = int(cur_blocks[-1]["page"])
                block_ids = [b["block_id"] for b in cur_blocks if b.get("block_id")]

                # Collect visuals attached to any block in this chunk (deduped).
                vis_snips: list[str] = []
                vis_ids: list[str] = []
                vis_keys: list[str] = []
                for bid in block_ids:
                    for vr in attach.get(bid) or []:
                        vbid = str(vr.get("visual_block_id") or "")
                        if not vbid or vbid in cur_visuals:
                            continue
                        cur_visuals[vbid] = vr
                for vbid, vr in cur_visuals.items():
                    vis_ids.append(vbid)
                    if vr.get("visual_key"):
                        vis_keys.append(str(vr.get("visual_key")))
                    sn = str(vr.get("snippet") or "").strip()
                    if sn:
                        vis_snips.append(sn)

                context_prefix = _make_context_prefix(doc_title, cur_heading or cur_section, page_start, page_end)
                # Contextual Retrieval: prepend an LLM-generated situating sentence (opt-in).
                _llm_ctx = _contextualize_chunk(doc_context_anchor, text)
                if _llm_ctx:
                    context_prefix = (_llm_ctx + " | " + context_prefix) if context_prefix else _llm_ctx
                embedding_text = context_prefix
                if embedding_text:
                    embedding_text += "\n\n"
                embedding_text += text
                if vis_snips:
                    embedding_text += "\n\n" + "\n\n".join(vis_snips[: int(os.getenv("CHUNK_MAX_VISUAL_SNIPPETS", "6"))])

                chunk_index = len(chunks)
                chunk_id = f"{doc_id}_c{chunk_index:04d}"
                chunks.append(
                    {
                        "chunk_id": chunk_id,
                        "chunk_index": chunk_index,
                        "doc_id": doc_id,
                        "library_id": library_id,
                        "organization_id": org_id,
                        "page_start": page_start,
                        "page_end": page_end,
                        "section_heading": cur_heading or cur_section,
                        "locator": (cur_blocks[0].get("locator") if cur_blocks else None),
                        "block_ids": block_ids,
                        "text": text,
                        "context_prefix": context_prefix,
                        "embedding_text": embedding_text,
                        "visual_ids": vis_ids,
                        "visual_keys": vis_keys,
                        "visual_snippets": vis_snips[: int(os.getenv("CHUNK_MAX_VISUAL_SNIPPETS", "6"))],
                    }
                )

                # Prepare overlap for next chunk.
                if overlap_blocks > 0:
                    cur_blocks = cur_blocks[-overlap_blocks:]
                else:
                    cur_blocks = []
                cur_visuals = {}

            for i, b in enumerate(flat_blocks):
                txt = _clean_text(b["text"])
                if not txt:
                    continue

                # Format parsers (code functions / spreadsheet row-groups) mark hard chunk
                # boundaries — one self-contained chunk per block, no cross-boundary overlap.
                if b.get("force_chunk"):
                    if cur_blocks:
                        flush_chunk(force=True)
                        cur_blocks = []
                    if b.get("section_heading"):
                        cur_heading = b.get("section_heading")
                    cur_blocks = [b]
                    flush_chunk(force=True)
                    cur_blocks = []
                    continue

                # Update section heading state when we see a heading-like block.
                if _is_heading_like(txt):
                    cur_section = txt
                    # If current chunk has enough content, flush before starting new section.
                    if cur_blocks and _approx_tokens("\n\n".join(bb["text"] for bb in cur_blocks)) >= min_tokens:
                        flush_chunk(force=True)
                    cur_heading = txt
                    continue

                # Semantic boundary hint: start new chunk before this block.
                if i in sem_boundaries and cur_blocks:
                    flush_chunk(force=True)

                cur_blocks.append(b)
                cur_tok = _approx_tokens("\n\n".join(bb["text"] for bb in cur_blocks))
                if cur_tok >= max_tokens:
                    flush_chunk(force=True)
                elif cur_tok >= target_tokens:
                    # Soft flush: wait for a natural boundary (heading/semantic/page break),
                    # but don't exceed max_tokens.
                    next_txt = ""
                    next_page = None
                    if i + 1 < len(flat_blocks):
                        next_txt = _clean_text(str(flat_blocks[i + 1].get("text") or ""))
                        next_page = int(flat_blocks[i + 1].get("page") or 0)
                    boundary = False
                    if next_txt and _is_heading_like(next_txt):
                        boundary = True
                    if (i + 1) in sem_boundaries:
                        boundary = True
                    if next_page is not None and next_page != int(b.get("page") or 0):
                        boundary = True
                    if boundary:
                        flush_chunk(force=True)

            flush_chunk(force=True)

            # Add neighbor pointers to support query-time expansion.
            for idx, ch in enumerate(chunks):
                ch["prev_chunk_id"] = chunks[idx - 1]["chunk_id"] if idx > 0 else None
                ch["next_chunk_id"] = chunks[idx + 1]["chunk_id"] if idx + 1 < len(chunks) else None

            out_key = f"chunks/{org_id}/{library_id}/{doc_id}.json"
            put_r2_json(
                out_key,
                {
                    "doc_id": doc_id,
                    "library_id": library_id,
                    "organization_id": org_id,
                    "created_at": now_iso(),
                    "text_key": text_key,
                    "visuals_manifest_key": vis_key,
                    "chunking": {
                        "strategy": os.getenv("CHUNK_STRATEGY", "layout_structured"),
                        "semantic_enabled": os.getenv("CHUNK_SEMANTIC", "0") in {"1", "true", "yes", "on"},
                        "target_tokens": target_tokens,
                        "max_tokens": max_tokens,
                        "overlap_blocks": overlap_blocks,
                    },
                    "chunks": chunks,
                },
            )

            current += 1
            if current % progress_every == 0:
                _sb_execute(
                    supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                        "id", job_id
                    ),
                    context="batch_stage_jobs.update(chunking.progress)",
                )

        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "done", "finished_at": now_iso(), "progress_current": total, "progress_total": total}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(chunking.done)",
        )

        # Enqueue next stage if configured (e.g. embedding) after chunking.
        stages = _pipeline_stages()
        try:
            idx = stages.index("chunking")
        except ValueError:
            idx = -1
        if 0 <= idx < len(stages) - 1:
            next_stage = stages[idx + 1]
            if next_stage:
                _ensure_stage_job_exists(org_id, library_id, batch_id, next_stage, total)

        _update_library_progress(library_id, stage="chunking")
        _maybe_finalize_pipeline(library_id)
    except Exception as exc:
        from errors import friendly_error
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": friendly_error(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(chunking.failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "chunking",
                    "pipeline_error": friendly_error(exc),
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(chunking.failed)",
        )
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in chunking: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("CHUNK_IDLE_LIMIT", "60"))
    print(f"[{WORKER_ID}] ready (idle_limit={idle_limit})")
    while True:
        job = claim_chunk_stage_job(WORKER_ID)
        if not job:
            idle += 1
            if idle >= idle_limit:
                print("No chunk jobs remaining. Exiting.")
                return
            time.sleep(2)
            continue
        idle = 0
        run_chunk_stage_job(job)


if __name__ == "__main__":
    worker_loop()
