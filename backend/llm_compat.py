"""
backend/llm_compat.py

OpenAI chat-completion parameter compatibility across model families.

GPT-5 / o-series models require `max_completion_tokens` (they REJECT `max_tokens`) and only
support the default temperature. Older models (gpt-4o, gpt-4, gpt-3.5) use `max_tokens` +
`temperature`. Centralizing the branch here keeps every call site a one-liner:

    out = client.chat.completions.create(
        model=model, messages=msgs, **completion_kwargs(model, max_tokens=800, temperature=0.2)
    )

NOTE: only for OpenAI models. The OpenRouter Qwen captioner (vlm_client.py) uses standard
`max_tokens` and is intentionally NOT routed through here.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


def _is_new_family(model: Optional[str]) -> bool:
    m = (model or "").lower()
    return m.startswith("gpt-5") or m.startswith("o1") or m.startswith("o3") or m.startswith("o4")


def completion_kwargs(
    model: Optional[str],
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
) -> Dict[str, Any]:
    kw: Dict[str, Any] = {}
    if _is_new_family(model):
        if max_tokens is not None:
            kw["max_completion_tokens"] = int(max_tokens)
        # GPT-5 / o-series only allow the default temperature -> omit any custom value.
    else:
        if max_tokens is not None:
            kw["max_tokens"] = int(max_tokens)
        if temperature is not None:
            kw["temperature"] = temperature
    return kw
