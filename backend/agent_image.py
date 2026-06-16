"""
backend/agent_image.py

Image generation for Agent mode using OpenAI's image tool (NOT Claude). Returns PNG bytes.

Config (env):
  OPENAI_API_KEY      required (the same key the chat/judge uses)
  AGENT_IMAGE_MODEL   default gpt-image-1  (set to dall-e-3 if your OpenAI org isn't verified for
                       gpt-image-1; dall-e-3 needs no verification)
  AGENT_IMAGE_SIZE    default 1024x1024
"""

from __future__ import annotations

import base64
import os
from typing import Optional


def image_model() -> str:
    return (os.getenv("AGENT_IMAGE_MODEL") or "gpt-image-1").strip() or "gpt-image-1"


# Default style nudge so diagrams/charts come out legible (white background, high contrast) rather
# than a dark theme. Override or clear with AGENT_IMAGE_PROMPT_SUFFIX (set to "" to disable).
_DEFAULT_STYLE = (
    " — clean, high-contrast illustration on a plain WHITE background, crisp and legible labels, "
    "no dark/black background"
)


def _styled(prompt: str) -> str:
    suffix = os.getenv("AGENT_IMAGE_PROMPT_SUFFIX", _DEFAULT_STYLE)
    p = (prompt or "").strip()
    if suffix and suffix.strip().lower() not in p.lower():
        p = f"{p}{suffix}"
    return p


def generate_image(prompt: str, *, size: Optional[str] = None) -> bytes:
    from openai import OpenAI

    key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY not set — image generation needs the OpenAI key.")
    p = (prompt or "").strip()
    if not p:
        raise RuntimeError("Empty image prompt.")

    client = OpenAI(api_key=key)
    model = image_model()
    sz = (size or os.getenv("AGENT_IMAGE_SIZE", "1024x1024")).strip() or "1024x1024"

    kwargs = {"model": model, "prompt": _styled(p)[:4000], "size": sz, "n": 1}
    # gpt-image-1 supports an explicit opaque (non-transparent) background.
    if model.startswith("gpt-image"):
        kwargs["background"] = os.getenv("AGENT_IMAGE_BACKGROUND", "opaque")
    # dall-e-* accepts response_format; gpt-image-1 always returns b64 and rejects the param.
    if model.startswith("dall-e"):
        kwargs["response_format"] = "b64_json"

    resp = client.images.generate(**kwargs)
    d = resp.data[0]
    b64 = getattr(d, "b64_json", None)
    if b64:
        return base64.b64decode(b64)
    url = getattr(d, "url", None)
    if url:
        import requests

        r = requests.get(url, timeout=60)
        r.raise_for_status()
        return r.content
    raise RuntimeError("Image API returned no image data.")
