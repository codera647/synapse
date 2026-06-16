-- Agent mode persistence (runs / messages / artifacts / uploads), scoped by organization.
-- Mirrors the chat_* schema (docs/supabase-chat-persistence.sql) so the frontend's thread-load
-- and realtime code generalizes. Run in the Supabase SQL editor. Idempotent.

-- A run = one agent conversation (like a chat thread).
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by_user_id uuid not null references public.users(id) on delete restrict,
  title text not null default 'New agent run',
  selected_library_ids uuid[] not null default '{}'::uuid[],
  status text not null default 'running' check (status in ('running','needs_clarification','done','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_runs_org_updated
  on public.agent_runs (organization_id, updated_at desc);

-- Messages: user prompts, assistant narratives, system notes, clarification questions.
create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system','clarification')),
  content text not null default '',
  status text not null default 'done',
  created_by_user_id uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_messages_run_created
  on public.agent_messages (run_id, created_at asc);

-- Artifacts: one rendered visual (Vega-Lite chart or Mermaid diagram) attached to a message.
create table if not exists public.agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  message_id uuid null references public.agent_messages(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text null,                          -- bar | line | pie | scatter | area | flowchart
  format text not null check (format in ('vega_lite','mermaid')),
  title text null,
  alt_text text null,
  spec_key text null,                      -- R2 key of the interactive spec JSON (vega)
  png_key text null,                       -- R2 key of the rendered PNG (vega, downloadable)
  mermaid_text text null,                  -- diagram source (mermaid)
  data_sources jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  render_status text not null default 'ok',
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_artifacts_run
  on public.agent_artifacts (run_id, created_at asc);

-- Runtime files attached with a prompt (uploaded directly, not via Drive sync).
create table if not exists public.agent_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid null references public.agent_runs(id) on delete set null,
  library_id uuid null references public.libraries(id) on delete set null,
  created_by_user_id uuid null references public.users(id) on delete set null,
  filename text not null,
  mime_type text null,
  storage_key text not null,               -- R2 key under agent-uploads/
  kind text not null default 'unstructured' check (kind in ('structured','unstructured')),
  preview jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_uploads_org_created
  on public.agent_uploads (organization_id, created_at desc);

-- RLS ------------------------------------------------------------------------------------------
alter table public.agent_runs enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_artifacts enable row level security;
alter table public.agent_uploads enable row level security;

-- Reuses public.is_org_member(p_org, p_user) created by supabase-chat-persistence.sql.

-- agent_runs
drop policy if exists agent_runs_select on public.agent_runs;
create policy agent_runs_select on public.agent_runs for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_runs_insert on public.agent_runs;
create policy agent_runs_insert on public.agent_runs for insert
  with check (created_by_user_id = auth.uid() and public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_runs_update on public.agent_runs;
create policy agent_runs_update on public.agent_runs for update
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_runs_delete on public.agent_runs;
create policy agent_runs_delete on public.agent_runs for delete
  using (public.is_org_member(organization_id, auth.uid()));

-- agent_messages
drop policy if exists agent_messages_select on public.agent_messages;
create policy agent_messages_select on public.agent_messages for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_messages_insert on public.agent_messages;
create policy agent_messages_insert on public.agent_messages for insert
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_messages_update on public.agent_messages;
create policy agent_messages_update on public.agent_messages for update
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_messages_delete on public.agent_messages;
create policy agent_messages_delete on public.agent_messages for delete
  using (public.is_org_member(organization_id, auth.uid()));

-- agent_artifacts
drop policy if exists agent_artifacts_select on public.agent_artifacts;
create policy agent_artifacts_select on public.agent_artifacts for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_artifacts_insert on public.agent_artifacts;
create policy agent_artifacts_insert on public.agent_artifacts for insert
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_artifacts_delete on public.agent_artifacts;
create policy agent_artifacts_delete on public.agent_artifacts for delete
  using (public.is_org_member(organization_id, auth.uid()));

-- agent_uploads
drop policy if exists agent_uploads_select on public.agent_uploads;
create policy agent_uploads_select on public.agent_uploads for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_uploads_insert on public.agent_uploads;
create policy agent_uploads_insert on public.agent_uploads for insert
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists agent_uploads_delete on public.agent_uploads;
create policy agent_uploads_delete on public.agent_uploads for delete
  using (public.is_org_member(organization_id, auth.uid()));

-- Realtime: stream agent_messages to every member's screen live (like chat).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_messages'
  ) then
    alter publication supabase_realtime add table public.agent_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_artifacts'
  ) then
    alter publication supabase_realtime add table public.agent_artifacts;
  end if;
end $$;
