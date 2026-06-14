-- Per-stage worker counts the user tunes from Settings -> Processing. This OVERRIDES the auto
-- hardware plan and env vars (resolution order in worker_bootstrap is: this table -> env var ->
-- auto hardware plan). A NULL column means "fall back" for that stage.
--
-- PER-USER (not a singleton): each user keeps their own saved counts, so changing your numbers
-- never silently rewrites another user's settings. There is still ONE physical backend worker
-- pool (one VM, one set of OS processes), so the LIVE pool reconciles to whoever most recently
-- pressed Apply — but each account's saved preferences are individual and no longer bleed across
-- accounts in the UI.
--
-- The backend reads it with the service role; the owner-gated Next.js route writes it with the
-- service role. RLS denies all direct anon/authenticated access.
--
-- Run once in the Supabase SQL editor. (Safe to re-run: it drops the old singleton table.)

drop table if exists public.pipeline_worker_config;

create table public.pipeline_worker_config (
  user_id uuid primary key,
  sync integer,
  layout_parser integer,
  text_extraction integer,
  image_captioning integer,
  chunking integer,
  embedding integer,
  clustering integer,
  chat_retriever integer,
  updated_at timestamptz not null default now()
);

alter table public.pipeline_worker_config enable row level security;
-- No permissive policies on purpose: only the service role (backend + the owner-gated server
-- route) may read/write this. RLS therefore blocks direct client access.
