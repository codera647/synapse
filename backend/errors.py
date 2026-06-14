"""
backend/errors.py

Turn raw worker exceptions into short, user-friendly pipeline error messages, and free GPU
memory on OOM so the retry has a chance to succeed. Workers store the result in
batch_stage_jobs.last_error and libraries.pipeline_error, which the UI shows on the library
card/drawer. Every message tells the user the recovery path (Resume keeps finished stages).
"""

from __future__ import annotations


def free_gpu() -> None:
    """Best-effort release of cached CUDA memory (helps a retry after OOM)."""
    try:
        import gc

        gc.collect()
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def is_oom(exc: BaseException) -> bool:
    s = (str(exc) or repr(exc)).lower()
    return ("out of memory" in s) or ("cuda oom" in s) or ("outofmemory" in s)


def friendly_error(exc: BaseException) -> str:
    """Map an exception to a concise, user-facing message with the recovery hint."""
    s = (str(exc) or repr(exc)).strip()
    low = s.lower()

    if is_oom(exc):
        free_gpu()
        return (
            "Ran out of GPU memory on this stage. Lower the number of workers for it in "
            "Settings → Processing, then click Resume — already-finished stages are kept."
        )
    if any(k in low for k in ("cuda error", "cublas", "cudnn", "device-side assert", "no kernel image")):
        free_gpu()
        return "A GPU error interrupted this stage. Click Resume to retry — finished stages are kept."
    if any(k in low for k in ("rate limit", "rate-limit", "429", "quota", "insufficient_quota", "overloaded")):
        return "The AI service was rate-limited or out of quota. Wait a moment, then click Resume to retry."
    if any(k in low for k in ("timeout", "timed out", "read timed out", "connection", "econnreset", "502", "503", "temporarily unavailable")):
        return "A network/service timeout interrupted this stage. Click Resume to retry."
    if any(k in low for k in ("api key", "unauthorized", "401", "invalid_api_key", "authentication")):
        return "An API key was missing or invalid for this stage. Check the backend env, then Resume."
    if "no embeddings" in low or "cannot cluster" in low:
        return "No embeddings were produced, so this stage couldn't run. Check the document, then Resume."

    # Generic: keep the first line, trimmed, plus the recovery hint.
    first = (s.splitlines()[0] if s else "Unknown error")[:240]
    return f"Processing failed: {first}. Click Resume to retry — finished stages are kept."
