"""Bind the eval harness to a LIVE Synapse library you created manually (Drive upload).

It finds the library, maps each document's filename (e.g. "English_0989.pdf") back to its
DOUBLE-BENCH doc_path ("docs/English/0989"), pulls the matching questions/answers/evidence from the
benchmark, and writes the same inputs the runner expects:
  runs/<run_id>/ingest.json, doc_map.json, sample_queries.jsonl

After this, run the normal:  eval.run_queries  then  eval.report  (with retrieval.match_level=doc).

Usage (from backend/):
  python -m eval.bind_drive_library --config eval/config.yaml --library-name "DoubleBench"
  python -m eval.bind_drive_library --config eval/config.yaml --library-id <uuid>
  python -m eval.bind_drive_library --config eval/config.yaml            # uses the most recent library
"""

from __future__ import annotations

import argparse
import json
import os

from eval import common
from eval.datasets import double_bench as db


def _find_library(sb, library_id, library_name):
    if library_id:
        rows = sb.table("libraries").select("id, organization_id, name").eq("id", library_id).limit(1).execute().data
    elif library_name:
        rows = (sb.table("libraries").select("id, organization_id, name")
                .ilike("name", f"%{library_name}%").order("created_at", desc=True).limit(1).execute().data)
    else:
        rows = (sb.table("libraries").select("id, organization_id, name")
                .order("created_at", desc=True).limit(1).execute().data)
    if not rows:
        raise SystemExit("library not found — pass --library-id or --library-name.")
    return rows[0]


def _bench_doc_path(title: str):
    """'scanned__English_0989.pdf' or 'English_0989.pdf' -> 'docs/English/0989'."""
    stem = os.path.splitext(title or "")[0]
    if "__" in stem:                       # drop optional 'pdf__'/'scanned__'/'html__' prefix
        stem = stem.split("__", 1)[1]
    parts = stem.split("_", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return f"docs/{parts[0]}/{parts[1]}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="eval/config.yaml")
    ap.add_argument("--library-id", default=None)
    ap.add_argument("--library-name", default=None)
    args = ap.parse_args()
    cfg = common.load_config(args.config)
    sb = common.get_supabase()

    lib = _find_library(sb, args.library_id, args.library_name)
    org_id, lib_id = lib["organization_id"], lib["id"]
    print(f"[bind] library '{lib.get('name')}'  id={lib_id}  org={org_id}")

    docs = sb.table("documents").select("id, title").eq("library_id", lib_id).limit(5000).execute().data or []
    doc_map = {}
    unmatched = 0
    for d in docs:
        bench = _bench_doc_path(d.get("title"))
        if bench:
            doc_map[bench] = d["id"]
        else:
            unmatched += 1
    print(f"[bind] mapped {len(doc_map)} documents to benchmark doc_paths ({unmatched} unmatched titles)")
    if not doc_map:
        raise SystemExit("no documents mapped — are the PDF filenames like 'English_0989.pdf'?")

    # Restrict to docs that actually have embeddings (the processed subset). Docs from unfinished /
    # dropped batches still have a `documents` row but no chunks — querying them would count as forced
    # misses and unfairly drag the metrics. Keep only the docs Synapse can actually retrieve.
    emb_doc_ids: set = set()
    off, PAGE = 0, 1000
    while True:
        rows = (sb.table("chunk_embeddings").select("doc_id").eq("library_id", lib_id)
                .range(off, off + PAGE - 1).execute().data or [])
        if not rows:
            break
        emb_doc_ids.update(r.get("doc_id") for r in rows if r.get("doc_id"))
        if len(rows) < PAGE:
            break
        off += PAGE
    before = len(doc_map)
    doc_map = {bench: did for bench, did in doc_map.items() if did in emb_doc_ids}
    print(f"[bind] restricted to embedded docs: {len(doc_map)}/{before} "
          f"(dropped {before - len(doc_map)} with no embeddings)")
    if not doc_map:
        raise SystemExit("no embedded documents mapped — has embedding finished for this library?")

    queries = db.load_queries(cfg)                       # all benchmark queries (both configs)
    sample = [q for q in queries if q["doc_id"] in doc_map]

    rd = common.run_dir(cfg)
    (rd / "ingest.json").write_text(json.dumps({"org_id": org_id, "library_id": lib_id}, indent=2), encoding="utf-8")
    (rd / "doc_map.json").write_text(json.dumps(doc_map, indent=2), encoding="utf-8")
    common.write_jsonl(rd / "sample_queries.jsonl", sample)

    from collections import Counter
    print(f"[bind] {len(sample)} queries over {len(doc_map)} docs -> {rd}")
    print(f"  by hops: {dict(Counter(q['hops'] for q in sample))} | by doc_type: {dict(Counter(q['doc_type'] for q in sample))}")
    print("  Next:  python -m eval.run_queries --config eval/config.yaml --retrieval-only")


if __name__ == "__main__":
    main()
