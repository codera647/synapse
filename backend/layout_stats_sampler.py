#!/usr/bin/env python3
"""
Layout stats sampler for a PDF folder.

Purpose
-------
Given a folder of PDFs (e.g. a training corpus), sample N PDFs and run
DocLayout-YOLO on the first K pages of each PDF. Produce:
- avg Figure/Table blocks per paper (on sampled pages)
- bbox crop size distribution in pixels (at render scale)
- CSV output for deeper analysis

This is meant to run in Colab/RunPod where torch + doclayout_yolo are available.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple

import fitz  # PyMuPDF
from PIL import Image


@dataclass
class PdfStats:
    pdf: str
    pages_total: int
    pages_sampled: int
    blocks_total: int
    figure_blocks: int
    table_blocks: int
    other_blocks: int
    bbox_w_px_mean: float | None
    bbox_h_px_mean: float | None
    bbox_area_mpx_mean: float | None


def _pct(xs: List[float], p: float) -> float | None:
    if not xs:
        return None
    xs2 = sorted(xs)
    k = (len(xs2) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(xs2) - 1)
    if f == c:
        return float(xs2[f])
    return float(xs2[f] + (xs2[c] - xs2[f]) * (k - f))


def _safe_mean(xs: List[float]) -> float | None:
    return float(statistics.mean(xs)) if xs else None


def _label_of(names: Any, cls_id: int) -> str:
    if isinstance(names, dict):
        return str(names.get(cls_id, cls_id))
    return str(cls_id)


def _norm_label(label: str) -> str:
    return (label or "").strip().lower()


def _is_figure(label: str) -> bool:
    l = _norm_label(label)
    return l == "figure" or "figure" in l or l in ("fig", "image", "picture", "photo")


def _is_table(label: str) -> bool:
    l = _norm_label(label)
    return l == "table" or "table" in l


def _render_pages_to_pngs(pdf_path: Path, pages_per_pdf: int, render_scale: float, tmpdir: Path) -> List[Tuple[int, str]]:
    doc = fitz.open(pdf_path)
    n = min(doc.page_count, pages_per_pdf)
    out: List[Tuple[int, str]] = []
    try:
        for i in range(n):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale))
            img = Image.open(pix.tobytes("png"))
            p = tmpdir / f"page_{i}.png"
            img.save(p)
            out.append((i, str(p)))
    finally:
        doc.close()
    return out


def _load_yolo(weights: str, device: str):
    try:
        from doclayout_yolo import YOLOv10
    except Exception as e:
        raise RuntimeError(
            "doclayout_yolo is not installed in this environment. "
            "Run this script in Colab/RunPod where your pipeline deps are installed. "
            f"Import error: {type(e).__name__}: {e}"
        )
    return YOLOv10(weights)


def _download_weights(repo_id: str, filename: str) -> str:
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=repo_id, filename=filename)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", required=True, help="Folder containing PDFs")
    ap.add_argument("--sample-n", type=int, default=50, help="How many PDFs to sample")
    ap.add_argument("--pages-per-pdf", type=int, default=3, help="How many pages per PDF to run layout on")
    ap.add_argument("--render-scale", type=float, default=2.0, help="Render scale (e.g. 2.0 matches Matrix(2,2))")
    ap.add_argument("--imgsz", type=int, default=768)
    ap.add_argument("--conf", type=float, default=0.2)
    ap.add_argument("--batch-pages", type=int, default=4)
    ap.add_argument("--half", type=int, default=1, help="Use fp16 if supported (1/0)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--output-csv", default="layout_stats_sample.csv")
    ap.add_argument("--output-json", default="layout_stats_summary.json")
    ap.add_argument("--repo-id", default="juliozhao/DocLayout-YOLO-DocStructBench")
    ap.add_argument("--weights", default="doclayout_yolo_docstructbench_imgsz1024.pt")
    args = ap.parse_args()

    pdf_dir = Path(args.pdf_dir).expanduser().resolve()
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDFs found in {pdf_dir}")

    random.seed(args.seed)
    sample_n = max(1, min(args.sample_n, len(pdfs)))
    sample = random.sample(pdfs, sample_n)

    # Device selection.
    try:
        import torch

        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        device = "cpu"

    weights_path = _download_weights(args.repo_id, args.weights)
    model = _load_yolo(weights_path, device=device)

    # Collect per-block crop sizes (px) and per-pdf stats.
    all_bbox_w: List[float] = []
    all_bbox_h: List[float] = []
    all_bbox_area_mpx: List[float] = []
    all_fig_bbox_area_mpx: List[float] = []
    all_table_bbox_area_mpx: List[float] = []

    per_pdf: List[PdfStats] = []

    # Avoid half on CPU.
    half = bool(args.half) and device.startswith("cuda")

    # Batch predict wants file paths; render to temp pngs.
    with tempfile.TemporaryDirectory() as td_root:
        td_root_p = Path(td_root)

        for pdf_path in sample:
            doc = fitz.open(pdf_path)
            pages_total = doc.page_count
            doc.close()

            with tempfile.TemporaryDirectory(dir=td_root) as td_pdf:
                td_pdf_p = Path(td_pdf)
                page_paths = _render_pages_to_pngs(
                    pdf_path=pdf_path,
                    pages_per_pdf=max(1, args.pages_per_pdf),
                    render_scale=float(args.render_scale),
                    tmpdir=td_pdf_p,
                )

                # Predict in chunks.
                blocks_total = 0
                fig_blocks = 0
                table_blocks = 0
                other_blocks = 0
                pdf_bbox_w: List[float] = []
                pdf_bbox_h: List[float] = []
                pdf_bbox_area_mpx: List[float] = []

                batch_pages = max(1, int(args.batch_pages))
                for off in range(0, len(page_paths), batch_pages):
                    chunk = page_paths[off : off + batch_pages]
                    chunk_paths = [p for _, p in chunk]
                    det_res = model.predict(
                        chunk_paths,
                        imgsz=int(args.imgsz),
                        conf=float(args.conf),
                        device=device,
                        half=half,
                    )

                    for (_page_idx, _img_path), r in zip(chunk, det_res):
                        boxes = getattr(r, "boxes", None)
                        names = getattr(r, "names", None)
                        if boxes is None or getattr(boxes, "xyxy", None) is None:
                            continue

                        xyxy = boxes.xyxy
                        confs = getattr(boxes, "conf", None)
                        clss = getattr(boxes, "cls", None)
                        try:
                            xyxy = xyxy.cpu().numpy()
                            confs = confs.cpu().numpy() if confs is not None else None
                            clss = clss.cpu().numpy().astype(int) if clss is not None else None
                        except Exception:
                            # Some wrappers already return CPU arrays.
                            pass

                        for i, bb in enumerate(xyxy):
                            x1, y1, x2, y2 = [float(v) for v in bb]
                            w = max(0.0, x2 - x1)
                            h = max(0.0, y2 - y1)
                            if w <= 1.0 or h <= 1.0:
                                continue

                            cls_id = int(clss[i]) if clss is not None else -1
                            label = _label_of(names, cls_id)

                            blocks_total += 1
                            if _is_figure(label):
                                fig_blocks += 1
                            elif _is_table(label):
                                table_blocks += 1
                            else:
                                other_blocks += 1

                            area_mpx = (w * h) / 1e6
                            pdf_bbox_w.append(w)
                            pdf_bbox_h.append(h)
                            pdf_bbox_area_mpx.append(area_mpx)

                            all_bbox_w.append(w)
                            all_bbox_h.append(h)
                            all_bbox_area_mpx.append(area_mpx)
                            if _is_figure(label):
                                all_fig_bbox_area_mpx.append(area_mpx)
                            if _is_table(label):
                                all_table_bbox_area_mpx.append(area_mpx)

                per_pdf.append(
                    PdfStats(
                        pdf=pdf_path.name,
                        pages_total=int(pages_total),
                        pages_sampled=len(page_paths),
                        blocks_total=int(blocks_total),
                        figure_blocks=int(fig_blocks),
                        table_blocks=int(table_blocks),
                        other_blocks=int(other_blocks),
                        bbox_w_px_mean=_safe_mean(pdf_bbox_w),
                        bbox_h_px_mean=_safe_mean(pdf_bbox_h),
                        bbox_area_mpx_mean=_safe_mean(pdf_bbox_area_mpx),
                    )
                )

    # Write outputs.
    out_csv = Path(args.output_csv).resolve()
    out_json = Path(args.output_json).resolve()

    # lightweight CSV writer (no pandas dependency)
    headers = list(asdict(per_pdf[0]).keys()) if per_pdf else []
    with open(out_csv, "w", encoding="utf-8") as f:
        f.write(",".join(headers) + "\n")
        for row in per_pdf:
            d = asdict(row)
            vals = []
            for h in headers:
                v = d.get(h)
                if v is None:
                    vals.append("")
                else:
                    s = str(v).replace('"', '""')
                    if "," in s or "\n" in s:
                        s = f"\"{s}\""
                    vals.append(s)
            f.write(",".join(vals) + "\n")

    summary: Dict[str, Any] = {
        "pdf_dir": str(pdf_dir),
        "sample_n": sample_n,
        "pages_per_pdf": int(args.pages_per_pdf),
        "render_scale": float(args.render_scale),
        "device": device,
        "imgsz": int(args.imgsz),
        "conf": float(args.conf),
        "batch_pages": int(args.batch_pages),
        "half": half,
        "avg_blocks_total_per_pdf": _safe_mean([p.blocks_total for p in per_pdf]),
        "avg_figure_blocks_per_pdf": _safe_mean([p.figure_blocks for p in per_pdf]),
        "avg_table_blocks_per_pdf": _safe_mean([p.table_blocks for p in per_pdf]),
        "bbox_w_px": {
            "mean": _safe_mean(all_bbox_w),
            "median": float(statistics.median(all_bbox_w)) if all_bbox_w else None,
            "p10": _pct(all_bbox_w, 10),
            "p90": _pct(all_bbox_w, 90),
        },
        "bbox_h_px": {
            "mean": _safe_mean(all_bbox_h),
            "median": float(statistics.median(all_bbox_h)) if all_bbox_h else None,
            "p10": _pct(all_bbox_h, 10),
            "p90": _pct(all_bbox_h, 90),
        },
        "bbox_area_mpx": {
            "mean": _safe_mean(all_bbox_area_mpx),
            "median": float(statistics.median(all_bbox_area_mpx)) if all_bbox_area_mpx else None,
            "p10": _pct(all_bbox_area_mpx, 10),
            "p90": _pct(all_bbox_area_mpx, 90),
        },
        "figure_bbox_area_mpx": {
            "mean": _safe_mean(all_fig_bbox_area_mpx),
            "median": float(statistics.median(all_fig_bbox_area_mpx)) if all_fig_bbox_area_mpx else None,
            "p90": _pct(all_fig_bbox_area_mpx, 90),
        },
        "table_bbox_area_mpx": {
            "mean": _safe_mean(all_table_bbox_area_mpx),
            "median": float(statistics.median(all_table_bbox_area_mpx)) if all_table_bbox_area_mpx else None,
            "p90": _pct(all_table_bbox_area_mpx, 90),
        },
        "outputs": {
            "csv": str(out_csv),
            "json": str(out_json),
        },
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

