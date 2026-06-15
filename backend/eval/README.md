# Synapse Evaluation Harness — DOUBLE-BENCH + complementary RAG metrics

Reproduces DOUBLE-BENCH's methodology on Synapse (page-level **hit@k**, **LLM-as-judge** answer
accuracy) plus **RAGAS**, **honesty/overconfidence**, **citation accuracy**, and **latency/throughput**.

Synapse is a *text-chunk* RAG (parse → caption → VLM-transcribe scanned), so it enters DOUBLE-BENCH
like the paper's text-based `Colqwen-gen` baseline — not a native page-image retriever.

## Dataset = `Episoode/Double-Bench` (HuggingFace)
Two query configs (`single-hop`, `multi-hop`); documents in `docs.tar.gz` (23GB page images) and
`ocr.tar.gz` (66MB OCR text). We use the **OCR text** to build Synapse's text-IR directly (one
block-set per page) and inject it — page-accurate (`reference_page` is 0-based), unicode-safe, and
**free** (no layout/VLM). Languages: **en + ar + fr** (Urdu isn't in DOUBLE-BENCH; Arabic is the
low-resource/RTL substitute the panel will appreciate). Demo sample: ~90 docs.

## Budget model
- **OpenRouter (captioning): $0** — IR injection means no `image_captioning` runs for the benchmark.
- **OpenAI (~$3.52)**: only query generation + judging. Deep mode + dual judge (gpt-4o + gpt-5.5)
  ≈ **~10–12 judged queries**; a hard cap (`budget.max_openai_spend_usd`) stops before overrun.
- **Retrieval hit@k = free** (local `bge-m3` + reranker) → runs on **all** sampled queries.

## Prerequisites
1. Worker pool running with **`EMBED_MODEL=BAAI/bge-m3`** (multilingual). Captioning/contextual are
   not exercised by the eval library (IR injected, batches start at `chunking`).
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
