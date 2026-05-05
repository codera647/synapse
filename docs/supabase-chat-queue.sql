-- Chat runtime queue tables (retriever workers)
-- Run this in Supabase SQL editor.

create table if not exists public.chat_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  library_ids uuid[] not null,
  message text not null,
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  result jsonb null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_chat_jobs_org_created on public.chat_jobs (organization_id, created_at desc);

create table if not exists public.chat_retrieval_tasks (
  id uuid primary key default gen_random_uuid(),
  chat_job_id uuid not null references public.chat_jobs(id) on delete cascade,
  organization_id uuid not null,
  library_ids uuid[] not null,
  hop int not null default 0,
  kind text not null, -- vector|keyword|visual (future)
  status text not null default 'queued', -- queued|running|done|failed
  attempts int not null default 0,
  assigned_worker text null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb null,
  last_error text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_chat_tasks_claim on public.chat_retrieval_tasks (status, created_at);
create index if not exists idx_chat_tasks_job on public.chat_retrieval_tasks (chat_job_id, hop, kind);

-- Optional: RLS (recommended for production). For your service-role-only Colab backend, you can skip for now.
-- alter table public.chat_jobs enable row level security;
-- alter table public.chat_retrieval_tasks enable row level security;

