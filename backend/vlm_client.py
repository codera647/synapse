"""
backend/vlm_client.py

Hosted vision-language model client (OpenAI-compatible). Default provider = OpenRouter
with Qwen2.5-VL-72B — far stronger than the local Qwen2-VL-2B, and it runs off the GPU,
freeing the L4's biggest consumer (captioning).

Two jobs:
  - describe_visual(): one structured call per cropped figure/table/chart/formula. Returns a
    dict whose keys are a SUPERSET of the local Qwen output (short_caption, key_observations,
    extracted_entities, uncertainties, confidence) plus table_markdown / formula_latex /
    chart_summary, so it's a drop-in for caption_worker._qwen_generate_batch.
  - transcribe_page() / ocr_image(): VLM OCR for scanned / multi-column pages (correct reading
    order), replacing Surya/Tesseract/GLM on the pages that need it.

Config (env):
  CAPTION_VLM_BASE_URL   default https://openrouter.ai/api/v1
  CAPTION_VLM_API_KEY    required (key lives in git-ignored api-open-router.txt -> set as env)
  CAPTION_VLM_MODEL      default qwen/qwen2.5-vl-72b-instruct
  CAPTION_VLM_MAX_TOKENS / CAPTION_VLM_OCR_MAX_TOKENS / CAPTION_VLM_JPEG_Q
"""

from __future__ import annotations

import base64
import io
import json
import os
import random
import time
from typing import Any, Dict, List, Optional


def _is_transient(exc: Exception) -> bool:
    """Network/server hiccups worth retrying (OpenRouter drops connections under load)."""
    m = (str(exc) or "").lower()
    keys = (
        "ssl", "eof", "unexpected_eof", "connection", "connect", "timed out", "timeout",
        "reset", "aborted", "remotedisconnected", "incompleteread", "protocol", "broken pipe",
        "temporarily", "overloaded", "rate limit", "429", "500", "502", "503", "504", "gateway",
    )
    return any(k in m for k in keys)

_DEFAULT_BASE = "https://openrouter.ai/api/v1"
_DEFAULT_MODEL = "qwen/qwen2.5-vl-72b-instruct"


def _cfg():
    base = (os.getenv("CAPTION_VLM_BASE_URL") or _DEFAULT_BASE).strip() or _DEFAULT_BASE
    key = (os.getenv("CAPTION_VLM_API_KEY") or os.getenv("OPENROUTER_API_KEY") or "").strip()
    model = (os.getenv("CAPTION_VLM_MODEL") or _DEFAULT_MODEL).strip() or _DEFAULT_MODEL
    return base, key, model


def is_configured() -> bool:
    """True only if an API key is present — callers fall back to local models otherwise."""
    _, key, _ = _cfg()
    return bool(key)


_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    from openai import OpenAI

    base, key, _ = _cfg()
    _client = OpenAI(base_url=base, api_key=key)
    return _client


def _img_to_data_url(img) -> str:
    """PIL.Image -> base64 data URL (JPEG to keep payloads small)."""
    buf = io.BytesIO()
    rgb = img if getattr(img, "mode", "RGB") == "RGB" else img.convert("RGB")
    rgb.save(buf, format="JPEG", quality=int(os.getenv("CAPTION_VLM_JPEG_Q", "85")))
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _chat(messages: List[dict], max_tokens: int, temperature: float = 0.1) -> str:
    client = _get_client()
    _, _, model = _cfg()
    extra_headers: Dict[str, str] = {}
    ref = (os.getenv("CAPTION_VLM_REFERER") or "").strip()
    if ref:
        extra_headers["HTTP-Referer"] = ref
    title = (os.getenv("CAPTION_VLM_TITLE") or "Synapse").strip()
    if title:
        extra_headers["X-Title"] = title

    attempts = max(1, int(os.getenv("CAPTION_VLM_RETRIES", "5")))
    base_sleep = float(os.getenv("CAPTION_VLM_RETRY_BASE", "1.5"))
    timeout_s = float(os.getenv("CAPTION_VLM_TIMEOUT", "120"))
    last_exc: Optional[Exception] = None
    for i in range(attempts):
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                extra_headers=extra_headers or None,
                timeout=timeout_s,
            )
            return (resp.choices[0].message.content or "").strip()
        except Exception as exc:
            last_exc = exc
            if not _is_transient(exc) or i == attempts - 1:
                raise
            sleep_s = min(30.0, base_sleep * (2 ** i)) * (0.8 + random.random() * 0.4)
            print(f"[vlm] transient error (attempt {i + 1}/{attempts}), retrying in {sleep_s:.1f}s: {exc}")
            time.sleep(sleep_s)
    if last_exc:
        raise last_exc
    return ""


def _extract_json(s: str) -> Optional[dict]:
    s = (s or "").strip()
    if s.startswith("```"):
        s = s.strip("`")
        nl = s.find("\n")
        if nl != -1 and s[:nl].strip().lower() in {"json", ""}:
            s = s[nl + 1 :]
    a, b = s.find("{"), s.rfind("}")
    if a != -1 and b > a:
        try:
            return json.loads(s[a : b + 1])
        except Exception:
            return None
    return None


_VISUAL_PROMPT = (
    "You are analyzing a SINGLE visual (figure, table, chart, or formula) cropped from a "
    "document. Return ONLY a JSON object with these keys:\n"
    '  "short_caption": one concise sentence describing what it shows.\n'
    '  "key_observations": array of 2-6 short factual bullets grounded in the image.\n'
    '  "extracted_entities": object mapping notable labels/axes/units/totals -> value.\n'
    '  "table_markdown": if it is a TABLE, the full table as GitHub-flavored markdown; else null.\n'
    '  "formula_latex": if it is a FORMULA/equation, the LaTeX; else null.\n'
    '  "chart_summary": if it is a CHART/plot, one sentence on the trend/comparison; else null.\n'
    '  "uncertainties": array of short strings for anything unclear.\n'
    '  "confidence": number between 0 and 1.\n'
    "Be faithful to the image; never invent numbers. Output JSON only."
)


def describe_visual(
    crop,
    kind: str = "",
    caption_text: Optional[str] = None,
    ocr_text: Optional[str] = None,
    table_csv: Optional[str] = None,
    nearby_mentions: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    """Structured description of one cropped visual (PIL.Image). Returns a dict compatible with
    the local Qwen output plus table_markdown/formula_latex/chart_summary. None on failure."""
    if not is_configured() or crop is None:
        return None
    ctx = {
        "kind": kind or "unknown",
        "pdf_caption": caption_text or None,
        "ocr_text": (ocr_text or "")[:1500] or None,
        "table_text_csv": (table_csv or "")[:2000] or None,
        "nearby_mentions": (nearby_mentions or [])[:5],
    }
    try:
        content = [
            {"type": "text", "text": _VISUAL_PROMPT + "\n\nCONTEXT (optional hints): " + json.dumps(ctx, ensure_ascii=True)},
            {"type": "image_url", "image_url": {"url": _img_to_data_url(crop)}},
        ]
        out = _chat([{"role": "user", "content": content}], max_tokens=int(os.getenv("CAPTION_VLM_MAX_TOKENS", "700")))
        obj = _extract_json(out)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


_OCR_PROMPT = (
    "Transcribe ALL readable text from this document page image, preserving reading order. "
    "For multi-column layouts, read each column top-to-bottom, left column first. Output the "
    "plain text only, with no commentary. If there is no text, output nothing."
)

# Full-page prompt for scanned/image documents: capture EVERYTHING (body text + tables + figures)
# so no answer-relevant information is lost when this becomes the page's chunkable text.
_PAGE_PROMPT = (
    "You are transcribing ONE page of a document (an image) for a search/retrieval system. "
    "Reproduce ALL information on the page so nothing is lost. Rules:\n"
    "1. Transcribe ALL text VERBATIM in natural reading order. For multi-column layouts, read the "
    "left column top-to-bottom first, then the next column.\n"
    "2. Render EVERY table as GitHub-flavored Markdown with the real cell values — keep all rows and "
    "columns; do not abbreviate.\n"
    "3. For EVERY figure, chart, graph, diagram or image, add a line beginning with '[FIGURE] ' that "
    "describes what it shows AND extracts its data: title, axis labels, legend, series names, numeric "
    "values, and any text inside it.\n"
    "4. Do NOT summarize, omit, translate, or invent anything. Output only the page content, no "
    "commentary. If the page is blank, output nothing."
)


def transcribe_page(img) -> Optional[str]:
    """Full-page transcription via the VLM for scanned/image pages — captures body text, tables
    (as Markdown), and figures (described + data extracted). Handles multi-column reading order.

    NOTE: this propagates a hard failure (e.g., out of OpenRouter credits / persistent network after
    retries) so the EXTRACTION stage fails loudly instead of silently producing an empty doc. The
    caller decides what to do."""
    if not is_configured() or img is None:
        return None
    content = [
        {"type": "text", "text": _PAGE_PROMPT},
        {"type": "image_url", "image_url": {"url": _img_to_data_url(img)}},
    ]
    return _chat([{"role": "user", "content": content}], max_tokens=int(os.getenv("CAPTION_VLM_PAGE_MAX_TOKENS", "3000")))


def is_out_of_credits(exc: Exception) -> bool:
    m = (str(exc) or "").lower()
    return any(k in m for k in ("insufficient", "credit", "402", "payment", "quota", "billing"))


def ocr_image(crop) -> Optional[str]:
    """OCR a cropped region via the VLM (drop-in for caption_worker._ocr_image)."""
    if not is_configured() or crop is None:
        return None
    try:
        content = [
            {"type": "text", "text": "Transcribe all text visible in this image. Output plain text only."},
            {"type": "image_url", "image_url": {"url": _img_to_data_url(crop)}},
        ]
        return _chat([{"role": "user", "content": content}], max_tokens=int(os.getenv("CAPTION_VLM_OCR_MAX_TOKENS", "1800")))
    except Exception:
        return None
