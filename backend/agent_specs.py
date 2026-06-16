"""
backend/agent_specs.py

Validate, bind data into, and render the visual specs the agent produces.

- Data charts: Vega-Lite v5 JSON. The MODEL never emits data values — it emits the spec with empty
  data + a data_binding ({x_field,y_field,series_field}); we bind the real series in code (the single
  biggest safeguard against unrenderable specs) and render a PNG with vl-convert (no browser).
- Diagrams: Mermaid text. Light validation only; rendering is client-side.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

_MAX_SPEC_BYTES = 100_000
_MAX_MERMAID_CHARS = 20_000
_MERMAID_KEYWORDS = (
    "flowchart", "graph", "sequencediagram", "classdiagram", "statediagram",
    "erdiagram", "gantt", "pie", "mindmap", "journey",
)


# ── Vega-Lite ───────────────────────────────────────────────────────────────────────────────
def _collect_fields(node: Any, out: set) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "field" and isinstance(v, str):
                out.add(v)
            else:
                _collect_fields(v, out)
    elif isinstance(node, list):
        for v in node:
            _collect_fields(v, out)


def _has_remote_data(spec: Dict[str, Any]) -> bool:
    """Reject specs that try to load external data (security + reliability — we bind data ourselves)."""
    found = {"hit": False}

    def walk(n: Any):
        if found["hit"]:
            return
        if isinstance(n, dict):
            if isinstance(n.get("data"), dict) and ("url" in n["data"]):
                found["hit"] = True
                return
            if "loader" in n:
                found["hit"] = True
                return
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)

    walk(spec)
    return found["hit"]


def validate_vega(spec: Any, columns: List[str]) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    if not isinstance(spec, dict):
        return False, ["spec is not a JSON object"]
    try:
        size = len(json.dumps(spec).encode("utf-8"))
    except Exception:
        return False, ["spec is not JSON-serializable"]
    if size > _MAX_SPEC_BYTES:
        return False, [f"spec too large ({size} bytes)"]
    if _has_remote_data(spec):
        errors.append("remote data (data.url / loader) is not allowed")
    if not any(k in spec for k in ("mark", "layer", "facet", "concat", "hconcat", "vconcat", "repeat")):
        errors.append("missing a top-level 'mark' (or layer/facet/concat)")
    fields: set = set()
    _collect_fields(spec.get("encoding", {}), fields)
    _collect_fields(spec.get("layer", []), fields)
    colset = set(columns)
    for f in fields:
        if f not in colset:
            errors.append(f"encoding field '{f}' is not in the available columns {columns}")
    return (len(errors) == 0), errors


def bind_data(spec: Dict[str, Any], series: Dict[str, List[Any]],
              data_binding: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Construct data.values from the real series for every field the spec references."""
    fields: set = set()
    _collect_fields(spec.get("encoding", {}), fields)
    _collect_fields(spec.get("layer", []), fields)
    if data_binding:
        for k in ("x_field", "y_field", "series_field", "color_field", "theta_field"):
            v = data_binding.get(k)
            if isinstance(v, str) and v:
                fields.add(v)
    fields = {f for f in fields if f in series}
    if not fields:
        fields = set(series.keys())
    n = max((len(series[f]) for f in fields), default=0)
    values = []
    for i in range(n):
        row = {}
        for f in fields:
            col = series.get(f, [])
            row[f] = col[i] if i < len(col) else None
        values.append(row)
    out = dict(spec)
    out["data"] = {"values": values}
    out.setdefault("$schema", "https://vega.github.io/schema/vega-lite/v5.json")
    return out


def render_vega_png(spec_with_data: Dict[str, Any], scale: float = 2.0) -> Optional[bytes]:
    """Render a Vega-Lite spec to PNG via vl-convert (no browser). Returns None if vl-convert is
    unavailable so the run degrades to interactive-only rather than failing."""
    try:
        import vl_convert as vlc  # type: ignore
    except Exception as exc:  # pragma: no cover
        print(f"[agent-specs] vl-convert unavailable, skipping PNG render: {exc}")
        return None
    try:
        return vlc.vegalite_to_png(json.dumps(spec_with_data), scale=scale)
    except Exception as exc:
        print(f"[agent-specs] vl-convert render failed: {exc}")
        return None


# ── Mermaid ─────────────────────────────────────────────────────────────────────────────────
def validate_mermaid(text: str) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    t = (text or "").strip()
    if not t:
        return False, ["empty diagram"]
    if len(t) > _MAX_MERMAID_CHARS:
        return False, [f"diagram too long ({len(t)} chars)"]
    first = t.lower().split()[0] if t.split() else ""
    if not any(first.startswith(k) for k in _MERMAID_KEYWORDS):
        errors.append(f"must start with a Mermaid diagram keyword (got '{first}')")
    if "<script" in t.lower() or "</script" in t.lower():
        errors.append("HTML/script content is not allowed")
    if t.count("[") != t.count("]") or t.count("(") != t.count(")") or t.count("{") != t.count("}"):
        errors.append("unbalanced brackets")
    return (len(errors) == 0), errors
