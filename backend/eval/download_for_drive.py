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
def download_ocr(out: Path) -> Path:
    from huggingface_hub import hf_hub_download

    dest = out / "ocr_extracted"
    if (dest / ".done").exists():
        return dest
    print("[dbench] downloading ocr.tar.gz (~66MB) ...")
    tar = hf_hub_download(repo_id=HF_ID, filename="ocr.tar.gz", repo_type="dataset")
    dest.mkdir(parents=True, exist_ok=True)
    print("[dbench] extracting ...")
    with tarfile.open(tar, "r:gz") as tf:
        tf.extractall(dest)
    (dest / ".done").write_text("ok")
    return dest


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
            f"{_safe_id(q['doc_path'])}.pdf", q["doc_type"], q["hops"],
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
    args = ap.parse_args()
    out = Path(args.out)
    pdfs = out / "pdfs"
    pdfs.mkdir(parents=True, exist_ok=True)

    queries = load_queries()
    chosen = sample_docs(queries, args.docs, args.seed)
    ocr_root = download_ocr(out)

    built = 0
    for c in chosen:
        ocr_base = ocr_root / c["doc_path"].replace("docs/", "ocr_text/")
        if not ocr_base.exists():
            print(f"  ! OCR missing for {c['doc_path']} — skipped")
            continue
        pages = read_pages(ocr_base)
        if not pages:
            continue
        safe = _safe_id(c["doc_path"])
        build_pdf(pages, safe, pdfs / f"{safe}.pdf")
        built += 1
    write_excel(queries, chosen, out / "queries.xlsx")
    print(f"\nDONE: {built} PDFs in {pdfs}  +  {out/'queries.xlsx'}")
    print("Next: upload the pdfs/ folder to Google Drive -> create a Synapse library on it -> process -> ask questions.")


if __name__ == "__main__":
    main()
