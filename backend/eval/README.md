# Synapse Evaluation Harness — DOUBLE-BENCH + complementary RAG metrics

Reproduces DOUBLE-BENCH's methodology on Synapse (page-level **hit@k**, **LLM-as-judge** answer
accuracy) plus **RAGAS**, **honesty/overconfidence**, **citation accuracy**, and **latency/throughput**.

Synapse is a *text-chunk* RAG (parse → caption → VLM-transcribe scanned), so it enters DOUBLE-BENCH
like the paper's text-based `Colqwen-gen` baseline — not a native page-image retriever.

## Dataset = `Episoode/Double-Bench` (HuggingFace)
Two query configs (`single-hop`, `multi-hop`). Documents are **page images** in `docs.tar.gz` (23GB)
plus OCR text in `ocr.tar.gz` (66MB). Two ingestion modes (config `dataset.doc_source`):
- **`page_images` (current — real pipeline):** stream just the sampled English docs out of the 23GB
  tar, build one image-PDF per doc, and run Synapse's **full** pipeline — `layout_parser →
  text_extraction → image_captioning (VLM) → chunking → embedding → clustering`. Faithful and
  multimodal; captioning costs OpenRouter.
- **`ocr_text` (cheap fallback):** inject the OCR text as Synapse's text-IR and start at `chunking`
  (no VLM, free).

Default config: **English only**, **PDF + scanned + HTML** (no slides), **50 docs**. `reference_page`
is 0-based (so `page_offset: 0`).

## Budget model (50-doc, page_images, deep + dual judge)
- **OpenRouter (separate pool):** VLM captions every page of 50 image-docs ≈ **$3–5**.
- **OpenAI (~$10):** retrieval = **$0**; deep `/chat` + dual judge (gpt-4o + gpt-5.5) ≈ $0.32/query →
  **~28 judged queries**, hard-capped at `budget.max_openai_spend_usd` ($9.5).
- **Retrieval hit@k = free** (local `bge-m3` + reranker) on **all** ~80–100 sampled queries.

## Prerequisites
1. Worker pool running with **`EMBED_MODEL=BAAI/bge-m3`**, **`CAPTION_USE_API=1`** (Qwen2.5-VL via
   OpenRouter — every page of the image-docs is transcribed/captioned), and **`CHUNK_CONTEXTUAL=0`**
   (protects the OpenAI budget). Ensure your **OpenRouter** balance has ~$5.
2. Backend reachable at `backend_url` (config). `OPENAI_API_KEY` set for the judges.
3. Install deps: `/opt/synapse/.venv/bin/python -m pip install -r backend/eval/requirements-eval.txt`

## Run (from the `backend/` directory)
```bash
# 1. Load queries (both configs) + stratified ~90-doc sample + build text-IR from OCR
python -m eval.datasets.double_bench --config eval/config.yaml --prepare

# 2. Inject IR into a fresh benchmark library (starts at chunking) and wait for processing
python -m eval.ingest_corpus --config eval/config.yaml --reset --wait

# 3a. (free) retrieval hit@k on ALL sampled queries first — calibrate page_offset if needed
python -m eval.run_queries --config eval/config.yaml --retrieval-only

# 3b. (paid, capped) deep-mode answers + dual judge (gpt-4o + gpt-5.5) on the slice
python -m eval.run_queries --config eval/config.yaml

# 4. Aggregate into report.json + report.md
python -m eval.report --config eval/config.yaml
```

Outputs land in `backend/eval/runs/<run_id>/`:
`sample_docs.jsonl`, `sample_queries.jsonl`, `ingest.json`, `doc_map.json`, `results.jsonl`,
`report.json`, `report.md`.

## Calibration note
DOUBLE-BENCH evidence is page-numbered; Synapse stores parser page indices. After step 3a, spot-check
a few known-evidence queries and set `retrieval.page_offset` in the config (commonly 0 or 1) so
`page_start`/`page_end` align with the benchmark's pages. Re-running metrics is free (no API calls).

## Scaling up later
Top up the OpenAI pool and raise `answer.answer_slice_size` (and/or `thinking_mode`); the harness is
resumable — it only runs queries it hasn't judged yet. Full ~700-query judged run ≈ $35–50.
