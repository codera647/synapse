# Sync Pipeline Design

This document defines the next-step data model for Synapse's preprocessing pipeline.

The goal is to move from the current `one library sync job -> full library sync -> create extraction batches` model to a reusable batch pipeline where:

- a library is split into stable batches
- each batch moves independently through stages
- workers at each layer claim queued batch-stage jobs
- completed work from one stage can immediately enter the next stage
- the UI still shows one unified progress bar and one current stage per library card

## Design Goals

- Keep the current schema usable during migration
- Add the minimum new tables needed for pipelined execution
- Keep `libraries` as the user-facing source of truth for overall pipeline progress
- Keep `documents` as the source of truth for per-document artifacts and status
- Make batches reusable across all stages
- Make workers queue-driven and stage-specific

## Current Limitation

The current sync logic is library-wide:

1. enqueue one `processing_jobs` row of type `library_sync`
2. worker syncs the whole library
3. extraction batches are created only after sync completes

That does not support the target flow:

- batch 1 finishes sync and starts layout parsing
- while batches 2-6 are still syncing

## Recommended Target Model

Keep these existing tables:

- `libraries`
- `documents`
- `processing_jobs`
- `library_sources`

Add these new tables:

- `library_batches`
- `batch_stage_jobs`

Extend `libraries` with user-facing pipeline fields.

## Pipeline Stages

These are the long-term stages:

- `sync`
- `layout_parser`
- `text_extraction`
- `image_captioning`
- `chunking`
- `embedding`
- `vector_indexing`

These are the top-level pipeline statuses:

- `idle`
- `queued`
- `running`
- `completed`
- `failed`

These are the per-stage job statuses:

- `queued`
- `running`
- `done`
- `failed`
- `skipped`

## 1. Extend `libraries`

Use `libraries` as the single UI-facing progress record.

### New columns

```sql
alter table public.libraries
  add column if not exists pipeline_status text not null default 'idle',
  add column if not exists pipeline_stage text null,
  add column if not exists pipeline_progress_percent numeric(5,2) not null default 0,
  add column if not exists pipeline_error text null,
  add column if not exists pipeline_started_at timestamptz null,
  add column if not exists pipeline_finished_at timestamptz null,
  add column if not exists total_batches integer not null default 0,
  add column if not exists completed_batches integer not null default 0;
```

### Meaning

- `pipeline_status`: overall library state for the card
- `pipeline_stage`: currently dominant stage for the library
- `pipeline_progress_percent`: one progress value for the card
- `pipeline_error`: last failure shown to the user
- `pipeline_started_at`: first preprocessing start time
- `pipeline_finished_at`: set when the full pipeline completes
- `total_batches`: stable number of batches for this library
- `completed_batches`: how many batches fully finished all required stages

## 2. New `library_batches` table

Stable batches for a library. These should be created once per preprocessing run and reused by every downstream stage.

```sql
create table if not exists public.library_batches (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  library_id uuid not null,
  batch_index integer not null,
  status text not null default 'queued',
  doc_ids jsonb not null default '[]'::jsonb,
  doc_count integer not null default 0,
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  completed_at timestamptz null,
  constraint library_batches_pkey primary key (id),
  constraint library_batches_library_fkey
    foreign key (library_id) references public.libraries (id) on delete cascade,
  constraint library_batches_org_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint library_batches_unique_idx unique (library_id, batch_index)
);

create index if not exists idx_library_batches_library
  on public.library_batches using btree (library_id);

create index if not exists idx_library_batches_status
  on public.library_batches using btree (library_id, status);
```

### Meaning

- `batch_index`: stable ordering per library
- `doc_ids`: the documents belonging to this batch
- `status`: overall batch state across the full pipeline, not just one stage
- `doc_count`: cached count for quick progress UI and worker planning

## 3. New `batch_stage_jobs` table

Queue table for per-batch per-stage work.

```sql
create table if not exists public.batch_stage_jobs (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  library_id uuid not null,
  batch_id uuid not null,
  stage text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  assigned_worker text null,
  payload jsonb not null default '{}'::jsonb,
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  run_after timestamptz null,
  started_at timestamptz null,
  finished_at timestamptz null,
  last_error text null,
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  constraint batch_stage_jobs_pkey primary key (id),
  constraint batch_stage_jobs_org_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint batch_stage_jobs_library_fkey
    foreign key (library_id) references public.libraries (id) on delete cascade,
  constraint batch_stage_jobs_batch_fkey
    foreign key (batch_id) references public.library_batches (id) on delete cascade,
  constraint batch_stage_jobs_unique_stage unique (batch_id, stage)
);

create index if not exists idx_batch_stage_jobs_claim
  on public.batch_stage_jobs using btree (stage, status, run_after, created_at);

create index if not exists idx_batch_stage_jobs_library
  on public.batch_stage_jobs using btree (library_id, stage, status);

create index if not exists idx_batch_stage_jobs_batch
  on public.batch_stage_jobs using btree (batch_id);
```

### Meaning

- one row represents one batch entering one stage
- workers claim jobs filtered by stage
- stage completion enqueues the next stage for the same batch
- retries are tracked per stage per batch

## 4. Keep `processing_jobs`, but narrow its role

Do not delete `processing_jobs` yet.

Use it only for coarse orchestration during migration:

- `library_preprocess`
- `library_sync_bootstrap`

After the library is initialized, actual work should move to `batch_stage_jobs`.

This avoids breaking the current frontend immediately while the new worker model is introduced.

## 5. Sync-First Rollout

For the first implementation phase, only the `sync` stage needs to be real.

### Flow

1. User clicks `Start preprocessing`
2. App creates one parent `processing_jobs` row of type `library_preprocess`
3. Backend lists candidate files for the library
4. Backend creates `documents` records as needed
5. Backend creates stable `library_batches`
6. Backend inserts one `batch_stage_jobs` row per batch for stage `sync`
7. Sync workers claim `batch_stage_jobs where stage = 'sync' and status = 'queued'`
8. When one sync batch completes:
   - mark that sync stage job `done`
   - enqueue `layout_parser` for the same batch
9. UI progress is computed from `batch_stage_jobs` and written back to `libraries`

### Important point

Do not recreate batches at extraction time anymore.

The existing `extraction_batches` table should eventually be replaced by:

- `library_batches`
- `batch_stage_jobs`

During migration, extraction can temporarily still read from `extraction_batches`, but the final design should remove that duplication.

## 6. Progress Model

The library card must show one progress bar.

Use weighted stage ranges:

- `sync`: 0-20
- `layout_parser`: 20-35
- `text_extraction`: 35-55
- `image_captioning`: 55-70
- `chunking`: 70-82
- `embedding`: 82-94
- `vector_indexing`: 94-100

### Progress calculation

For each stage:

- compute `done_batches / total_batches`
- multiply by the stage range

Then sum all completed partial ranges to get `pipeline_progress_percent`.

Example:

- 6 total batches
- 3 done in `sync`
- progress from sync = `0 + (3/6) * 20 = 10`

If all sync jobs are done and 2 of 6 layout jobs are done:

- sync contribution = `20`
- layout contribution = `(2/6) * 15 = 5`
- total = `25`

## 7. Worker Model

Each layer has its own worker pool.

### Sync workers

- claim only `stage = 'sync'`
- optimize for network and I/O concurrency
- should not try to use GPU

### Later stage workers

- `layout_parser` workers claim only layout jobs
- `text_extraction` workers claim only extraction jobs
- `image_captioning` workers claim only caption jobs
- `embedding` workers claim only embedding jobs

This is what enables pipelining:

- batch A can be in layout parsing
- batch B can still be syncing
- batch C can already be extracting

## 8. Recommended Status Rules

### Library status update rules

- `idle`: nothing started
- `queued`: preprocessing created but no batch started
- `running`: at least one batch-stage job is running
- `completed`: all required stages are done for all batches
- `failed`: at least one unrecoverable batch-stage job failed and blocks completion

### Batch status update rules

- `queued`: batch exists but has not started
- `running`: at least one stage currently running
- `completed`: final stage completed
- `failed`: unrecoverable failure in one stage

## 9. Migration Strategy

### Phase 1

- add new columns to `libraries`
- add `library_batches`
- add `batch_stage_jobs`
- leave current sync UI intact if needed
- create a new unified preprocessing endpoint

### Phase 2

- make sync generate `library_batches` and `sync` stage jobs
- sync workers read from `batch_stage_jobs`
- update library card progress from new pipeline fields

### Phase 3

- route extraction through `batch_stage_jobs`
- stop using `extraction_batches`

## 10. Minimal SQL Pack

This is the exact starting migration pack for the new model.

```sql
alter table public.libraries
  add column if not exists pipeline_status text not null default 'idle',
  add column if not exists pipeline_stage text null,
  add column if not exists pipeline_progress_percent numeric(5,2) not null default 0,
  add column if not exists pipeline_error text null,
  add column if not exists pipeline_started_at timestamptz null,
  add column if not exists pipeline_finished_at timestamptz null,
  add column if not exists total_batches integer not null default 0,
  add column if not exists completed_batches integer not null default 0;

create table if not exists public.library_batches (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  library_id uuid not null,
  batch_index integer not null,
  status text not null default 'queued',
  doc_ids jsonb not null default '[]'::jsonb,
  doc_count integer not null default 0,
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  completed_at timestamptz null,
  constraint library_batches_pkey primary key (id),
  constraint library_batches_library_fkey
    foreign key (library_id) references public.libraries (id) on delete cascade,
  constraint library_batches_org_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint library_batches_unique_idx unique (library_id, batch_index)
);

create index if not exists idx_library_batches_library
  on public.library_batches using btree (library_id);

create index if not exists idx_library_batches_status
  on public.library_batches using btree (library_id, status);

create table if not exists public.batch_stage_jobs (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  library_id uuid not null,
  batch_id uuid not null,
  stage text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  assigned_worker text null,
  payload jsonb not null default '{}'::jsonb,
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  run_after timestamptz null,
  started_at timestamptz null,
  finished_at timestamptz null,
  last_error text null,
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  constraint batch_stage_jobs_pkey primary key (id),
  constraint batch_stage_jobs_org_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint batch_stage_jobs_library_fkey
    foreign key (library_id) references public.libraries (id) on delete cascade,
  constraint batch_stage_jobs_batch_fkey
    foreign key (batch_id) references public.library_batches (id) on delete cascade,
  constraint batch_stage_jobs_unique_stage unique (batch_id, stage)
);

create index if not exists idx_batch_stage_jobs_claim
  on public.batch_stage_jobs using btree (stage, status, run_after, created_at);

create index if not exists idx_batch_stage_jobs_library
  on public.batch_stage_jobs using btree (library_id, stage, status);

create index if not exists idx_batch_stage_jobs_batch
  on public.batch_stage_jobs using btree (batch_id);
```

## Recommendation

Implement the sync layer first with this model.

That means the next coding task should be:

- create the new schema
- add one unified preprocessing trigger
- bootstrap `library_batches`
- enqueue `sync` jobs into `batch_stage_jobs`
- teach the sync workers to claim by batch-stage job instead of library-wide job

After that, the later stages can plug into the same flow without changing the UI architecture.
