import io
import json
import os
import random
import re
import csv
import time
from datetime import datetime, timezone
from typing import Any, Optional, Tuple, List, Dict
import statistics

import boto3
import fitz  # PyMuPDF
from PIL import Image
from env_bootstrap import load_env
from supabase import create_client

load_env()

WORKER_ID = os.getenv("WORKER_ID", "caption-1")


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
    try:
        if exc.args and isinstance(exc.args[0], dict):
            code = str(exc.args[0].get("code") or "")
            details = str(exc.args[0].get("details") or "").lower()
            if code in {"502", "521", "429"}:
                return True
            if "bad gateway" in details or "web server is down" in details:
                return True
    except Exception:
        pass
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


def put_r2_png(key: str, image: Image.Image):
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    s3.put_object(Bucket=R2_BUCKET, Key=key, Body=buf.getvalue(), ContentType="image/png")


def put_r2_text(key: str, text: str, content_type: str = "text/plain; charset=utf-8"):
    s3.put_object(Bucket=R2_BUCKET, Key=key, Body=(text or "").encode("utf-8"), ContentType=content_type)


def _pipeline_stages():
    import pipeline_config
    return pipeline_config.pipeline_stages()


def _parallel_extraction_stages():
    import pipeline_config
    return pipeline_config.parallel_extraction_stages()


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


def _count_batch_stage_done(batch_id: str, stage: str) -> bool:
    resp = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("id")
        .eq("batch_id", batch_id)
        .eq("stage", stage)
        .eq("status", "done")
        .limit(1),
        context=f"batch_stage_jobs.select(done:{stage})",
    )
    return bool(resp.data)


def _maybe_enqueue_next_after_parallel(org_id: str, library_id: str, batch_id: str, progress_total: int):
    stages = _pipeline_stages()
    parallel = [s for s in _parallel_extraction_stages() if s in stages]
    if not parallel:
        return
    if any(not _count_batch_stage_done(batch_id, st) for st in parallel):
        return

    last_idx = max(stages.index(st) for st in parallel)
    if last_idx < len(stages) - 1:
        next_stage = stages[last_idx + 1]
        if next_stage:
            _ensure_stage_job_exists(org_id, library_id, batch_id, next_stage, progress_total)


def _normalize_type(t: str) -> str:
    t = (t or "").strip().lower()
    if t in {"abandon", "ignore", "background"}:
        return "ignore"
    # DocLayout-YOLO may emit `figure_caption` / `table_caption`. Those are text regions,
    # not visuals we should crop/OCR; we already link captions via text_extraction.
    if "caption" in t and ("figure" in t or "table" in t):
        return "ignore"
    if "table" in t:
        return "table"
    if "equation" in t or "formula" in t or t in {"math"}:
        return "formula"
    if "figure" in t or "image" in t or "graph" in t or "chart" in t or "picture" in t:
        return "figure"
    return "other"


_CAPTION_RE = re.compile(r"^(fig(?:ure)?|table)\s*[\.:]?\s*\d+", re.IGNORECASE)
_FIG_MENTION_RE = re.compile(r"\bfig(?:\.|ure)?\s*(\d+)\b", re.IGNORECASE)
_TABLE_MENTION_RE = re.compile(r"\btable\s*(\d+)\b", re.IGNORECASE)
_NUM_TOKEN_RE = re.compile(r"(?<!\w)(\$?\d+(?:[\.,]\d+)*(?:%|x|k|m|b)?)(?!\w)", re.IGNORECASE)
_UNIT_RE = re.compile(r"\b(usd|eur|gbp|pkr|rs|inr|million|billion|bn|mm|%|percent)\b", re.IGNORECASE)


def _clean_text(s: str) -> str:
    s = (s or "").replace("\x00", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def _extract_ref_number(kind: str, text: str) -> Optional[str]:
    t = (text or "").strip()
    if not t:
        return None
    if kind == "table":
        m = _TABLE_MENTION_RE.search(t)
        return m.group(1) if m else None
    # default to figure
    m = _FIG_MENTION_RE.search(t)
    return m.group(1) if m else None


def _collect_ref_numbers(kind: str, texts: List[str]) -> List[str]:
    out: List[str] = []
    for s in texts:
        n = _extract_ref_number(kind, s)
        if n:
            out.append(n)
    return out


def _is_heading_like(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    # crude heuristic: very short uppercase or title-like with no punctuation
    if len(t) <= 40 and t.upper() == t and any(ch.isalpha() for ch in t):
        return True
    if len(t) <= 25 and t.endswith(":"):
        return True
    return False


def _merge_caption_blocks(
    blocks: List[dict],
    start_block_id: str,
    max_blocks: int = 4,
) -> Optional[str]:
    """
    Given a list of text blocks (each dict should include block_id, bbox_img, text),
    merge consecutive caption blocks to handle multi-block captions.
    """
    # Sort blocks by y then x for stable reading order.
    b2 = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if (b.get("kind") or "") != "text":
            continue
        bid = b.get("block_id")
        bb = b.get("bbox_img")
        txt = _clean_text(str(b.get("text") or ""))
        if not bid or not bb or not txt:
            continue
        try:
            x1, y1, x2, y2 = [float(v) for v in bb]
        except Exception:
            continue
        b2.append((bid, fitz.Rect(x1, y1, x2, y2), txt))
    b2.sort(key=lambda t: (t[1].y0, t[1].x0))

    idx = None
    for i, (bid, _r, _txt) in enumerate(b2):
        if bid == start_block_id:
            idx = i
            break
    if idx is None:
        return None

    merged = [b2[idx][2]]
    base_rect = b2[idx][1]
    for j in range(idx + 1, min(len(b2), idx + max_blocks)):
        bid, r, txt = b2[j]
        # Stop if new caption starts or looks like a section heading.
        if _CAPTION_RE.match(txt) or _is_heading_like(txt):
            break
        # Keep only blocks close below and with decent x-overlap.
        dy = r.y0 - base_rect.y1
        if dy < -2:
            break
        if dy > float(os.getenv("VIS_CAPTION_MERGE_MAX_DY", "80")):
            break
        if _rect_x_overlap(base_rect, r) < float(os.getenv("VIS_CAPTION_MERGE_MIN_XO", "0.25")):
            break
        merged.append(txt)
        base_rect = r
    out = _clean_text(" ".join(merged))
    return out or None


def _pick_best_caption_candidate(
    kind: str,
    caption_candidates: List[dict],
    prefer_numbers: List[str],
) -> Tuple[Optional[str], List[dict]]:
    """
    Choose best caption among candidates, preferring number match when available.
    caption_candidates items may include text_snippet/text.
    """
    if not caption_candidates:
        return None, []

    # Extract candidate texts
    cands = []
    for c in caption_candidates:
        if not isinstance(c, dict):
            continue
        txt = _clean_text(str(c.get("text") or c.get("text_snippet") or ""))
        if not txt:
            continue
        n = _extract_ref_number(kind, txt)
        cands.append((c, txt, n))

    if not cands:
        return None, []

    if prefer_numbers:
        for num in prefer_numbers:
            for c, txt, n in cands:
                if n == num:
                    return txt, caption_candidates

    # Fallback: first candidate already sorted by score upstream
    return cands[0][1], caption_candidates


def _cross_page_caption_fallback(
    text_doc: Optional[dict],
    page_index: int,
    kind: str,
) -> Tuple[Optional[str], List[dict]]:
    """
    If caption isn't on the same page, scan next page top-area blocks for caption-like text.
    Uses text_extraction artifact when available.
    """
    if not text_doc:
        return None, []
    pages = text_doc.get("pages") or []
    by_page = {int(p.get("page")): p for p in pages if isinstance(p, dict) and "page" in p}
    nxt = by_page.get(int(page_index) + 1) or None
    if not nxt:
        return None, []
    blocks = nxt.get("blocks") or []
    top_y = float(os.getenv("VIS_CROSSPAGE_TOP_Y_PX", "220"))
    cands = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if (b.get("kind") or "") != "text":
            continue
        bb = b.get("bbox_img")
        if not bb:
            continue
        try:
            _x1, y1, _x2, _y2 = [float(v) for v in bb]
        except Exception:
            continue
        if y1 > top_y:
            continue
        txt = _clean_text(str(b.get("text") or ""))
        if not txt:
            continue
        if _CAPTION_RE.match(txt) or (_extract_ref_number(kind, txt) is not None):
            cands.append({"block_id": b.get("block_id"), "text": txt, "score": 0.0})
    if not cands:
        return None, []
    return _clean_text(cands[0]["text"]), cands[:3]


def _infer_doc_profile(text_doc: Optional[dict], pages_layout: List[dict]) -> str:
    """
    Lightweight doc profiling:
    - scanned: low text density
    - financial_report: sparse Fig/Table mentions but many large visuals
    - digital_text_rich: default
    """
    sample_pages = int(os.getenv("VIS_PROFILE_PAGES", "5"))

    # Text density
    text_chars = 0
    pages_count = 0
    mentions = 0
    if text_doc:
        for p in (text_doc.get("pages") or [])[:sample_pages]:
            pages_count += 1
            for b in (p.get("blocks") or []):
                if isinstance(b, dict) and (b.get("kind") == "text"):
                    t = str(b.get("text") or "")
                    text_chars += len(t)
                    low = t.lower()
                    if "fig" in low or "figure" in low or "table" in low:
                        mentions += 1

    avg_chars = (text_chars / max(1, pages_count)) if pages_count else 0
    if avg_chars < int(os.getenv("VIS_SCANNED_CHARS_PER_PAGE", "600")):
        return "scanned"

    # Large visual frequency
    large_pages = 0
    checked = 0
    for p in pages_layout[:sample_pages]:
        checked += 1
        blocks = p.get("blocks") or []
        big = 0
        for b in blocks:
            if not isinstance(b, dict):
                continue
            t = _normalize_type(b.get("type") or "")
            if t not in {"figure", "table"}:
                continue
            bb = b.get("bbox")
            if not bb:
                continue
            try:
                x1, y1, x2, y2 = [float(v) for v in bb]
            except Exception:
                continue
            area = max(0.0, (x2 - x1)) * max(0.0, (y2 - y1))
            if area >= float(os.getenv("VIS_FIN_LARGE_BBOX_AREA_PX", "35000")):
                big += 1
        if big >= int(os.getenv("VIS_FIN_LARGE_VISUALS_PER_PAGE", "2")):
            large_pages += 1

    if checked and (mentions <= int(os.getenv("VIS_FIN_MENTIONS_MAX", "1"))) and (large_pages / checked) >= 0.4:
        return "financial_report"
    return "digital_text_rich"


def _rect_x_overlap(a: fitz.Rect, b: fitz.Rect) -> float:
    inter = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    denom = max(1.0, a.width)
    return float(inter / denom)


def _best_caption_near_bbox(page: fitz.Page, bbox_pdf: fitz.Rect, kind: str) -> tuple[str | None, list[dict]]:
    """
    Heuristic caption finder:
    - scans page text blocks
    - prefers blocks directly below the visual bbox, with x-overlap
    - boosts blocks that look like "Figure 2:" / "Table 1."
    Returns (best_caption, candidates_debug).
    """
    try:
        blocks = page.get_text("blocks") or []
    except Exception:
        blocks = []

    candidates: list[tuple[float, str, fitz.Rect]] = []
    debug: list[dict] = []

    for b in blocks:
        try:
            x0, y0, x1, y1, text = float(b[0]), float(b[1]), float(b[2]), float(b[3]), str(b[4] or "")
        except Exception:
            continue
        text = _clean_text(text)
        if not text:
            continue

        r = fitz.Rect(x0, y0, x1, y1)
        # Distance: prefer below; penalize above.
        dy_below = r.y0 - bbox_pdf.y1
        dy_above = bbox_pdf.y0 - r.y1
        if dy_below >= 0:
            dy = dy_below
        else:
            dy = abs(dy_above) * 1.6

        xo = _rect_x_overlap(bbox_pdf, r)
        xo_pen = (1.0 - xo) * 140.0

        looks_like_caption = bool(_CAPTION_RE.match(text))
        kind_hint = kind in text.lower()
        boost = 0.0
        if looks_like_caption:
            boost -= 60.0
        if kind_hint:
            boost -= 20.0

        score = float(dy + xo_pen + boost)
        # Ignore very far candidates.
        if score > 800:
            continue
        candidates.append((score, text, r))
        debug.append({"score": round(score, 2), "text": text[:220], "rect": [x0, y0, x1, y1]})

    candidates.sort(key=lambda t: t[0])
    best = candidates[0][1] if candidates else None
    return best, debug[:10]


def _score_block_to_visual_bbox_img(visual_bbox_img: List[float], block_bbox_img: List[float]) -> float:
    """
    Score how likely a text block is the caption/related text for a visual block.
    Lower is better.
    """
    try:
        vx1, vy1, vx2, vy2 = [float(v) for v in visual_bbox_img]
        bx1, by1, bx2, by2 = [float(v) for v in block_bbox_img]
    except Exception:
        return 1e9

    v = fitz.Rect(vx1, vy1, vx2, vy2)
    b = fitz.Rect(bx1, by1, bx2, by2)

    dy_below = b.y0 - v.y1
    dy_above = v.y0 - b.y1
    if dy_below >= 0:
        dy = dy_below
    else:
        dy = abs(dy_above) * 1.6

    xo = _rect_x_overlap(v, b)
    xo_pen = (1.0 - xo) * 140.0
    return float(dy + xo_pen)


def _pick_related_text_blocks(
    text_doc: Optional[dict],
    page_index: int,
    visual_bbox_img: List[float],
    kind: str,
    max_related: int = 3,
    max_candidates: int = 3,
) -> Tuple[List[dict], List[dict], Optional[str], List[str]]:
    """
    Uses the text_extraction artifact (text/{org}/{library}/{doc}.json) to:
    - pick related_text_blocks (top N by score)
    - pick caption_candidates (top N that look like Figure/Table captions)
    - pick best caption_text (text of best caption candidate if present)
    - collect nearby mentions ("as shown in Fig...") for Qwen context
    """
    if not text_doc:
        return [], [], None, []

    pages = text_doc.get("pages") or []
    by_page = {int(p.get("page")): p for p in pages if isinstance(p, dict) and "page" in p}
    p = by_page.get(int(page_index)) or {}
    blocks = p.get("blocks") or []

    related: List[Tuple[float, dict]] = []
    caption_like: List[Tuple[float, dict]] = []
    mentions: List[str] = []

    kind_word = "table" if kind == "table" else "fig"
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if (b.get("kind") or "") != "text":
            continue
        bbox = b.get("bbox_img")
        if not bbox:
            continue
        score = _score_block_to_visual_bbox_img(visual_bbox_img, bbox)
        txt = _clean_text(str(b.get("text") or ""))
        if txt:
            low = txt.lower()
            if kind_word in low or "figure" in low or "fig." in low or "table" in low:
                # Keep small list of mention sentences for Qwen context.
                if len(txt) <= 300:
                    mentions.append(txt)
        rec = {"block_id": b.get("block_id"), "score": round(score, 2), "text_snippet": txt[:160]}
        related.append((score, rec))
        if _CAPTION_RE.match(txt):
            caption_like.append((score - 60.0, rec | {"text": txt}))

    related.sort(key=lambda x: x[0])
    caption_like.sort(key=lambda x: x[0])
    related_out = [r for _, r in related[:max_related] if r.get("block_id")]
    caption_out = [c for _, c in caption_like[:max_candidates] if c.get("block_id")]

    best_caption = None
    if caption_out:
        best_caption = caption_out[0].get("text")  # type: ignore

    return related_out, caption_out, best_caption, mentions[:8]


def _ocr_image(crop: Image.Image) -> str | None:
    if os.getenv("CAPTION_ENABLE_OCR", "1") not in {"1", "true", "yes", "on"}:
        return None
    try:
        engine = (os.getenv("VIS_OCR_ENGINE") or os.getenv("CAPTION_OCR_ENGINE") or "tesseract").strip().lower()
        if engine == "surya":
            txt = _ocr_surya(crop)
            if txt:
                return txt
            if os.getenv("VIS_OCR_FALLBACK_TESSERACT", "1") in {"1", "true", "yes", "on"}:
                return _ocr_tesseract_two_pass(crop)
            return None
        if engine in {"glm", "glm_ocr", "glm-ocr"}:
            return _ocr_glm(crop)
        return _ocr_tesseract_two_pass(crop)
    except Exception:
        return None


def _preprocess_for_ocr(img: Image.Image) -> Image.Image:
    try:
        from PIL import ImageOps, ImageEnhance

        out = img.convert("RGB")
        out = ImageOps.autocontrast(out)
        out = ImageEnhance.Sharpness(out).enhance(1.4)
        w, h = out.size
        if min(w, h) < 500:
            out = out.resize((w * 2, h * 2), resample=Image.BICUBIC)
        return out
    except Exception:
        return img


def _ocr_tesseract_two_pass(crop: Image.Image) -> str | None:
    try:
        import pytesseract  # type: ignore
    except Exception:
        return None

    img = _preprocess_for_ocr(crop)
    lang = os.getenv("CAPTION_OCR_LANG", "eng")
    cfg6 = os.getenv("CAPTION_OCR_CONFIG", "--psm 6")
    cfg11 = os.getenv("CAPTION_OCR_CONFIG_SPARSE", "--psm 11")
    t1 = ""
    t2 = ""
    try:
        t1 = _clean_text(pytesseract.image_to_string(img, lang=lang, config=cfg6))
    except Exception:
        pass
    try:
        t2 = _clean_text(pytesseract.image_to_string(img, lang=lang, config=cfg11))
    except Exception:
        pass
    best = t1 if len(t1) >= len(t2) else t2
    return best or None


def _ocr_surya(crop: Image.Image) -> str | None:
    # Best-effort optional backend; if not installed, return None.
    try:
        from surya.ocr import run_ocr  # type: ignore
    except Exception:
        return None
    try:
        img = _preprocess_for_ocr(crop)
        res = run_ocr([img])
        texts: List[str] = []
        if isinstance(res, list):
            for item in res:
                if isinstance(item, dict) and "text" in item:
                    texts.append(str(item.get("text") or ""))
                elif isinstance(item, str):
                    texts.append(item)
        txt = _clean_text("\n".join(texts))
        return txt or None
    except Exception:
        return None


def _ocr_surya_batch(images: List[Image.Image]) -> List[Optional[str]]:
    """
    Batched Surya OCR for speed (GPU-friendly).
    Returns list of texts aligned to input images.
    """
    if not images:
        return []
    try:
        from surya.ocr import run_ocr  # type: ignore
    except Exception:
        return [None for _ in images]

    try:
        imgs = [_preprocess_for_ocr(im) for im in images]
        res = run_ocr(imgs)
        out: List[Optional[str]] = []
        # Best-effort normalization: many surya versions return list[dict] or list[str]
        if isinstance(res, list) and len(res) == len(imgs):
            for item in res:
                if isinstance(item, dict):
                    txt = _clean_text(str(item.get("text") or ""))
                    out.append(txt or None)
                elif isinstance(item, str):
                    txt = _clean_text(item)
                    out.append(txt or None)
                else:
                    out.append(None)
            # If Surya fails on an image, try a cheap CPU fallback so charts/tables don't go empty.
            if os.getenv("VIS_OCR_FALLBACK_TESSERACT", "1") in {"1", "true", "yes", "on"}:
                fixed: List[Optional[str]] = []
                for im, txt in zip(images, out):
                    if txt:
                        fixed.append(txt)
                        continue
                    try:
                        fixed.append(_ocr_tesseract_two_pass(im))
                    except Exception:
                        fixed.append(None)
                return fixed
            return out
        # If shape unknown, fallback to per-image mode (still correct).
        for im in images:
            txt = _ocr_surya(im)
            if not txt and os.getenv("VIS_OCR_FALLBACK_TESSERACT", "1") in {"1", "true", "yes", "on"}:
                try:
                    txt = _ocr_tesseract_two_pass(im)
                except Exception:
                    txt = None
            out.append(txt)
        return out
    except Exception:
        return [None for _ in images]


_glm_ocr_model = None
_glm_ocr_processor = None


def _ocr_glm(crop: Image.Image) -> str | None:
    global _glm_ocr_model, _glm_ocr_processor
    model_id = os.getenv("VIS_GLM_OCR_MODEL", "zai-org/GLM-OCR")
    try:
        import torch
        from transformers import AutoProcessor, AutoModelForVision2Seq  # type: ignore
    except Exception:
        return None
    try:
        if _glm_ocr_model is None or _glm_ocr_processor is None:
            _glm_ocr_processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
            _glm_ocr_model = AutoModelForVision2Seq.from_pretrained(
                model_id,
                device_map="auto",
                torch_dtype=torch.float16 if torch.cuda.is_available() else None,
                trust_remote_code=True,
            )
            _glm_ocr_model.eval()

        img = _preprocess_for_ocr(crop)
        prompt = os.getenv("VIS_GLM_OCR_PROMPT", "Recognize all text.")
        inputs = _glm_ocr_processor(images=img, text=prompt, return_tensors="pt")
        if hasattr(_glm_ocr_model, "device"):
            inputs = {k: v.to(_glm_ocr_model.device) for k, v in inputs.items()}
        with torch.no_grad():
            out = _glm_ocr_model.generate(**inputs, max_new_tokens=int(os.getenv("VIS_GLM_OCR_MAX_TOKENS", "512")))
        txt = _glm_ocr_processor.batch_decode(out, skip_special_tokens=True)[0]
        txt = _clean_text(txt)
        return txt or None
    except Exception:
        return None


def _crop_rel(img: Image.Image, x0: float, y0: float, x1: float, y1: float) -> Image.Image:
    w, h = img.size
    a = max(0, min(w, int(x0 * w)))
    b = max(0, min(h, int(y0 * h)))
    c = max(0, min(w, int(x1 * w)))
    d = max(0, min(h, int(y1 * h)))
    if c <= a or d <= b:
        return img
    return img.crop((a, b, c, d))


def _ocr_chart_regions(crop: Image.Image) -> dict:
    """
    Extra OCR passes for charts:
    - legend-ish region (top-right)
    - y-axis labels (left strip)
    - x-axis labels (bottom strip)
    """
    if os.getenv("VIS_CHART_REGION_OCR", "1") not in {"1", "true", "yes", "on"}:
        return {"full": _ocr_image(crop)}

    full = _ocr_image(crop)
    legend = _ocr_image(_crop_rel(crop, 0.55, 0.00, 1.00, 0.35))
    yaxis = _ocr_image(_crop_rel(crop, 0.00, 0.00, 0.28, 1.00))
    xaxis = _ocr_image(_crop_rel(crop, 0.00, 0.72, 1.00, 1.00))
    return {"full": full, "legend": legend, "y_axis": yaxis, "x_axis": xaxis}


def _summarize_visual(kind: str, caption_text: str | None, ocr_text: str | None, table_text: str | None) -> dict:
    """
    No-LLM summarizer: keeps all raw signals and produces a short caption + bullets.
    This is intentionally conservative to avoid hallucinations.
    """
    short = _clean_text(caption_text or "")
    source = "pdf_caption" if short else "none"
    if not short and kind == "table" and table_text:
        short = "Table (text extracted from PDF)"
        source = "pdf_clip_text"
    if not short and ocr_text:
        short = f"{kind.title()} (OCR extracted)"
        source = "ocr"
    if not short:
        short = f"{kind.title()} (no caption found)"

    bullets: list[str] = []
    if caption_text:
        bullets.append(_clean_text(caption_text)[:240])
    if kind == "table" and table_text:
        t = [ln.strip() for ln in (table_text or "").splitlines() if ln.strip()]
        if t:
            bullets.append("Table text snippet: " + _clean_text(" ".join(t[:3]))[:240])
    if ocr_text:
        o = [ln.strip() for ln in (ocr_text or "").splitlines() if ln.strip()]
        if o:
            bullets.append("OCR snippet: " + _clean_text(" ".join(o[:3]))[:240])

    return {
        "short_caption": short,
        "bullets": bullets[:6],
        "confidence": 0.85 if source == "pdf_caption" else (0.65 if source in {"pdf_clip_text", "ocr"} else 0.35),
        "sources_used": [source] if source != "none" else [],
        "summary_source": source,
    }


def _extract_table_pdf_native(page: fitz.Page, bbox_pdf: fitz.Rect) -> Tuple[Optional[str], Optional[dict]]:
    """
    Best-effort table structure reconstruction from selectable PDF text.
    Returns (csv_text, json_payload) or (None, None).
    """
    try:
        d = page.get_text("dict", clip=bbox_pdf)
    except Exception:
        return None, None

    spans = []
    for b in (d.get("blocks") or []):
        for line in (b.get("lines") or []):
            for sp in (line.get("spans") or []):
                txt = _clean_text(str(sp.get("text") or ""))
                if not txt:
                    continue
                bb = sp.get("bbox") or None
                if not bb or len(bb) != 4:
                    continue
                x0, y0, x1, y1 = [float(v) for v in bb]
                spans.append({"text": txt, "x0": x0, "y0": y0, "x1": x1, "y1": y1})

    if not spans:
        return None, None

    # Group spans into rows by y-center.
    spans.sort(key=lambda s: (s["y0"] + s["y1"]) / 2.0)
    rows: List[List[dict]] = []
    y_tol = float(os.getenv("VIS_TABLE_Y_TOL", "3.5"))

    for sp in spans:
        yc = (sp["y0"] + sp["y1"]) / 2.0
        if not rows:
            rows.append([sp | {"yc": yc}])
            continue
        last_row = rows[-1]
        last_yc = statistics.mean([r["yc"] for r in last_row])  # type: ignore
        if abs(yc - last_yc) <= y_tol:
            last_row.append(sp | {"yc": yc})
        else:
            rows.append([sp | {"yc": yc}])

    # Sort each row by x0 and emit cells by simple gaps clustering.
    table_rows: List[List[str]] = []
    x_gap = float(os.getenv("VIS_TABLE_X_GAP", "10"))
    for row in rows:
        row.sort(key=lambda s: s["x0"])
        cells: List[str] = []
        cur = ""
        last_x1 = None
        for sp in row:
            if last_x1 is None:
                cur = sp["text"]
                last_x1 = sp["x1"]
                continue
            gap = float(sp["x0"] - (last_x1 or sp["x0"]))
            if gap >= x_gap:
                cells.append(cur.strip())
                cur = sp["text"]
            else:
                cur = (cur + " " + sp["text"]).strip()
            last_x1 = sp["x1"]
        if cur.strip():
            cells.append(cur.strip())
        if any(cells):
            table_rows.append(cells)

    if not table_rows:
        return None, None

    # Render CSV (ragged rows allowed).
    out = io.StringIO()
    w = csv.writer(out)
    for r in table_rows:
        w.writerow(r)
    csv_text = out.getvalue()

    payload = {"engine": "pdf_native", "rows": table_rows, "row_count": len(table_rows)}
    return csv_text, payload


def _ocr_boxes_tesseract(crop: Image.Image) -> Optional[List[dict]]:
    if os.getenv("VIS_OCR_WITH_BOXES", "0") not in {"1", "true", "yes", "on"}:
        return None
    try:
        import pytesseract  # type: ignore
    except Exception:
        return None
    try:
        img = _preprocess_for_ocr(crop)
        lang = os.getenv("CAPTION_OCR_LANG", "eng")
        cfg = os.getenv("CAPTION_OCR_CONFIG", "--psm 6")
        data = pytesseract.image_to_data(img, lang=lang, config=cfg, output_type=pytesseract.Output.DICT)
        n = len(data.get("text") or [])
        out = []
        for i in range(n):
            txt = _clean_text(str((data.get("text") or [""])[i]))
            if not txt:
                continue
            try:
                conf = float((data.get("conf") or ["-1"])[i])
            except Exception:
                conf = -1.0
            out.append(
                {
                    "text": txt,
                    "conf": conf,
                    "left": int((data.get("left") or [0])[i]),
                    "top": int((data.get("top") or [0])[i]),
                    "width": int((data.get("width") or [0])[i]),
                    "height": int((data.get("height") or [0])[i]),
                }
            )
        return out[: int(os.getenv("VIS_OCR_BOXES_MAX", "400"))]
    except Exception:
        return None


_qwen_model = None
_qwen_processor = None


def _extract_evidence_text(caption_text: Optional[str], ocr_text: Optional[str], table_csv: Optional[str], mentions: List[str]) -> str:
    parts = []
    if caption_text:
        parts.append(str(caption_text))
    if ocr_text:
        parts.append(str(ocr_text))
    if table_csv:
        parts.append(str(table_csv))
    if mentions:
        parts.append("\n".join(mentions[:6]))
    return "\n".join(parts)


def _qwen_postcheck(qwen_obj: dict, evidence_text: str) -> dict:
    """
    Penalize outputs that introduce unsupported hard facts (numbers/units).
    If VIS_QWEN_STRICT=1, drop the Qwen output entirely when violations occur.
    """
    if not isinstance(qwen_obj, dict):
        return qwen_obj
    strict = os.getenv("VIS_QWEN_STRICT", "0") in {"1", "true", "yes", "on"}
    ev = (evidence_text or "").lower()
    out_txt = json.dumps(qwen_obj, ensure_ascii=True).lower()

    ev_nums = set(_NUM_TOKEN_RE.findall(ev))
    out_nums = set(_NUM_TOKEN_RE.findall(out_txt))
    extra_nums = [n for n in out_nums if n not in ev_nums]

    ev_units = set(_UNIT_RE.findall(ev))
    out_units = set(_UNIT_RE.findall(out_txt))
    extra_units = [u for u in out_units if u not in ev_units]

    violations = len(extra_nums) + len(extra_units)
    if violations <= 0:
        return qwen_obj

    # Penalize confidence; add uncertainty note.
    try:
        conf = float(qwen_obj.get("confidence") or 0.5)
    except Exception:
        conf = 0.5
    conf = max(0.1, conf * 0.65)
    qwen_obj["confidence"] = conf
    unc = qwen_obj.get("uncertainties")
    if not isinstance(unc, list):
        unc = []
    unc.append("Some numeric/units claims could not be verified from caption/OCR/table text.")
    qwen_obj["uncertainties"] = unc[:8]

    if strict:
        return {"_discarded": True, "reason": "unsupported_hard_facts"}
    return qwen_obj


def _qwen_generate_batch(tasks: List[dict]) -> List[Optional[dict]]:
    """
    Batch Qwen inference for speed. Each task must include:
      crop, kind, caption_text, ocr_text, table_csv, nearby_mentions
    """
    if not tasks:
        return []

    # API captioner (OpenRouter Qwen2.5-VL): off-GPU, far stronger than local Qwen2-VL-2B, and
    # returns the SAME dict shape so all downstream parsing is unchanged. Enable with
    # CAPTION_USE_API=1 + CAPTION_VLM_API_KEY. Falls through to the local model on failure.
    if str(os.getenv("CAPTION_USE_API", "0")).strip().lower() in {"1", "true", "yes", "on"}:
        try:
            import vlm_client

            if vlm_client.is_configured():
                outs: List[Optional[dict]] = []
                for t in tasks:
                    obj = vlm_client.describe_visual(
                        t.get("crop"),
                        kind=t.get("kind") or "figure",
                        caption_text=t.get("caption_text"),
                        ocr_text=t.get("ocr_text"),
                        table_csv=t.get("table_csv"),
                        nearby_mentions=t.get("nearby_mentions"),
                    )
                    if isinstance(obj, dict) and obj.get("formula_latex") and not obj.get("latex"):
                        obj["latex"] = obj.get("formula_latex")
                    outs.append(obj)
                if any(o is not None for o in outs):
                    return outs
        except Exception:
            pass  # fall through to local Qwen below

    if os.getenv("VIS_ENABLE_QWEN_FALLBACK", "1") not in {"1", "true", "yes", "on"}:
        return [None for _ in tasks]
    if os.getenv("VIS_QWEN_MODE", "auto").strip().lower() == "off":
        return [None for _ in tasks]

    model_id = os.getenv("VIS_QWEN_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
    try:
        import torch
        from transformers import AutoProcessor  # type: ignore
        try:
            from transformers import Qwen2VLForConditionalGeneration as QwenModel  # type: ignore
        except Exception:
            from transformers import AutoModelForVision2Seq as QwenModel  # type: ignore
    except Exception:
        return [None for _ in tasks]

    global _qwen_model, _qwen_processor
    try:
        if _qwen_model is None or _qwen_processor is None:
            _qwen_processor = AutoProcessor.from_pretrained(model_id)
            _qwen_model = QwenModel.from_pretrained(
                model_id,
                device_map="auto",
                torch_dtype=torch.float16 if torch.cuda.is_available() else None,
            )
            _qwen_model.eval()

        messages = []
        images = []
        evidences = []
        for t in tasks:
            crop = t["crop"]
            kind = t.get("kind") or "figure"
            cap = (t.get("caption_text") or "").strip()
            ocr_text = (t.get("ocr_text") or None)
            table_csv = (t.get("table_csv") or None)
            nearby_mentions = t.get("nearby_mentions") or []

            prompt = {
                "task": "visual_understanding",
                "kind": kind,
                "instructions": (
                    "You are extracting grounded information from a document visual.\n"
                    "Use provided OCR/caption/table text as the source of truth for hard facts.\n"
                    "If something is not readable, say 'not specified'.\n"
                    "Return STRICT JSON with keys: short_caption, key_observations, extracted_entities, uncertainties, confidence.\n"
                    "If kind=='formula', also include key 'latex' with the best-effort LaTeX transcription.\n"
                ),
                "caption_text": cap or None,
                "ocr_text": (ocr_text or None),
                "table_csv": (table_csv or None),
                "nearby_mentions": nearby_mentions[:5],
            }
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": crop},
                        {"type": "text", "text": json.dumps(prompt, ensure_ascii=True)},
                    ],
                }
            )
            images.append(crop)
            evidences.append(_extract_evidence_text(cap or None, ocr_text, table_csv, nearby_mentions))

        texts = [_qwen_processor.apply_chat_template([m], tokenize=False, add_generation_prompt=True) for m in messages]
        inputs = _qwen_processor(text=texts, images=images, return_tensors="pt", padding=True)
        try:
            device = _qwen_model.device  # type: ignore
            inputs = {k: v.to(device) for k, v in inputs.items()}
        except Exception:
            pass

        max_new = int(os.getenv("VIS_QWEN_MAX_TOKENS", "512"))
        with torch.no_grad():
            out = _qwen_model.generate(**inputs, max_new_tokens=max_new)
        decs = _qwen_processor.batch_decode(out, skip_special_tokens=True)

        outs: List[Optional[dict]] = []
        for dec, ev in zip(decs, evidences):
            s = (dec or "").strip()
            j0 = s.find("{")
            j1 = s.rfind("}")
            if j0 != -1 and j1 != -1 and j1 > j0:
                s = s[j0 : j1 + 1]
            try:
                obj = json.loads(s)
                if not isinstance(obj, dict):
                    outs.append(None)
                    continue
                obj = _qwen_postcheck(obj, ev)
                if obj.get("_discarded"):
                    outs.append(None)
                else:
                    outs.append(obj)
            except Exception:
                outs.append(None)
        return outs
    except Exception:
        return [None for _ in tasks]


def _maybe_qwen_fallback(
    crop: Image.Image,
    kind: str,
    caption_text: Optional[str],
    ocr_text: Optional[str],
    table_csv: Optional[str],
    nearby_mentions: List[str],
) -> Optional[dict]:
    if os.getenv("VIS_ENABLE_QWEN_FALLBACK", "1") not in {"1", "true", "yes", "on"}:
        return None

    # Heuristic triggers
    cap = (caption_text or "").strip()
    if len(cap) >= int(os.getenv("VIS_QWEN_MIN_CAPTION_CHARS", "40")) and kind != "figure":
        return None
    if not cap and not ocr_text and not table_csv and kind != "figure":
        return None

    model_id = os.getenv("VIS_QWEN_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
    try:
        import torch
        from transformers import AutoProcessor  # type: ignore
        # Try both class names depending on transformers version.
        try:
            from transformers import Qwen2VLForConditionalGeneration as QwenModel  # type: ignore
        except Exception:
            from transformers import AutoModelForVision2Seq as QwenModel  # type: ignore
    except Exception:
        return None

    global _qwen_model, _qwen_processor
    try:
        if _qwen_model is None or _qwen_processor is None:
            _qwen_processor = AutoProcessor.from_pretrained(model_id)
            _qwen_model = QwenModel.from_pretrained(
                model_id,
                device_map="auto",
                torch_dtype=torch.float16 if torch.cuda.is_available() else None,
            )
            _qwen_model.eval()

        prompt = {
            "task": "visual_understanding",
            "kind": kind,
            "instructions": (
                "You are extracting grounded information from a document visual.\n"
                "Use provided OCR/caption/table text as the source of truth for hard facts.\n"
                "If something is not readable, say 'not specified'.\n"
                "Return STRICT JSON with keys: short_caption, key_observations, extracted_entities, uncertainties, confidence.\n"
                "If kind=='formula', also include key 'latex' with the best-effort LaTeX transcription.\n"
            ),
            "caption_text": cap or None,
            "ocr_text": (ocr_text or None),
            "table_csv": (table_csv or None),
            "nearby_mentions": nearby_mentions[:5],
        }
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": crop},
                    {"type": "text", "text": json.dumps(prompt, ensure_ascii=True)},
                ],
            }
        ]

        text = _qwen_processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = _qwen_processor(text=[text], images=[crop], return_tensors="pt")
        # Move tensors to the model's device if possible.
        try:
            device = _qwen_model.device  # type: ignore
            inputs = {k: v.to(device) for k, v in inputs.items()}
        except Exception:
            pass
        with torch.no_grad():
            out = _qwen_model.generate(**inputs, max_new_tokens=int(os.getenv("VIS_QWEN_MAX_TOKENS", "512")))
        dec = _qwen_processor.batch_decode(out, skip_special_tokens=True)[0]
        dec = dec.strip()

        # Extract JSON substring if model wraps it in text.
        j0 = dec.find("{")
        j1 = dec.rfind("}")
        if j0 != -1 and j1 != -1 and j1 > j0:
            dec = dec[j0 : j1 + 1]
        try:
            obj = json.loads(dec)
        except Exception:
            return None
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def claim_caption_stage_job(worker_id: str):
    # Gate claiming: image_captioning should only run after layout_parser is done for the batch.
    jobs = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("*")
        .eq("stage", "image_captioning")
        .eq("status", "queued")
        .order("created_at")
        .limit(int(os.getenv("CLAIM_SCAN_LIMIT", "25"))),
        context="batch_stage_jobs.select(image_captioning.queued)",
    )
    rows = jobs.data or []
    if not rows:
        return None

    batch_ids = [r.get("batch_id") for r in rows if r.get("batch_id")]
    if not batch_ids:
        return None

    ready = _sb_execute(
        supabase.table("batch_stage_jobs")
        .select("batch_id")
        .in_("batch_id", batch_ids)
        .eq("stage", "layout_parser")
        .eq("status", "done"),
        context="batch_stage_jobs.select(layout.done.for_caption)",
    )
    ready_batches = {str(r.get("batch_id")) for r in (ready.data or []) if r.get("batch_id")}

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
        context="batch_stage_jobs.update(image_captioning.claim)",
    )
    if not claimed.data:
        return None
    return claimed.data[0]


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


def _stage_order(stage: str) -> int:
    stages = _pipeline_stages()
    try:
        return stages.index(stage)
    except ValueError:
        return 10_000


def _compute_next_stage(library_id: str) -> str:
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
        context="libraries.update(caption_progress)",
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


def _render_page_image(page: fitz.Page, render_scale: float) -> Image.Image:
    if render_scale <= 0:
        render_scale = 1.0
    pix = page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale))
    return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")


def _crop_bbox(img: Image.Image, bbox_img):
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox_img]
    except Exception:
        return None
    w, h = img.size
    x1 = max(0, min(w, int(x1)))
    x2 = max(0, min(w, int(x2)))
    y1 = max(0, min(h, int(y1)))
    y2 = max(0, min(h, int(y2)))
    if x2 <= x1 or y2 <= y1:
        return None
    return img.crop((x1, y1, x2, y2))


def run_caption_stage_job(stage_job):
    library_id = stage_job["library_id"]
    org_id = stage_job["organization_id"]
    batch_id = stage_job["batch_id"]
    job_id = stage_job["id"]

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

    _sb_execute(
        supabase.table("libraries").update({"pipeline_status": "running", "pipeline_stage": "image_captioning"}).eq(
            "id", library_id
        ),
        context="libraries.update(stage=image_captioning)",
    )

    # fetch docs metadata
    docs_by_id: dict[str, dict] = {}
    fetch_chunk = int(os.getenv("DOC_FETCH_CHUNK", "100"))
    for i in range(0, len(doc_ids), fetch_chunk):
        chunk = doc_ids[i : i + fetch_chunk]
        resp = _sb_execute(
            supabase.table("documents").select("id, storage_path_raw, mime_type").in_("id", chunk),
            context="documents.select(batch)",
        )
        for d in resp.data or []:
            docs_by_id[d["id"]] = d

    progress_every = int(os.getenv("STAGE_PROGRESS_EVERY", "1"))

    try:
        for doc_id in doc_ids:
            # Stop early if canceled/failed (checked per-doc to stop quickly on failures).
            st = _get_library_pipeline_status(library_id)
            if st is None or st in _PIPELINE_ABORT_STATUSES:
                _mark_stage_job_canceled(job_id, f"Aborted mid-batch (library pipeline_status={st or 'missing'}).")
                return

            d = docs_by_id.get(doc_id) or {}
            pdf_key = d.get("storage_path_raw")
            mime = (d.get("mime_type") or "").lower()
            if not pdf_key or ("pdf" not in mime):
                current += 1
                if current % progress_every == 0:
                    _sb_execute(
                        supabase.table("batch_stage_jobs").update(
                            {"progress_current": current, "progress_total": total}
                        ).eq("id", job_id),
                        context="batch_stage_jobs.update(progress)",
                    )
                continue

            layout_key = f"layout/{org_id}/{library_id}/{doc_id}.json"
            layout = fetch_r2_json(layout_key) or {}
            render_scale = float(layout.get("render_scale") or os.getenv("LAYOUT_RENDER_SCALE", "1.5"))
            pages = layout.get("layout") or []

            # Load text extraction artifact (for linking visuals <-> nearby text blocks).
            text_key = f"text/{org_id}/{library_id}/{doc_id}.json"
            text_doc = fetch_r2_json(text_key) or None

            # If no visual blocks, still write an empty manifest so downstream can be deterministic.
            out_blocks: List[dict] = []

            pdf_bytes = fetch_r2_bytes(pdf_key)
            pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")

            # render pages on demand and reuse per page
            page_img_cache: dict[int, Image.Image] = {}

            doc_profile = _infer_doc_profile(text_doc=text_doc, pages_layout=pages)

            min_area_px = int(os.getenv("VIS_MIN_BBOX_AREA_PX", "2500"))
            min_block_score = float(os.getenv("VIS_MIN_BLOCK_SCORE", "0.25"))
            max_financial_per_page = int(os.getenv("VIS_MAX_VISUALS_PER_PAGE_FINANCIAL", "5"))

            ocr_engine = (os.getenv("VIS_OCR_ENGINE") or "tesseract").strip().lower()
            ocr_mode = (os.getenv("VIS_OCR_MODE") or "auto").strip().lower()
            fig_ocr_mode = (os.getenv("VIS_FIGURE_OCR_MODE") or "auto").strip().lower()
            enable_qwen = os.getenv("VIS_ENABLE_QWEN_FALLBACK", "1") in {"1", "true", "yes", "on"}
            qwen_mode = (os.getenv("VIS_QWEN_MODE") or "auto").strip().lower()

            chart_region_ocr = os.getenv("VIS_CHART_REGION_OCR", "1") in {"1", "true", "yes", "on"}
            chart_region_min_len = int(os.getenv("VIS_CHART_REGION_OCR_MIN_LEN", "60"))

            ocr_batch = int(os.getenv("VIS_OCR_BATCH", "8"))
            if ocr_batch <= 0:
                ocr_batch = 1
            qwen_batch = int(os.getenv("VIS_QWEN_BATCH", "2"))
            if qwen_batch <= 0:
                qwen_batch = 1

            # Keep only the crops we still need for OCR/Qwen in memory. All crops are stored in R2 regardless.
            crops_by_block_id: dict[str, Image.Image] = {}
            blocks_by_id: dict[str, dict] = {}
            ocr_full_tasks: List[dict] = []

            def _bbox_area_px(bb: list[float]) -> float:
                try:
                    x1, y1, x2, y2 = [float(v) for v in bb]
                    return max(0.0, (x2 - x1)) * max(0.0, (y2 - y1))
                except Exception:
                    return 0.0

            def _visual_importance_score(bb: list[float], page_w: int, page_h: int, kind: str) -> float:
                # Score in [0, 1.5]-ish; later thresholding happens via envs.
                try:
                    x1, y1, x2, y2 = [float(v) for v in bb]
                except Exception:
                    return 0.0
                bw = max(1.0, x2 - x1)
                bh = max(1.0, y2 - y1)
                area_frac = (bw * bh) / max(1.0, float(page_w * page_h))
                y_mid = ((y1 + y2) / 2.0) / max(1.0, float(page_h))

                score = min(1.0, area_frac * 4.0)
                if kind == "table":
                    score += 0.20
                elif kind == "figure":
                    score += 0.10
                elif kind == "formula":
                    score += 0.05

                # downweight header/footer-ish regions
                if y_mid < 0.10 or y_mid > 0.90:
                    score -= 0.15
                else:
                    score += 0.05
                return max(0.0, score)

            def _should_full_ocr(kind: str, caption_text: Optional[str], table_text: Optional[str], table_csv: Optional[str]) -> bool:
                if ocr_mode == "off":
                    return False
                cap = (caption_text or "").strip()
                ttxt = (table_text or "").strip()
                tcsv = (table_csv or "").strip()

                if doc_profile == "scanned":
                    # Scanned docs need OCR almost always.
                    return True

                if kind == "table":
                    # If we already extracted a decent CSV from PDF-native text, OCR is usually redundant.
                    if len(tcsv) >= int(os.getenv("VIS_TABLE_CSV_STRONG_LEN", "120")):
                        return False
                    # If selectable text exists inside bbox, that might already be enough.
                    if len(ttxt) >= int(os.getenv("VIS_TABLE_TEXT_STRONG_LEN", "120")):
                        return False
                    return True

                if kind == "formula":
                    # Prefer OCR if formula text wasn't selectable.
                    return len(ttxt) < int(os.getenv("VIS_FORMULA_TEXT_STRONG_LEN", "25"))

                if kind == "figure":
                    if fig_ocr_mode == "off":
                        return False
                    # If caption is good and doc is digital/text-rich, OCR often adds little.
                    if doc_profile == "digital_text_rich" and len(cap) >= int(os.getenv("VIS_FIGURE_CAPTION_STRONG_LEN", "80")):
                        return False
                    # Financial reports often have key info embedded in the figure/table itself.
                    if doc_profile == "financial_report":
                        return True
                    # Default: OCR only when caption is weak.
                    return len(cap) < int(os.getenv("VIS_QWEN_MIN_CAPTION_CHARS", "40"))

                return False

            def _needs_qwen(kind: str, caption_text: Optional[str], ocr_text: Optional[str], table_csv: Optional[str], table_text: Optional[str]) -> bool:
                if not enable_qwen or qwen_mode == "off":
                    return False
                cap = (caption_text or "").strip()
                ocr = (ocr_text or "").strip()
                tcsv = (table_csv or "").strip()
                ttxt = (table_text or "").strip()

                if kind != "figure" and len(cap) >= int(os.getenv("VIS_QWEN_MIN_CAPTION_CHARS", "40")):
                    return False

                # Qwen is a fallback only: use it when we have insufficient evidence.
                if kind == "table":
                    return (len(tcsv) < 80) and (len(ttxt) < 120) and (len(ocr) < 80)
                if kind == "formula":
                    return (len(ttxt) < 25) and (len(ocr) < 25)
                # Figure: need semantic description when caption+OCR are weak.
                return (len(cap) < 40) and (len(ocr) < 80)

            for page_info in pages:
                page_index = int(page_info.get("page") or 0)
                blocks = page_info.get("blocks") or []
                if page_index not in page_img_cache:
                    page = pdf_doc.load_page(page_index)
                    page_img_cache[page_index] = _render_page_image(page, render_scale=render_scale)

                page_img = page_img_cache[page_index]
                page_w, page_h = page_img.size

                # Pre-score blocks so financial reports can process only top-K per page (Tier 1/2),
                # while still storing all crops losslessly (Tier 0).
                candidates: List[dict] = []
                for bi, b in enumerate(blocks):
                    if not isinstance(b, dict):
                        continue
                    t = b.get("type") or ""
                    kind = _normalize_type(t)
                    if kind not in {"figure", "table", "formula"}:
                        continue
                    bbox_img = b.get("bbox") or None
                    if not bbox_img:
                        continue
                    if _bbox_area_px(bbox_img) < float(min_area_px):
                        continue
                    score = _visual_importance_score(bbox_img, page_w, page_h, kind)
                    candidates.append({"bi": bi, "type": t, "kind": kind, "bbox_img": bbox_img, "score": score})

                full_process_ids: set[str] = set()
                if doc_profile == "financial_report":
                    candidates.sort(key=lambda c: float(c.get("score") or 0.0), reverse=True)
                    for c in candidates[: max(0, max_financial_per_page)]:
                        if float(c.get("score") or 0.0) >= float(min_block_score):
                            full_process_ids.add(f"p{page_index}_b{int(c['bi'])}")
                else:
                    for c in candidates:
                        full_process_ids.add(f"p{page_index}_b{int(c['bi'])}")

                page = pdf_doc.load_page(page_index)

                for c in candidates:
                    bi = int(c["bi"])
                    t = str(c.get("type") or "")
                    kind = str(c.get("kind") or "")
                    bbox_img = c.get("bbox_img")
                    if not bbox_img:
                        continue

                    crop = _crop_bbox(page_img, bbox_img)
                    if crop is None:
                        continue

                    block_id = f"p{page_index}_b{bi}"
                    visual_key = f"visuals/{org_id}/{library_id}/{doc_id}/{block_id}.png"
                    put_r2_png(visual_key, crop)

                    # Convert bbox from rendered-image pixels back to PDF points for text clipping.
                    try:
                        x1, y1, x2, y2 = [float(v) for v in bbox_img]
                        bbox_pdf = fitz.Rect(x1 / render_scale, y1 / render_scale, x2 / render_scale, y2 / render_scale)
                    except Exception:
                        bbox_pdf = None

                    # Prefer caption candidates from our text_extraction artifact (stable block_ids).
                    related_text_blocks, caption_candidates, caption_text_from_textdoc, nearby_mentions = _pick_related_text_blocks(
                        text_doc=text_doc,
                        page_index=page_index,
                        visual_bbox_img=bbox_img,
                        kind=kind,
                    )

                    caption_text = caption_text_from_textdoc
                    caption_debug = caption_candidates

                    # Caption grounding improvements: number linking + multi-block merge.
                    prefer_nums = _collect_ref_numbers(kind, nearby_mentions)
                    chosen_block_id = None
                    if caption_candidates:
                        # Prefer a candidate with matching Fig/Table number if present.
                        chosen_txt = None
                        for num in prefer_nums:
                            for cc in caption_candidates:
                                txt = _clean_text(str(cc.get("text") or cc.get("text_snippet") or ""))
                                if not txt:
                                    continue
                                if _extract_ref_number(kind, txt) == num:
                                    chosen_txt = txt
                                    chosen_block_id = cc.get("block_id")
                                    break
                            if chosen_txt:
                                break
                        if not chosen_txt:
                            cc0 = caption_candidates[0]
                            chosen_txt = _clean_text(str(cc0.get("text") or cc0.get("text_snippet") or ""))
                            chosen_block_id = cc0.get("block_id")
                        caption_text = chosen_txt or caption_text

                        # Multi-block caption merge (best effort).
                        try:
                            if text_doc and chosen_block_id:
                                page_blocks = []
                                for p in (text_doc.get("pages") or []):
                                    if int(p.get("page") or -1) == int(page_index):
                                        page_blocks = p.get("blocks") or []
                                        break
                                merged = _merge_caption_blocks(page_blocks, str(chosen_block_id))
                                if merged:
                                    caption_text = merged
                        except Exception:
                            pass

                    # Cross-page caption fallback (next page top).
                    if not caption_text and text_doc:
                        cap2, dbg2 = _cross_page_caption_fallback(text_doc=text_doc, page_index=page_index, kind=kind)
                        if cap2:
                            caption_text = cap2
                            if dbg2:
                                caption_debug = (caption_debug or []) + dbg2

                    # Fallback to raw PDF text blocks if text_extraction artifact is missing.
                    if not caption_text and bbox_pdf is not None:
                        caption_text, raw_dbg = _best_caption_near_bbox(page, bbox_pdf, kind=kind)
                        if raw_dbg and not caption_debug:
                            caption_debug = raw_dbg

                    # Extract selectable text inside the visual bbox (useful for tables/formulas, sometimes for plots).
                    table_text = None
                    if bbox_pdf is not None and kind in {"table", "formula"}:
                        try:
                            table_text = page.get_text("text", clip=bbox_pdf) or None
                        except Exception:
                            table_text = None
                        if table_text:
                            table_text = table_text.strip() or None

                    # Structured table extraction (pdf-native first).
                    table_csv_key = None
                    table_json_key = None
                    table_csv = None
                    table_struct = None
                    if bbox_pdf is not None and kind == "table":
                        eng = (os.getenv("VIS_TABLE_ENGINE") or "pdf_native").strip().lower()
                        if eng == "pdf_native":
                            table_csv, table_struct = _extract_table_pdf_native(page, bbox_pdf)
                            if table_csv:
                                table_csv_key = f"tables/{org_id}/{library_id}/{doc_id}/{block_id}.csv"
                                put_r2_text(table_csv_key, table_csv, content_type="text/csv; charset=utf-8")
                            if table_struct:
                                table_json_key = f"tables/{org_id}/{library_id}/{doc_id}/{block_id}.json"
                                put_r2_json(table_json_key, table_struct)

                    # Tiered OCR policy: decide later in a batched OCR pass (Surya GPU), not per-block.
                    full_process = block_id in full_process_ids
                    want_ocr = full_process and _should_full_ocr(kind, caption_text, table_text, table_csv)

                    # Keep crop in memory only when needed for OCR/Qwen or later processing.
                    if full_process:
                        crops_by_block_id[block_id] = crop
                    ocr_text = None
                    ocr_regions = None
                    ocr_boxes = None

                    if want_ocr:
                        ocr_full_tasks.append(
                            {
                                "block_id": block_id,
                                "kind": kind,
                                "crop": crop,
                                "doc_profile": doc_profile,
                            }
                        )

                    # Conservative baseline summary (before OCR/Qwen).
                    summary = _summarize_visual(kind=kind, caption_text=caption_text, ocr_text=None, table_text=table_text)

                    rec = {
                        "block_id": block_id,
                        "page": page_index,
                        "type": t,
                        "kind": kind,
                        "bbox_img": bbox_img,
                        "bbox_pdf": (list(bbox_pdf) if bbox_pdf is not None else None),
                        "visual_key": visual_key,
                        "caption_text": caption_text,
                        "caption_candidates": caption_debug,
                        "ocr_text": ocr_text,
                        "ocr_regions": ocr_regions,
                        "ocr_boxes": ocr_boxes,
                        "table_text": table_text,
                        "table_csv_key": table_csv_key,
                        "table_json_key": table_json_key,
                        "formula_tex_key": None,
                        "chart_json_key": None,
                        "related_text_blocks": related_text_blocks,
                        "nearby_mentions": nearby_mentions,
                        "table_csv_inline": table_csv,
                        "summary": summary,
                        "full_process": full_process,
                    }
                    out_blocks.append(rec)
                    blocks_by_id[block_id] = rec

            # ---- Batched OCR pass (GPU-friendly when using Surya) ----
            if ocr_full_tasks:
                # Chunk tasks to control memory spikes.
                for offset in range(0, len(ocr_full_tasks), ocr_batch):
                    chunk = ocr_full_tasks[offset : offset + ocr_batch]
                    imgs = [t["crop"] for t in chunk]
                    texts: List[Optional[str]] = []
                    if ocr_engine == "surya":
                        texts = _ocr_surya_batch(imgs)
                    else:
                        texts = [_ocr_image(im) for im in imgs]

                    for tsk, txt in zip(chunk, texts):
                        bid = tsk["block_id"]
                        rec = blocks_by_id.get(bid)
                        if not rec:
                            continue
                        rec["ocr_text"] = txt
                        if rec.get("kind") == "figure":
                            rec["ocr_regions"] = {"full": txt}

                        # OCR boxes are expensive; keep them only when useful.
                        want_boxes = (os.getenv("VIS_OCR_WITH_BOXES") or os.getenv("VIS_OCR_BOXES") or "0") in {
                            "1",
                            "true",
                            "yes",
                            "on",
                        }
                        if not want_boxes and (doc_profile == "scanned" or rec.get("kind") == "table"):
                            want_boxes = True
                        if want_boxes and ocr_engine in {"tesseract", ""}:
                            try:
                                rec["ocr_boxes"] = _ocr_boxes_tesseract(tsk["crop"])
                            except Exception:
                                rec["ocr_boxes"] = None

            # ---- Chart-region OCR pass (legend/axes) ----
            if chart_region_ocr:
                region_tasks: List[dict] = []
                policy = (os.getenv("VIS_CHART_REGION_OCR_POLICY") or "auto").strip().lower()
                for rec in out_blocks:
                    if not rec.get("full_process"):
                        continue
                    if rec.get("kind") != "figure":
                        continue
                    full = _clean_text(str(rec.get("ocr_text") or ""))
                    if policy == "auto" and len(full) >= chart_region_min_len:
                        continue
                    bid = rec.get("block_id")
                    crop = crops_by_block_id.get(str(bid)) if bid else None
                    if crop is None:
                        continue
                    # Sub-crops: legend/top-right, y-axis/left strip, x-axis/bottom strip
                    region_tasks.append({"block_id": bid, "region": "legend", "img": _crop_rel(crop, 0.55, 0.00, 1.00, 0.35)})
                    region_tasks.append({"block_id": bid, "region": "y_axis", "img": _crop_rel(crop, 0.00, 0.00, 0.28, 1.00)})
                    region_tasks.append({"block_id": bid, "region": "x_axis", "img": _crop_rel(crop, 0.00, 0.72, 1.00, 1.00)})

                for offset in range(0, len(region_tasks), ocr_batch):
                    chunk = region_tasks[offset : offset + ocr_batch]
                    imgs = [t["img"] for t in chunk]
                    if ocr_engine == "surya":
                        texts = _ocr_surya_batch(imgs)
                    else:
                        texts = [_ocr_image(im) for im in imgs]
                    for tsk, txt in zip(chunk, texts):
                        bid = str(tsk["block_id"])
                        rec = blocks_by_id.get(bid)
                        if not rec:
                            continue
                        regs = rec.get("ocr_regions") or {}
                        if not isinstance(regs, dict):
                            regs = {}
                        regs[str(tsk["region"])] = txt
                        rec["ocr_regions"] = regs

            # ---- Batched Qwen fallback (hard cases only) ----
            qwen_tasks: List[dict] = []
            qwen_task_ids: List[str] = []
            for rec in out_blocks:
                if not rec.get("full_process"):
                    continue
                kind = str(rec.get("kind") or "")
                cap = rec.get("caption_text")
                ocr_txt = rec.get("ocr_text")
                tcsv = rec.get("table_csv_inline")
                ttxt = rec.get("table_text")
                if not _needs_qwen(kind, cap, ocr_txt, tcsv, ttxt):
                    continue
                bid = str(rec.get("block_id"))
                crop = crops_by_block_id.get(bid)
                if not crop:
                    continue
                qwen_tasks.append(
                    {
                        "crop": crop,
                        "kind": kind,
                        "caption_text": cap,
                        "ocr_text": _clean_text(str(ocr_txt or "")) + ("\n" + _clean_text(str((rec.get("ocr_regions") or {}).get("legend") or "")) if kind == "figure" else ""),
                        "table_csv": tcsv,
                        "nearby_mentions": rec.get("nearby_mentions") or [],
                    }
                )
                qwen_task_ids.append(bid)

            if qwen_tasks:
                outs: List[Optional[dict]] = []
                for offset in range(0, len(qwen_tasks), qwen_batch):
                    outs.extend(_qwen_generate_batch(qwen_tasks[offset : offset + qwen_batch]))
                for bid, qobj in zip(qwen_task_ids, outs):
                    rec = blocks_by_id.get(bid)
                    if not rec:
                        continue
                    kind = str(rec.get("kind") or "")
                    caption_text = rec.get("caption_text")
                    ocr_text = rec.get("ocr_text")
                    table_text = rec.get("table_text")
                    base = _summarize_visual(kind=kind, caption_text=caption_text, ocr_text=ocr_text, table_text=table_text)
                    rec["summary"] = base

                    qwen_obj = qobj if isinstance(qobj, dict) else None
                    if qwen_obj:
                        rec["summary"] = {
                            "short_caption": _clean_text(str(qwen_obj.get("short_caption") or base.get("short_caption") or "")),
                            "bullets": qwen_obj.get("key_observations") or base.get("bullets") or [],
                            "confidence": float(qwen_obj.get("confidence") or base.get("confidence") or 0.5),
                            "sources_used": ["qwen"] + list(base.get("sources_used") or []),
                            "extracted_entities": qwen_obj.get("extracted_entities") or {},
                            "uncertainties": qwen_obj.get("uncertainties") or [],
                            "summary_source": "qwen",
                        }
                        if kind == "formula":
                            latex = qwen_obj.get("latex")
                            if latex:
                                rec["qwen_latex"] = latex

            # ---- Final per-block artifacts (formulas/charts) + final summary refresh ----
            for rec in out_blocks:
                kind = str(rec.get("kind") or "")
                block_id = str(rec.get("block_id") or "")
                page_index = int(rec.get("page") or 0)
                caption_text = rec.get("caption_text")
                ocr_text = rec.get("ocr_text")
                table_text = rec.get("table_text")
                table_csv = rec.get("table_csv_inline")

                # Refresh baseline summary if OCR arrived but Qwen didn't run.
                s0 = rec.get("summary") if isinstance(rec.get("summary"), dict) else {}
                if str(s0.get("summary_source") or "") != "qwen":
                    rec["summary"] = _summarize_visual(
                        kind=kind,
                        caption_text=caption_text,
                        ocr_text=ocr_text,
                        table_text=table_text,
                    )

                # Formula artifact (best-effort LaTeX/plaintext).
                if kind == "formula":
                    formula_tex_key = None
                    latex = rec.get("qwen_latex")
                    formula_text = _clean_text(str(latex or table_text or ocr_text or ""))
                    if formula_text:
                        formula_tex_key = f"formulas/{org_id}/{library_id}/{doc_id}/{block_id}.tex"
                        put_r2_text(formula_tex_key, formula_text, content_type="text/plain; charset=utf-8")
                    rec["formula_tex_key"] = formula_tex_key
                    rec.pop("qwen_latex", None)

                # Chart baseline artifact (labels + caption + entities). Numeric series extraction remains optional.
                if kind == "figure" and (os.getenv("VIS_CHART_ENGINE", "baseline").strip().lower() != "off"):
                    chart_json_key = f"charts/{org_id}/{library_id}/{doc_id}/{block_id}.json"
                    put_r2_json(
                        chart_json_key,
                        {
                            "engine": os.getenv("VIS_CHART_ENGINE", "baseline"),
                            "block_id": block_id,
                            "page": page_index,
                            "caption_text": caption_text,
                            "ocr_text": ocr_text,
                            "ocr_regions": rec.get("ocr_regions"),
                            "extracted_entities": (rec.get("summary") or {}).get("extracted_entities") if isinstance(rec.get("summary"), dict) else {},
                            "series": None,
                        },
                    )
                    rec["chart_json_key"] = chart_json_key

                # Cleanup internal-only fields (don’t store huge or redundant data in manifest).
                rec.pop("nearby_mentions", None)
                rec.pop("table_csv_inline", None)
                rec.pop("full_process", None)

            manifest_key = f"visuals_manifest/{org_id}/{library_id}/{doc_id}.json"
            payload = {
                "doc_id": doc_id,
                "library_id": library_id,
                "organization_id": org_id,
                "created_at": now_iso(),
                "layout_key": layout_key,
                "text_key": text_key,
                "source_pdf_key": pdf_key,
                "render_scale": render_scale,
                "stage": "image_captioning",
                "doc_profile": doc_profile,
                "blocks": out_blocks,
            }
            put_r2_json(manifest_key, payload)

            # Backwards compatible captions artifact (optional).
            if os.getenv("VIS_WRITE_LEGACY_CAPTIONS", "1") in {"1", "true", "yes", "on"}:
                out_key = f"captions/{org_id}/{library_id}/{doc_id}.json"
                put_r2_json(out_key, payload)

            current += 1
            if current % progress_every == 0:
                _sb_execute(
                    supabase.table("batch_stage_jobs").update({"progress_current": current, "progress_total": total}).eq(
                        "id", job_id
                    ),
                    context="batch_stage_jobs.update(progress)",
                )

        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "done", "finished_at": now_iso(), "progress_current": total, "progress_total": total}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(done)",
        )

        # Fan-in: only enqueue the next stage after both parallel extraction stages are done.
        _maybe_enqueue_next_after_parallel(org_id=org_id, library_id=library_id, batch_id=batch_id, progress_total=total)

        _update_library_progress(library_id, stage="image_captioning")
        _maybe_finalize_pipeline(library_id)

    except Exception as exc:
        from errors import friendly_error
        _sb_execute(
            supabase.table("batch_stage_jobs").update(
                {"status": "failed", "last_error": friendly_error(exc), "finished_at": now_iso()}
            ).eq("id", job_id),
            context="batch_stage_jobs.update(failed)",
        )
        _sb_execute(
            supabase.table("libraries").update(
                {
                    "pipeline_status": "failed",
                    "pipeline_stage": "image_captioning",
                    "pipeline_error": friendly_error(exc),
                    "status": "error",
                }
            ).eq("id", library_id),
            context="libraries.update(image_captioning.failed)",
        )
        _cancel_queued_stage_jobs_for_library(
            library_id,
            reason=f"Canceled due to failure in image_captioning: {str(exc)}",
            exclude_job_id=job_id,
        )
        raise


def worker_loop():
    idle = 0
    idle_limit = int(os.getenv("CAPTION_IDLE_LIMIT", "60"))
    print(f"[{WORKER_ID}] ready (idle_limit={idle_limit})")
    while True:
        job = claim_caption_stage_job(WORKER_ID)
        if not job:
            idle += 1
            if idle >= idle_limit:
                print("No caption jobs remaining. Exiting.")
                return
            time.sleep(2)
            continue
        idle = 0
        run_caption_stage_job(job)


if __name__ == "__main__":
    worker_loop()
