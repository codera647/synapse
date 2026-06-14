-- Per-stage worker counts the owner can tune from Settings → Processing. This OVERRIDES
-- the auto hardware plan and env vars (resolution order in worker_bootstrap is:
-- this table -> env var -> auto hardware plan). A NULL column means "fall back".
--
-- It's a system/deployment setting (there is one backend worker pool), so it's a
-- singleton row. The backend reads it with the service role; the Next.js owner-gated
-- route writes it with the service role. RLS denies all direct anon/authenticated access.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.pipeline_worker_config (
  id boolean primary key default true,
  sync integer,
  layout_parser integer,
  text_extraction integer,
  image_captioning integer,
  chunking integer,
  embedding integer,
  clustering integer,
  chat_retriever integer,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint pipeline_worker_config_singleton check (id = true)
);

alter table public.pipeline_worker_config enable row level security;
-- No permissive policies on purpose: only the service role (backend + the owner-gated
-- server route) may read/write this. RLS therefore blocks direct client access.
