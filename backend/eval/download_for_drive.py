"""Build a Google-Drive-ready demo corpus from DOUBLE-BENCH (Episoode/Double-Bench).

Run this on your LOCAL machine. It:
  1. downloads only the 66MB OCR text (ocr.tar.gz) — NOT the 23GB page images,
  2. samples 100 ENGLISH docs (34 PDF / 33 scanned / 33 HTML by original type, no slides),
  3. builds one *digital text* PDF per doc (so Synapse can read it via the normal Drive pipeline —
     image-only PDFs can't be text-extracted yet),
  4. writes queries.xlsx = every question + answer + evidence pages for those docs.

Then: upload the `pdfs/` folder to Google Drive, create a Synapse library on it, process it, and
ask questions — cross-checking answers against queries.xlsx.

Setup (local):
  pip install huggingface_hub datasets fpdf2 openpyxl
Run:
  python download_for_drive.py --out ./double_bench_demo --docs 100
"""

from __future__ import annotations

import os
import sys

# This file sits next to a local `datasets/` package (backend/eval/datasets). Drop this script's
# own directory from sys.path so `import datasets` resolves to the HuggingFace library, not the
# sibling folder.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]

import argparse
import glob
import random
import tarfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List


HF_ID = "Episoode/Double-Bench"
LANG_FOLDER = "English"          # we only use English
LANG_CODE = "en"


def _norm_doctype(s: str) -> str:
    s = (s or "").lower()
    if "scan" in s:
        return "scanned"
    if "slide" in s:
        return "slides"
    if "html" in s:
        return "html"
    return "pdf"


def _safe_id(doc_path: str) -> str:
    return doc_path.replace("docs/", "").replace("/", "_")


def _san(s: str) -> str:
    """fpdf core fonts are latin-1; replace anything outside it (rare in English OCR)."""
    return (s or "").replace("—", "-").replace("–", "-").replace("’", "'") \
        .replace("“", '"').replace("”", '"').encode("latin-1", "replace").decode("latin-1")


# ----------------------------------------------------------------- queries
def load_queries() -> List[Dict[str, Any]]:
    from datasets import load_dataset

    out: List[Dict[str, Any]] = []
    for config in ("single-hop", "multi-hop"):
        print(f"[dbench] loading {config} ...")
        ds = load_dataset(HF_ID, config, split="train")
        for r in ds:
            if str(r.get("language") or "").lower() != LANG_CODE:
                continue
            dt = _norm_doctype(r.get("doc_type"))
            if dt == "slides":
                continue
            if config == "multi-hop":
                steps = r.get("steps") or []
                chain = [list(s.get("reference_page") or []) for s in steps if s.get("reference_page")]
                hops = max(2, len(chain)) if chain else 2
                ev = sorted({p for hop in chain for p in hop} | set(r.get("reference_page") or []))
            else:
                hops = 1
                ev = list(r.get("reference_page") or [])
            out.append({
                "doc_path": str(r.get("doc_path") or ""),
                "doc_type": dt,
                "question": r.get("question") or "",
                "answer": r.get("answer") or "",
                "hops": hops,
                "evidence_pages": ev,
            })
    print(f"[dbench] {len(out)} English non-slide queries")
    return out


# ----------------------------------------------------------------- sample docs
def sample_docs(queries: List[Dict[str, Any]], n_docs: int, seed: int) -> List[Dict[str, str]]:
    by_type: Dict[str, set] = defaultdict(set)
    for q in queries:
        by_type[q["doc_type"]].add(q["doc_path"])
    rng = random.Random(seed)
    # balanced target per type (pdf/scanned/html)
    types = ["pdf", "scanned", "html"]
    per = [n_docs // 3 + (1 if i < n_docs % 3 else 0) for i in range(3)]
    chosen: List[Dict[str, str]] = []
    for t, k in zip(types, per):
        pool = sorted(by_type.get(t, []))
        rng.shuffle(pool)
        for dp in pool[:k]:
            chosen.append({"doc_path": dp, "doc_type": t})
    print(f"[dbench] sampled {len(chosen)} docs: " +
          ", ".join(f"{t}={sum(1 for c in chosen if c['doc_type']==t)}" for t in types))
    return chosen


# ----------------------------------------------------------------- OCR -> text PDF
def extract_ocr_for(chosen: List[Dict[str, str]], out: Path) -> Path:
    """Download ocr.tar.gz (66MB) and extract ONLY the sampled docs' OCR (not all 3,276 docs)."""
    from huggingface_hub import hf_hub_download

    dest = out / "ocr_extracted"
    needed = {c["doc_path"].replace("docs/", "ocr_text/") for c in chosen}
    if all((dest / n).exists() for n in needed):
        return dest
    print("[dbench] downloading ocr.tar.gz (~66MB) ...")
    tar = hf_hub_download(repo_id=HF_ID, filename="ocr.tar.gz", repo_type="dataset")
    dest.mkdir(parents=True, exist_ok=True)
    print(f"[dbench] extracting OCR for only {len(needed)} sampled docs ...")
    with tarfile.open(tar, "r:gz") as tf:
        for m in tf:
            if "/".join(m.name.split("/")[:3]) in needed:
                tf.extract(m, dest)
    return dest


def build_searchable_pdf(images_dir: Path, ocr_base: Path, out_pdf: Path) -> int:
    """Real page image (visible) + invisible OCR text layer underneath -> looks like the original
    document AND is text-extractable by Synapse (PyMuPDF)."""
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    def idx(p: Path) -> int:
        try:
            return int(os.path.splitext(p.name)[0])
        except Exception:
            return 1_000_000

    img_by_idx = {idx(p): p for p in images_dir.iterdir()
                  if p.suffix.lower() in (".jpg", ".jpeg", ".png")}
    ocr_pages = read_pages(ocr_base)
    all_idx = sorted(set(img_by_idx) | set(ocr_pages))
    if not all_idx:
        return 0
    c = canvas.Canvas(str(out_pdf))
    for i in all_idx:
        if i in img_by_idx:
            im = Image.open(img_by_idx[i])
            w, h = im.size
            c.setPageSize((w, h))
            c.drawImage(ImageReader(img_by_idx[i]), 0, 0, width=w, height=h)
        else:
            w, h = 595, 842  # A4 fallback for a page with OCR but no image
            c.setPageSize((w, h))
        text = "\n".join(t.strip() for t in ocr_pages.get(i, []) if t.strip())
        if text:
            t = c.beginText(10, h - 12)
            t.setTextRenderMode(3)               # 3 = invisible (extractable, not shown)
            t.setFont("Helvetica", 8)
            for line in _san(text).split("\n"):
                t.textLine(line[:500])
            c.drawText(t)
        c.showPage()
    c.save()
    return len(all_idx)


def read_pages(ocr_base: Path) -> Dict[int, List[str]]:
    pages: Dict[int, List[str]] = defaultdict(list)

    def idx(p: str) -> int:
        head = os.path.splitext(os.path.basename(p))[0].split("_")[0]
        return int(head) if head.isdigit() else -1

    for f in sorted(glob.glob(str(ocr_base / "text" / "*.txt"))):
        i = idx(f)
        if i >= 0:
            pages[i].insert(0, Path(f).read_text(encoding="utf-8", errors="ignore"))
    for sub in ("table_text", "figure_text"):
        for f in sorted(glob.glob(str(ocr_base / sub / "*.txt"))):
            i = idx(f)
            if i >= 0:
                pages[i].append(Path(f).read_text(encoding="utf-8", errors="ignore"))
    return pages


# ----------------------------------------------------------------- ORIGINAL images -> image PDF
def stream_extract_images(chosen: List[Dict[str, str]], images_root: Path) -> None:
    """Stream docs.tar.gz (23GB) and extract ONLY the sampled docs' page images. Bounded: a doc's
    files are contiguous, so we stop once every needed doc has been passed."""
    import gzip
    import requests

    images_root.mkdir(parents=True, exist_ok=True)
    needed = {c["doc_path"] for c in chosen}        # "docs/English/0989"
    remaining = set(needed)
    url = f"https://huggingface.co/datasets/{HF_ID}/resolve/main/docs.tar.gz"
    print("[dbench] streaming docs.tar.gz (23GB) — extracting only your 100 docs (a few GB) ...")
    r = requests.get(url, stream=True, timeout=1800)
    r.raise_for_status()
    r.raw.decode_content = True
    gz = gzip.GzipFile(fileobj=r.raw)
    tf = tarfile.open(fileobj=gz, mode="r|")
    seen = 0
    current = None
    try:
        for m in tf:
            seen += 1
            if seen % 20000 == 0:
                print(f"  ...scanned {seen} entries, {len(remaining)} docs left")
            top = "/".join(m.name.split("/")[:3])
            if current is not None and top != current and current in remaining:
                remaining.discard(current)
                if not remaining:
                    break
            current = top
            if top in needed and m.isfile() and m.name.lower().endswith((".jpg", ".jpeg", ".png")):
                d = images_root / _safe_id(top)
                d.mkdir(parents=True, exist_ok=True)
                f = tf.extractfile(m)
                if f is not None:
                    (d / os.path.basename(m.name)).write_bytes(f.read())
    finally:
        tf.close()
        r.close()


def build_image_pdf(images_dir: Path, out_pdf: Path) -> int:
    from PIL import Image

    def idx(p: Path) -> int:
        try:
            return int(os.path.splitext(p.name)[0])
        except Exception:
            return 1_000_000

    imgs = sorted([p for p in images_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")], key=idx)
    pages = []
    for p in imgs:
        try:
            pages.append(Image.open(p).convert("RGB"))
        except Exception:
            pass
    if not pages:
        return 0
    pages[0].save(out_pdf, "PDF", save_all=True, append_images=pages[1:])
    return len(pages)


def build_pdf(pages: Dict[int, List[str]], title: str, out_pdf: Path) -> int:
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(True, margin=15)
    pdf.set_title(_san(title))
    for i in sorted(pages):
        text = "\n\n".join(t.strip() for t in pages[i] if t.strip()).strip()
        if not text:
            continue
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(0, 6, _san(f"[{title} — page {i}]"), ln=1)
        pdf.set_font("Helvetica", "", 10)
        pdf.multi_cell(0, 5, _san(text))
    pdf.output(str(out_pdf))
    return len(pages)


# ----------------------------------------------------------------- excel
def write_excel(queries: List[Dict[str, Any]], chosen: List[Dict[str, str]], out_xlsx: Path) -> None:
    from openpyxl import Workbook

    chosen_paths = {c["doc_path"]: c for c in chosen}
    wb = Workbook()
    ws = wb.active
    ws.title = "queries"
    ws.append(["doc_file", "doc_type", "hops", "question", "answer", "evidence_pages (0-based)"])
    n = 0
    for q in queries:
        c = chosen_paths.get(q["doc_path"])
        if not c:
            continue
        ws.append([
            f"{c['doc_type']}__{_safe_id(q['doc_path'])}.pdf", c["doc_type"], q["hops"],
            q["question"], q["answer"], ", ".join(str(p) for p in q["evidence_pages"]),
        ])
        n += 1
    for col, w in zip("ABCDEF", (26, 10, 6, 60, 60, 18)):
        ws.column_dimensions[col].width = w
    wb.save(out_xlsx)
    print(f"[dbench] wrote {n} query rows -> {out_xlsx}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./double_bench_demo")
    ap.add_argument("--docs", type=int, default=100)
    ap.add_argument("--seed", type=int, default=17)
    ap.add_argument("--source", choices=["ocr", "images", "searchable"], default="ocr",
                    help="ocr = digital text PDFs (Synapse-readable); images = ORIGINAL page-image PDFs; "
                         "searchable = original images + invisible OCR layer (looks original AND works)")
    args = ap.parse_args()
    out = Path(args.out)
    pdfs = out / "pdfs"
    pdfs.mkdir(parents=True, exist_ok=True)

    queries = load_queries()
    chosen = sample_docs(queries, args.docs, args.seed)
    built = 0

    if args.source in ("images", "searchable"):
        images_root = out / "images"
        stream_extract_images(chosen, images_root)
    if args.source in ("ocr", "searchable"):
        ocr_root = extract_ocr_for(chosen, out)

    for c in chosen:
        safe = _safe_id(c["doc_path"])
        fname = f"{c['doc_type']}__{safe}.pdf"
        if args.source == "images":
            idir = images_root / safe
            if not idir.exists() or not any(idir.iterdir()):
                print(f"  ! no images for {c['doc_path']} — skipped")
                continue
            if build_image_pdf(idir, pdfs / fname):
                built += 1
        elif args.source == "searchable":
            idir = images_root / safe
            ocr_base = ocr_root / c["doc_path"].replace("docs/", "ocr_text/")
            if not idir.exists():
                print(f"  ! no images for {c['doc_path']} — skipped")
                continue
            if build_searchable_pdf(idir, ocr_base, pdfs / fname):
                built += 1
        else:  # ocr text PDFs
            ocr_base = ocr_root / c["doc_path"].replace("docs/", "ocr_text/")
            if not ocr_base.exists():
                print(f"  ! OCR missing for {c['doc_path']} — skipped")
                continue
            pages = read_pages(ocr_base)
            if not pages:
                continue
            build_pdf(pages, safe, pdfs / fname)
            built += 1

    write_excel(queries, chosen, out / "queries.xlsx")
    kind = {"images": "ORIGINAL image", "searchable": "searchable (image+OCR)", "ocr": "text"}[args.source]
    print(f"\nDONE: {built} {kind} PDFs in {pdfs}  +  {out/'queries.xlsx'}")
    if args.source == "images":
        print("NOTE: image-only PDFs (no text layer) — Synapse can't read them yet; these are reference originals.")
    elif args.source == "searchable":
        print("These look like the originals AND Synapse can read the OCR layer -> upload pdfs/ to Drive and process.")


if __name__ == "__main__":
    main()
