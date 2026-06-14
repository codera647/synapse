"""
backend/pipeline_config.py

Single source of truth for the preprocessing pipeline's stage list, the parallel
extraction stages, and the progress weighting. Previously each worker module defined
its own ``_pipeline_stages()`` with a DIFFERENT default (sync/layout/embed used a
6-stage list; cluster_worker used a 7-stage list that included ``clustering``). That
mismatch meant that when ``PIPELINE_STAGES`` wasn't set, modules disagreed about what
"the last stage" was — embed_worker would defer finalization to a clustering stage the
other modules didn't know about, leaving libraries stuck below 100%.

All workers + the HTTP API now import from here so they agree.

Canonical pipeline (clustering IS part of the pipeline; it powers cluster-routed
retrieval and is the finalizer). Override via the ``PIPELINE_STAGES`` env var.
"""

from __future__ import annotations

import os
from typing import Dict, List, Tuple

DEFAULT_PIPELINE_STAGES = (
    "sync,layout_parser,text_extraction,image_captioning,chunking,embedding,clustering"
)
DEFAULT_PARALLEL_EXTRACTION_STAGES = "text_extraction,image_captioning"

# Relative weight of each stage for the single progress bar. Captioning + extraction are
# the heavy stages; clustering is light. Weights are renormalized across whatever stages
# are actually active so the bar always ends at exactly 100.
_CANON_WEIGHTS: Dict[str, int] = {
    "sync": 15,
    "layout_parser": 15,
    "text_extraction": 20,
    "image_captioning": 15,
    "chunking": 13,
    "embedding": 14,
    "clustering": 8,
}


def pipeline_stages() -> List[str]:
    """The ordered list of pipeline stages. Override with PIPELINE_STAGES env."""
    raw = os.getenv("PIPELINE_STAGES", DEFAULT_PIPELINE_STAGES)
    stages = [s.strip() for s in raw.split(",") if s.strip()]
    return stages or ["sync"]


def parallel_extraction_stages() -> List[str]:
    """Stages that run in parallel after layout (text_extraction + image_captioning)."""
    raw = os.getenv("EXTRACTION_PARALLEL_STAGES", DEFAULT_PARALLEL_EXTRACTION_STAGES)
    return [s.strip() for s in raw.split(",") if s.strip()]


def stage_ranges() -> List[Tuple[str, float, float]]:
    """Contiguous (stage, lo, hi) progress bands for the ACTIVE stages, ending at 100."""
    active = pipeline_stages()
    weights = [(s, _CANON_WEIGHTS.get(s, 10)) for s in active]
    total = sum(w for _, w in weights) or 1
    ranges: List[Tuple[str, float, float]] = []
    acc = 0.0
    for s, w in weights:
        lo = acc / total * 100.0
        acc += w
        hi = acc / total * 100.0
        ranges.append((s, round(lo, 2), round(hi, 2)))
    if ranges:  # guarantee the last active stage closes exactly at 100
        s, lo, _ = ranges[-1]
        ranges[-1] = (s, lo, 100.0)
    return ranges


def final_stage() -> str:
    """The terminal stage — its worker finalizes the library to completed/100%."""
    stages = pipeline_stages()
    return stages[-1] if stages else "embedding"
