"""
backend/agent_llm.py

The single LLM entry point for Agent mode. Targets Claude Opus via OpenRouter (OpenAI-compatible),
mirroring vlm_client.py's base_url shim. Isolated here so the agent can later swap to the direct
Anthropic SDK without touching the orchestration in agent_api.py.

Config (env):
  AGENT_BASE_URL   default https://openrouter.ai/api/v1
  AGENT_API_KEY    Claude/OpenRouter key (falls back to OPENROUTER_API_KEY / CAPTION_VLM_API_KEY)
  AGENT_MODEL      default anthropic/claude-opus-4.7  (set to your exact OpenRouter model id)
  AGENT_RETRIES / AGENT_RETRY_BASE / AGENT_TIMEOUT
"""

from __future__ import annotations

import os
import random
import time
from typing import Any, Dict, List, Optional

# Reuse the transient-error classifier + JSON salvage parser already used by the chat stack.
from vlm_client import _is_transient  # ssl/eof/connection/timeout/5xx/429 keywords
from chat_agents import _json_object, _clean_model_id

_DEFAULT_BASE = "https://openrouter.ai/api/v1"
_DEFAULT_MODEL = "anthropic/claude-opus-4.7"

# thinking_mode -> (max_tokens, temperature). Planning/specs want determinism; narrative a touch more.
_MODES = {
    "low": (1500, 0.2),
    "medium": (3200, 0.3),
    "high": (6000, 0.4),
}


def _cfg():
    base = (os.getenv("AGENT_BASE_URL") or _DEFAULT_BASE).strip() or _DEFAULT_BASE
    key = (
        os.getenv("AGENT_API_KEY")
        or os.getenv("OPENROUTER_API_KEY")
        or os.getenv("CAPTION_VLM_API_KEY")
        or ""
    ).strip()
    model = _clean_model_id(os.getenv("AGENT_MODEL"), _DEFAULT_MODEL)
    return base, key, model


def agent_model() -> str:
    return _cfg()[2]


def is_configured() -> bool:
    return bool(_cfg()[1])


_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    from openai import OpenAI

    base, key, _ = _cfg()
    if not key:
        raise RuntimeError("Agent LLM not configured: set AGENT_API_KEY (or OPENROUTER_API_KEY).")
    _client = OpenAI(base_url=base, api_key=key)
    return _client


def _mode_params(mode: Optional[str], max_tokens: Optional[int], temperature: Optional[float]):
    mt, temp = _MODES.get((mode or "medium").lower(), _MODES["medium"])
    return (int(max_tokens) if max_tokens else mt, float(temperature) if temperature is not None else temp)


def _build_messages(system: str, user: str, history: Optional[List[Dict[str, str]]]) -> List[Dict[str, str]]:
    msgs: List[Dict[str, str]] = [{"role": "system", "content": system}]
    for h in history or []:
        role = str(h.get("role") or "")
        content = str(h.get("content") or "")
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user})
    return msgs


def _complete(messages: List[Dict[str, str]], max_tokens: int, temperature: float) -> str:
    client = _get_client()
    _, _, model = _cfg()
    extra_headers: Dict[str, str] = {}
    ref = (os.getenv("AGENT_REFERER") or os.getenv("CAPTION_VLM_REFERER") or "").strip()
    if ref:
        extra_headers["HTTP-Referer"] = ref
    extra_headers["X-Title"] = (os.getenv("AGENT_TITLE") or "Synapse Agent").strip()

    attempts = max(1, int(os.getenv("AGENT_RETRIES", "4")))
    base_sleep = float(os.getenv("AGENT_RETRY_BASE", "1.5"))
    timeout_s = float(os.getenv("AGENT_TIMEOUT", "180"))
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
            print(f"[agent-llm] transient error (attempt {i + 1}/{attempts}), retrying in {sleep_s:.1f}s: {exc}")
            time.sleep(sleep_s)
    if last_exc:
        raise last_exc
    return ""


def agent_complete_text(
    system: str,
    user: str,
    *,
    mode: str = "medium",
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    history: Optional[List[Dict[str, str]]] = None,
) -> str:
    mt, temp = _mode_params(mode, max_tokens, temperature)
    return _complete(_build_messages(system, user, history), mt, temp)


def agent_complete_json(
    system: str,
    user: str,
    *,
    mode: str = "medium",
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Structured call: append a 'return STRICT JSON' nudge, parse with the shared salvage parser.
    Returns {} on unparseable output (callers supply safe defaults)."""
    sys2 = system.rstrip() + "\n\nReturn ONLY a single valid JSON object. No prose, no code fences."
    mt, temp = _mode_params(mode, max_tokens, temperature)
    raw = _complete(_build_messages(sys2, user, history), mt, temp)
    return _json_object(raw)
