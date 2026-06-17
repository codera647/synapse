"""
backend/kg_extract.py

LLM entity + relation extraction for knowledge graphs. For a chunk of text, return the entities and
the (subject, relation, object) triples it contains, as STRICT JSON.

Config (env):
  KG_EXTRACT_MODEL   default gpt-4o-mini (cheap, fine for high-volume extraction). Use a stronger
                     model for higher-quality graphs.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

from chat_agents import _json_object
from llm_compat import completion_kwargs

_client = None


def _get_client():
    global _client
    if _client is None:
        from openai import OpenAI
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


def extract_model() -> str:
    return (os.getenv("KG_EXTRACT_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"


_SYSTEM = (
    "You extract a knowledge graph from a document passage. Return STRICT JSON:\n"
    '{ "entities": [ {"name": string, "type": string, "description": string} ],\n'
    '  "relations": [ {"source": string, "relation": string, "target": string, "description": string} ] }\n\n'
    "RULES:\n"
    "- entities: the KEY named things in the passage — people, organizations, systems/products, "
    "methods/techniques, concepts, places, metrics. Use the canonical surface form. type = a short "
    "category (e.g. person, organization, concept, method, system, metric, place).\n"
    "- relations: meaningful links BETWEEN entities you listed; `relation` is a short verb phrase "
    "(e.g. 'uses', 'part of', 'developed by', 'compared with', 'causes'). Both source and target MUST "
    "be entity names from your `entities` list.\n"
    "- Extract only what the passage actually supports. Do NOT invent. If there are no clear entities, "
    "return empty lists. Keep descriptions to one short sentence."
)


def extract_triples(text: str) -> Dict[str, List[Dict[str, Any]]]:
    t = (text or "").strip()
    if len(t) < 30:
        return {"entities": [], "relations": []}
    client = _get_client()
    model = extract_model()
    try:
        out = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": t[:6000]}],
            **completion_kwargs(model, max_tokens=1400, temperature=0.1),
        )
        obj = _json_object(out.choices[0].message.content or "")
    except Exception as exc:
        return {"entities": [], "relations": [], "error": str(exc)}  # type: ignore[dict-item]
    ents = obj.get("entities") if isinstance(obj.get("entities"), list) else []
    rels = obj.get("relations") if isinstance(obj.get("relations"), list) else []
    return {"entities": ents, "relations": rels}
