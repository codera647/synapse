# Synapse Backend API Reference

The backend is a FastAPI service (`backend/app.py`) that exposes HTTP endpoints and runs a
background worker pool. The frontend reaches it through the Next.js proxy at
`/api/backend/[...path]` (which forwards to `BACKEND_API_URL/<path>`).

**Architecture in one line:** Synapse is **queue-driven**. The durable source of truth for
work is Supabase (`processing_jobs`, `batch_stage_jobs`, `libraries`); the worker pool polls
those tables. The HTTP endpoints below are an *additive* control/observability layer — the
pipeline-control endpoints mirror exactly what the frontend already writes to Supabase, so
either path produces identical queue state.

Base URL (behind the reverse proxy): `https://api.yourdomain.com`
Via the frontend proxy: `https://<frontend>/api/backend/<path>`

---

## Health & system

### `GET /health`
Liveness. Returns `{ "ok": true }`.

### `GET /ready`
Readiness — is the backend configured to do work? Never raises.
```json
{
  "ready": true,
  "supabase_configured": true,
  "storage_configured": true,
  "chat_configured": true,
  "gpu": "NVIDIA L4",
  "workers_enabled": true,
  "hf_home": "/opt/synapse/.hf-cache"
}
```

### `GET /hardware`
CPU/RAM/VRAM and the auto-computed worker plan (used by the frontend before queueing work).
```json
{ "cpu": 8, "ram_gb": 31, "vram_gb": 23, "gpu": "NVIDIA L4",
  "sync_workers": 4, "extract_workers": 2, "embed_workers": 1, "cluster_workers": 1 }
```

### `GET /workers/status`
Observability: the worker plan plus live job counts across the queue, grouped by stage and
status. Useful for a dashboard widget and FYP demos.
```json
{
  "worker_plan": { "...": "see /hardware" },
  "batch_stage_jobs": {
    "sync":          { "done": 6, "queued": 0 },
    "layout_parser": { "running": 1, "queued": 5 }
  },
  "pending_processing_jobs": { "library_preprocess:queued": 1 }
}
```

---

## Pipeline control

These mirror the frontend's Supabase-writing routes (`app/api/library-sync/*`). The frontend
may keep using its direct-Supabase path or call these — both yield the same queue state.

### `POST /pipeline/start`
Queue preprocessing for a library (sets `libraries.pipeline_status='queued'` and inserts a
`library_preprocess` job). Requires a connected `library_sources` row (Google Drive OAuth is
still done in the browser).
```jsonc
// request
{ "organization_id": "uuid", "library_id": "uuid" }
// response
{ "ok": true, "job": { "id": "uuid", "type": "library_preprocess", "status": "queued" } }
```
Errors: `404` library not found, `409` no connected source.

### `GET /pipeline/status?library_id=<uuid>`
Unified progress for one library, computed from `batch_stage_jobs` using the weighted stage
ranges in `docs/sync-pipeline-design.md` (same value the dashboard derives).
```jsonc
{
  "library": { "id": "...", "pipeline_status": "running", "pipeline_stage": "layout_parser",
               "pipeline_progress_percent": 25, "total_batches": 6, "completed_batches": 2 },
  "computed_progress_percent": 25.0,
  "stage_breakdown": { "sync": { "total": 6, "done": 6 },
                       "layout_parser": { "total": 6, "done": 2 } },
  "status_counts": { "done": 8, "queued": 4 },
  "total_stage_jobs": 12
}
```
Errors: `404` library not found.

### `POST /pipeline/cancel`
Cancel a library's running/queued work.
```jsonc
{ "library_id": "uuid", "organization_id": "uuid?" }   // -> { "ok": true }
```

### `POST /pipeline/resume`
Re-queue `failed`/`canceled` batch-stage jobs. If no batches exist yet, re-enqueues a fresh
`library_preprocess` job instead.
```jsonc
// request
{ "organization_id": "uuid", "library_id": "uuid" }
// response (either)
{ "ok": true, "mode": "requeue", "requeued_count": 3 }
{ "ok": true, "mode": "fresh",   "job": { "id": "uuid", "...": "..." } }
```

---

## Storage maintenance

### `POST /r2/delete-prefix`
Delete all object-storage keys under the given prefix(es). The frontend calls this during
library deletion (`app/api/library/delete`) to purge raw + per-stage artifacts. Accepts a
single `prefix` (what the frontend sends) or a `prefixes[]` array.
```jsonc
// request
{ "prefix": "org_.../library_.../" }
// or
{ "prefixes": ["org_.../library_.../raw/", "org_.../library_.../layout/"] }
// response
{ "ok": true, "deleted": 142, "prefixes": ["..."], "errors": [] }
```
Errors: `400` no prefix, `500` `R2_BUCKET` unset.

---

## Chat (RAG)

Served by `backend/chat_api.py`. The Next.js proxy allows a 120s timeout for these.

### `POST /chat`
Citation-grounded answer over the selected libraries (hybrid retrieval + OpenAI generation
with an agentic "curious hop" loop).
```jsonc
// request
{
  "organization_id": "uuid",
  "library_ids": ["uuid"],
  "message": "What does the paper say about X?",
  "client_request_id": "uuid",
  "client_prompt_hash": "sha1?",
  "thread_summary": "string?",
  "history": [ { "role": "user", "content": "..." }, { "role": "assistant", "content": "..." } ]
}
// response
{
  "answer": "string",
  "sources": [
    { "library_id": "...", "doc_id": "...", "doc_title": "...", "path_in_source": "...",
      "gdrive_file_id": "...", "page_start": 3, "page_end": 4, "chunk_id": "...",
      "score": 0.81, "storage_path_raw": "..." }
  ],
  "followups": [ { "hop": 1, "query": "..." } ],
  "client_request_id": "...", "client_prompt_hash": "...", "server_prompt_hash": "..."
}
```
The frontend uses `client_request_id` + `server_prompt_hash` to discard stale responses, so
the backend echoes them back — keep them in any reimplementation.

### `POST /chat/compact`
Summarize a thread (title + rolling summary) to keep the chat context within budget.
```jsonc
// request
{ "messages": [ { "role": "user|assistant", "content": "..." } ] }
// response
{ "summary": "string", "title": "string" }
```

Trailing-slash variants (`/chat/`, `/chat/compact/`) are also registered.

---

## Configuration (environment variables)

| Var | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database + queue access |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY`, `R2_SECRET_KEY` | S3/R2 object storage |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Drive token refresh (sync worker) |
| `OPENAI_API_KEY`, `CHAT_GPT_MODEL` | Chat generation (default `gpt-4o-mini`) |
| `FRONTEND_ORIGIN` | CORS allow-list (comma-separated) |
| `WORKERS_ENABLED` | `0` = API-only mode (no worker pool) |
| `HF_HOME` | Model cache directory (download once) |
| `EMBED_MODEL`, `EMBED_DEVICE` | Embedder (`BAAI/bge-large-en-v1.5`) |
| `VIS_QWEN_MODEL` | Captioning VLM (`Qwen/Qwen2-VL-2B-Instruct`) |
| `DOCLAYOUT_YOLO_REPO`, `DOCLAYOUT_YOLO_FILENAME` | Layout model |
| `LAYOUT_WORKERS`, `EXTRACT_WORKERS`, `CAPTION_WORKERS`, `CHUNK_WORKERS`, `EMBED_WORKERS` | Per-stage worker counts |
| `WORKER_POOL_LOCK` | Override the pool lock path (default: OS temp dir) |
| `SYNAPSE_ENV_FILE` | Explicit path to the env file |

Config is centralized in `backend/config.py` (`CONFIG`), which also pins `HF_HOME` on import.

---

## Pipeline stages (reference)

`sync → layout_parser → text_extraction → image_captioning → chunking → embedding → vector_indexing`

Each stage is a queue (`batch_stage_jobs.stage`) with its own worker pool. Progress weighting
per stage is defined in `docs/sync-pipeline-design.md`.
