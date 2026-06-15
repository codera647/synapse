"""DOUBLE-BENCH (Episoode/Double-Bench) loader + stratified DEMO sampler.

Real dataset shape (verified via HF):
  - configs `single-hop` and `multi-hop` (parquet); documents referenced by `doc_path`
    (e.g. "docs/English/0989"); evidence pages are 0-based (`reference_page`).
  - docs.tar.gz (23GB, page images) — too big; ocr.tar.gz (66MB) has per-page OCR text:
    ocr_text/{Lang}/{id}/text/000.txt + table_text/000_k.txt + figure_text/000_k.txt

We use the OCR text to build Synapse's text-IR directly (one block-set per page), so ingestion is
page-accurate and free (no layout/VLM). Outputs under <data_dir>:
  - queries.jsonl, docs.jsonl, corpus/<id>.ir.json
and under runs/<run_id>: sample_docs.jsonl, sample_queries.jsonl.

Usage:
  python -m eval.datasets.double_bench --config eval/config.yaml --prepare   # queries+sample+IR
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import random
import tarfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

from eval import common


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


# ------------------------------------------------------------------ queries
def load_queries(cfg) -> List[Dict[str, Any]]:
    from datasets import load_dataset

    hf_id = cfg["dataset"]["hf_dataset_id"]
    out: List[Dict[str, Any]] = []
    for config in cfg["dataset"]["configs"]:
        print(f"[double-bench] loading config '{config}' ...")
        ds = load_dataset(hf_id, config, split="train")
        for r in ds:
            doc_path = str(r.get("doc_path") or "")
            doc_type = _norm_doctype(r.get("doc_type"))
            lang = str(r.get("language") or "").lower()
            if config == "multi-hop":
                steps = r.get("steps") or []
                chain = [list(s.get("reference_page") or []) for s in steps if s.get("reference_page")]
                hops = max(2, len(chain)) if chain else 2
                src = r.get("source_type")
                modality = (src[0] if isinstance(src, list) and src else "text")
                out.append({
                    "query_id": f"multi:{r.get('uid')}",
                    "question": r.get("question") or "",
                    "answer": r.get("answer") or "",
                    "doc_id": doc_path, "language": lang, "doc_type": doc_type,
                    "hops": hops, "modality": str(modality or "text"),
                    "evidence_pages": list(r.get("reference_page") or []),
                    "evidence_chain": chain,
                })
            else:
                out.append({
                    "query_id": f"single:{r.get('uid')}",
                    "question": r.get("question") or "",
                    "answer": r.get("answer") or "",
                    "doc_id": doc_path, "language": lang, "doc_type": doc_type,
                    "hops": 1, "modality": str(r.get("source_type") or r.get("modality") or "text").lower(),
                    "evidence_pages": list(r.get("reference_page") or []),
                    "evidence_chain": [],
                })
    common.write_jsonl(common.data_dir(cfg) / "queries.jsonl", out)
    print(f"[double-bench] {len(out)} queries -> queries.jsonl")
    return out


# ------------------------------------------------------------------ sample
def stratified_sample(cfg, queries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    s = cfg["sample"]
    rng = random.Random(int(s.get("seed", 17)))
    langs = set(x.lower() for x in (s.get("languages") or []))
    dtypes = set(x.lower() for x in (s.get("doc_types") or []))
    max_docs = int(s.get("max_docs", 90))

    # doc universe (doc_path -> language, doc_type) from queries that match the filters
    docs: Dict[str, Dict[str, str]] = {}
    for q in queries:
        if (not langs or q["language"] in langs) and (not dtypes or q["doc_type"] in dtypes):
            docs.setdefault(q["doc_id"], {"doc_path": q["doc_id"], "language": q["language"], "doc_type": q["doc_type"]})

    buckets: Dict[tuple, List[Dict[str, str]]] = defaultdict(list)
    for d in docs.values():
        buckets[(d["language"], d["doc_type"])].append(d)
    for b in buckets.values():
        b.sort(key=lambda d: d["doc_path"])  # low ids first (deterministic)
        rng.shuffle(b)

    chosen: List[Dict[str, str]] = []
    order = [b for b in buckets.values() if b]
    i = 0
    while len(chosen) < max_docs and order:
        b = order[i % len(order)]
        if b:
            chosen.append(b.pop())
        order = [x for x in order if x]
        i += 1
    chosen = chosen[:max_docs]
    chosen_ids = set(d["doc_path"] for d in chosen)
    sample_queries = [q for q in queries if q["doc_id"] in chosen_ids]

    rd = common.run_dir(cfg)
    common.write_jsonl(rd / "sample_queries.jsonl", sample_queries)
    by_t = defaultdict(int); by_l = defaultdict(int); by_h = defaultdict(int)
    for d in chosen:
        by_t[d["doc_type"]] += 1; by_l[d["language"]] += 1
    for q in sample_queries:
        by_h[q["hops"]] += 1
    print(f"[sample] {len(chosen)} docs, {len(sample_queries)} queries -> {rd}")
    print(f"  by type {dict(by_t)} | by lang {dict(by_l)} | queries by hops {dict(by_h)}")
    return chosen


# ------------------------------------------------------------------ materialize (OCR text -> IR)
def _download_ocr(cfg) -> Path:
    from huggingface_hub import hf_hub_download

    data = common.data_dir(cfg)
    marker = data / "ocr_extracted" / ".done"
    if marker.exists():
        return data / "ocr_extracted"
    print("[double-bench] downloading ocr.tar.gz (~66MB) ...")
    tar_path = hf_hub_download(repo_id=cfg["dataset"]["hf_dataset_id"], filename="ocr.tar.gz", repo_type="dataset")
    dest = data / "ocr_extracted"
    dest.mkdir(parents=True, exist_ok=True)
    print("[double-bench] extracting OCR text ...")
    with tarfile.open(tar_path, "r:gz") as tf:
        tf.extractall(dest)
    marker.write_text("ok")
    return dest


def _read_pages(ocr_base: Path) -> Dict[int, List[str]]:
    """page_idx -> [text block, table blocks..., figure blocks...] from the OCR folder."""
    pages: Dict[int, List[str]] = defaultdict(list)

    def _idx(p: str) -> int:
        stem = os.path.splitext(os.path.basename(p))[0]
        head = stem.split("_")[0]
        try:
            return int(head)
        except Exception:
            return -1

    for f in sorted(glob.glob(str(ocr_base / "text" / "*.txt"))):
        i = _idx(f)
        if i >= 0:
            pages[i].insert(0, Path(f).read_text(encoding="utf-8", errors="ignore"))
    for sub in ("table_text", "figure_text"):
        for f in sorted(glob.glob(str(ocr_base / sub / "*.txt"))):
            i = _idx(f)
            if i >= 0:
                pages[i].append(Path(f).read_text(encoding="utf-8", errors="ignore"))
    return pages


def materialize_docs(cfg, chosen: List[Dict[str, str]]) -> None:
    if cfg["dataset"].get("doc_source", "ocr_text") != "ocr_text":
        raise SystemExit("only doc_source=ocr_text is implemented (page_images=23GB).")
    ocr_root = _download_ocr(cfg)
    corpus = common.data_dir(cfg) / "corpus"
    corpus.mkdir(parents=True, exist_ok=True)

    docs_out: List[Dict[str, Any]] = []
    for d in chosen:
        doc_path = d["doc_path"]                      # docs/English/0989
        ocr_base = ocr_root / doc_path.replace("docs/", "ocr_text/")
        if not ocr_base.exists():
            print(f"  ! OCR missing for {doc_path} ({ocr_base}) — skipped")
            continue
        pages = _read_pages(ocr_base)
        if not pages:
            print(f"  ! no OCR pages for {doc_path} — skipped")
            continue
        ir_pages = []
        for i in sorted(pages):
            blocks = []
            for bi, txt in enumerate(pages[i]):
                txt = (txt or "").strip()
                if not txt:
                    continue
                blocks.append({
                    "block_id": f"{_safe_id(doc_path)}_p{i}_b{bi}",
                    "kind": "text",
                    "text": txt,
                    "locator": f"page {i}",
                })
            if blocks:
                ir_pages.append({"page": i, "blocks": blocks})
        ir = {"doc_path": doc_path, "pages": ir_pages}
        ir_path = corpus / f"{_safe_id(doc_path)}.ir.json"
        ir_path.write_text(json.dumps(ir, ensure_ascii=False), encoding="utf-8")
        docs_out.append({
            "doc_id": doc_path, "ir_path": str(ir_path), "mime_type": "application/pdf",
            "doc_type": d["doc_type"], "language": d["language"], "num_pages": len(ir_pages),
        })
    common.write_jsonl(common.data_dir(cfg) / "docs.jsonl", docs_out)
    # the sample's docs (with IR paths) go to the run dir for ingest_corpus
    common.write_jsonl(common.run_dir(cfg) / "sample_docs.jsonl", docs_out)
    print(f"[double-bench] built IR for {len(docs_out)} docs -> {corpus}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="eval/config.yaml")
    ap.add_argument("--prepare", action="store_true", help="load queries + sample + build IR")
    ap.add_argument("--queries-only", action="store_true")
    args = ap.parse_args()
    cfg = common.load_config(args.config)
    if args.queries_only:
        load_queries(cfg)
        return
    # default = full prepare
    queries = load_queries(cfg)
    chosen = stratified_sample(cfg, queries)
    materialize_docs(cfg, chosen)


if __name__ == "__main__":
    main()
