"""
backend/scripts/preload_models.py

Download + warm the ML models into the HuggingFace cache (HF_HOME) BEFORE serving
traffic, so the first real request doesn't stall on multi-GB downloads. Run this
once after deploy (and after changing any model env var).

On a GPU host this also confirms CUDA is visible and the models load on-device.

Run (from the backend/ directory, with the venv + GPU deps installed):
  python scripts/preload_models.py

Honors the same env vars the workers use:
  EMBED_MODEL, EMBED_DEVICE, VIS_QWEN_MODEL, DOCLAYOUT_YOLO_REPO, DOCLAYOUT_YOLO_FILENAME
Skip individual models with:
  PRELOAD_EMBED=0 / PRELOAD_QWEN=0 / PRELOAD_LAYOUT=0 / PRELOAD_SURYA=0
"""

import os
import sys

# Ensure we can import the backend modules + trigger HF_HOME setup from config.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from config import CONFIG  # noqa: F401  (import sets HF_HOME)
    print(f"[preload] HF cache: {CONFIG.hf_home}")
except Exception as exc:
    print(f"[preload] WARNING: could not import config ({exc}); continuing.")


def _enabled(name: str) -> bool:
    return (os.getenv(name, "1") or "").strip().lower() in {"1", "true", "yes", "on"}


def _report_gpu():
    try:
        import torch

        if torch.cuda.is_available():
            print(f"[preload] GPU: {torch.cuda.get_device_name(0)}")
        else:
            print("[preload] GPU: none (CPU mode) — fine for embeddings, slow for VLM/OCR.")
    except Exception:
        print("[preload] torch not installed yet (GPU deps missing).")


def preload_embed():
    if not _enabled("PRELOAD_EMBED"):
        return
    model_id = os.getenv("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    print(f"[preload] embedder: {model_id} ...")
    try:
        from sentence_transformers import SentenceTransformer

        device = os.getenv("EMBED_DEVICE", "").strip() or None
        m = SentenceTransformer(model_id, device=device)
        m.encode(["warmup"], normalize_embeddings=True, show_progress_bar=False)
        print("[preload] embedder OK")
    except Exception as exc:
        print(f"[preload] embedder FAILED: {exc}")


def preload_qwen():
    if not _enabled("PRELOAD_QWEN"):
        return
    model_id = os.getenv("VIS_QWEN_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
    print(f"[preload] vision-language (captioning): {model_id} ...")
    try:
        from transformers import AutoProcessor

        AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        # Pull weights into cache (load is the expensive part; device placement is
        # exercised at first real use to keep this script light on VRAM).
        from huggingface_hub import snapshot_download

        snapshot_download(model_id)
        print("[preload] VLM weights cached OK")
    except Exception as exc:
        print(f"[preload] VLM FAILED: {exc}")


def preload_layout():
    if not _enabled("PRELOAD_LAYOUT"):
        return
    repo = os.getenv("DOCLAYOUT_YOLO_REPO", "juliozhao/DocLayout-YOLO-DocStructBench")
    filename = os.getenv("DOCLAYOUT_YOLO_FILENAME", "doclayout_yolo_docstructbench_imgsz1024.pt")
    print(f"[preload] layout model: {repo}/{filename} ...")
    try:
        from huggingface_hub import hf_hub_download

        hf_hub_download(repo_id=repo, filename=filename)
        print("[preload] layout model OK")
    except Exception as exc:
        print(f"[preload] layout FAILED: {exc}")


def preload_surya():
    if not _enabled("PRELOAD_SURYA"):
        return
    print("[preload] surya OCR ...")
    try:
        import surya  # noqa: F401

        # Surya lazily downloads its sub-models on first run; importing confirms install.
        print("[preload] surya import OK (models download on first OCR call)")
    except Exception as exc:
        print(f"[preload] surya not available (optional): {exc}")


def main():
    _report_gpu()
    preload_embed()
    preload_layout()
    preload_qwen()
    preload_surya()
    print("[preload] done.")


if __name__ == "__main__":
    main()
