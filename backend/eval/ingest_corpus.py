"""Ingest the sampled DOUBLE-BENCH corpus into a dedicated Synapse org/library.

This is the local-file ingestion path the product lacks (production pulls from Google Drive):
  1. create a benchmark organization + library
  2. upload each raw file to R2 and insert a `documents` row pointing at it (storage_path_raw)
  3. create batch_stage_jobs starting at `layout_parser` (skipping the Drive `sync` stage)
  4. flip the library to processing so the running worker pool picks it up
  5. (optional) poll until pipeline_status='completed'

The worker pool must be running with EMBED_MODEL=BAAI/bge-m3, CAPTION_USE_API=1, CHUNK_CONTEXTUAL=0.
Writes runs/<run_id>/ingest.json (org_id, library_id) and doc_map.json (bench_doc_id -> synapse doc_id).

Usage:
  python -m eval.ingest_corpus --config eval/config.yaml --wait
  python -m eval.ingest_corpus --config eval/config.yaml --reset --wait   # recreate from scratch
"""

from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from eval import common


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

from batch_creator import create_library_batches  # reuse production batch creation


_EXT_MIME = {".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html"}


def _ingest_state_path(cfg) -> Path:
    return common.run_dir(cfg) / "ingest.json"


def _load_state(cfg) -> Dict[str, Any]:
    p = _ingest_state_path(cfg)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _save_state(cfg, state: Dict[str, Any]) -> None:
    _ingest_state_path(cfg).write_text(json.dumps(state, indent=2), encoding="utf-8")


def _create_org_library(cfg, sb) -> Dict[str, str]:
    run_id = str(cfg.get("run_id") or "demo")
    org = sb.table("organizations").insert(
        {"name": f"DoubleBench Eval ({run_id})", "slug": f"dbeval-{run_id}-{uuid.uuid4().hex[:6]}", "plan": "free"}
    ).execute().data[0]
    org_id = org["id"]
    lib = sb.table("libraries").insert(
        {
            "organization_id": org_id,
            "name": f"DOUBLE-BENCH {run_id}",
            "source_type": "local_eval",
            "source_folder_id": "eval",
            "status": "processing",
            "pipeline_status": "queued",
            "pipeline_progress_percent": 0,
            "cancel_requested": False,
        }
    ).execute().data[0]
    return {"org_id": org_id, "library_id": lib["id"]}


def ingest(cfg, reset: bool) -> Dict[str, Any]:
    sb = common.get_supabase()
    s3, bucket = common.get_r2()
    rd = common.run_dir(cfg)
    docs = common.read_jsonl(rd / "sample_docs.jsonl")
    if not docs:
        raise SystemExit("runs/<id>/sample_docs.jsonl missing — run eval.datasets.double_bench --sample first.")

    state = _load_state(cfg)
    if reset or not state.get("library_id"):
        ids = _create_org_library(cfg, sb)
        state.update(ids)
        _save_state(cfg, state)
        print(f"[ingest] created org={state['org_id']} library={state['library_id']}")
    org_id, lib_id = state["org_id"], state["library_id"]

    PIPELINE = ["sync", "layout_parser", "text_extraction", "image_captioning",
                "chunking", "embedding", "clustering"]
    page_images = cfg["dataset"].get("doc_source", "ocr_text") == "page_images"
    start_stage = "layout_parser" if page_images else "chunking"

    doc_map: Dict[str, str] = {}
    rows: List[Dict[str, Any]] = []
    kind = "page-image PDFs" if page_images else "text-IR"
    print(f"[ingest] uploading {len(docs)} {kind} to R2 + inserting documents rows ...")
    for d in docs:
        bench_id = str(d["doc_id"])
        synapse_doc_id = str(uuid.uuid4())
        if page_images:
            # Raw PDF -> layout/extraction/caption read it from storage_path_raw.
            key = f"raw/{org_id}/{lib_id}/{synapse_doc_id}.pdf"
            with open(d["path"], "rb") as f:
                body = f.read()
            s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/pdf")
            doc_row = {
                "id": synapse_doc_id, "organization_id": org_id, "library_id": lib_id,
                "title": bench_id, "mime_type": "application/pdf", "file_size_bytes": len(body),
                "status": "pending", "storage_path": key, "storage_path_raw": key,
                "gdrive_file_id": f"bench:{bench_id}",
            }
        else:
            # Text IR -> chunk_worker reads text/{org}/{lib}/{doc}.json.
            key = f"text/{org_id}/{lib_id}/{synapse_doc_id}.json"
            with open(d["ir_path"], "rb") as f:
                body = f.read()
            s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json")
            doc_row = {
                "id": synapse_doc_id, "organization_id": org_id, "library_id": lib_id,
                "title": bench_id, "mime_type": d.get("mime_type") or "application/pdf",
                "file_size_bytes": len(body), "status": "pending",
                "storage_path": key, "storage_path_text": key,
                "gdrive_file_id": f"bench:{bench_id}",
            }
        rows.append(doc_row)
        doc_map[bench_id] = synapse_doc_id

    # Upsert documents in chunks (idempotent on library_id,gdrive_file_id).
    for i in range(0, len(rows), 200):
        sb.table("documents").upsert(rows[i : i + 200], on_conflict="library_id,gdrive_file_id").execute()
    (rd / "doc_map.json").write_text(json.dumps(doc_map, indent=2), encoding="utf-8")

    # Start the pipeline at `start_stage`; seed synthetic done-rows for every PRIOR stage so the
    # per-stage claim gates pass (each stage gates on its predecessor being done for the batch).
    n_workers = int(os.getenv("EVAL_INGEST_BATCHES", "8"))
    res = create_library_batches(org_id, lib_id, worker_count=n_workers, stage=start_stage)
    prior = PIPELINE[: PIPELINE.index(start_stage)]
    batches = sb.table("library_batches").select("id").eq("library_id", lib_id).execute().data or []
    now = _now_iso()
    synthetic = []
    for b in batches:
        for st in prior:
            synthetic.append({
                "organization_id": org_id, "library_id": lib_id, "batch_id": b["id"],
                "stage": st, "status": "done", "attempts": 0, "payload": {},
                "progress_current": 0, "progress_total": 0, "finished_at": now,
            })
    if synthetic:
        sb.table("batch_stage_jobs").upsert(synthetic, on_conflict="batch_id,stage").execute()

    sb.table("libraries").update(
        {
            "status": "processing",
            "pipeline_status": "running",
            "pipeline_stage": start_stage,
            "pipeline_error": None,
            "cancel_requested": False,
            "total_batches": int(res.get("created") or 0),
            "completed_batches": 0,
        }
    ).eq("id", lib_id).execute()
    print(f"[ingest] created {res.get('created')} batches @ {start_stage}; library is now processing.")
    if page_images:
        print("  Full pipeline incl. VLM captioning. Workers: EMBED_MODEL=BAAI/bge-m3, "
              "CAPTION_USE_API=1, CHUNK_CONTEXTUAL=0.")
    else:
        print("  Workers: EMBED_MODEL=BAAI/bge-m3.")
    return state


def wait_until_done(cfg, timeout_min: int = 240) -> None:
    sb = common.get_supabase()
    lib_id = _load_state(cfg).get("library_id")
    if not lib_id:
        raise SystemExit("no library_id — run ingest first.")
    deadline = time.time() + timeout_min * 60
    last = None
    while time.time() < deadline:
        lib = sb.table("libraries").select(
            "pipeline_status, pipeline_stage, pipeline_progress_percent, pipeline_error"
        ).eq("id", lib_id).single().execute().data or {}
        st = (lib.get("pipeline_status") or "").lower()
        msg = f"{st} | stage={lib.get('pipeline_stage')} | {lib.get('pipeline_progress_percent')}%"
        if msg != last:
            print(f"[ingest:wait] {msg}")
            last = msg
        if st == "completed":
            print("[ingest:wait] DONE — library completed.")
            return
        if st == "failed":
            raise SystemExit(f"ingestion failed: {lib.get('pipeline_error')}")
        time.sleep(15)
    raise SystemExit("timed out waiting for ingestion to complete.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="eval/config.yaml")
    ap.add_argument("--reset", action="store_true", help="create a fresh org/library")
    ap.add_argument("--wait", action="store_true", help="poll until pipeline completes")
    args = ap.parse_args()
    cfg = common.load_config(args.config)
    ingest(cfg, reset=args.reset)
    if args.wait:
        wait_until_done(cfg)


if __name__ == "__main__":
    main()
