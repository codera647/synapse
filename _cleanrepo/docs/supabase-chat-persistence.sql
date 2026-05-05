-- Chat persistence (threads/messages/sources) scoped by organization.
-- Run in Supabase SQL editor.

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by_user_id uuid not null references public.users(id) on delete restrict,
  title text not null default 'New chat',
  selected_library_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_chat_threads_org_updated
  on public.chat_threads (organization_id, updated_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  status text not null default 'done',
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_thread_created
  on public.chat_messages (thread_id, created_at asc);

create table if not exists public.chat_message_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  library_id uuid null references public.libraries(id) on delete set null,
  doc_id uuid null references public.documents(id) on delete set null,
  doc_title text null,
  storage_path_raw text null,
  chunk_id text null,
  page_start int null,
  page_end int null,
  score float null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_sources_message
  on public.chat_message_sources (message_id);

-- RLS
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_message_sources enable row level security;

-- Helper: user is a member of org
create or replace function public.is_org_member(p_org uuid, p_user uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = p_user
  );
$$;

-- Threads policies
drop policy if exists chat_threads_select on public.chat_threads;
create policy chat_threads_select
  on public.chat_threads for select
  using (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_threads_insert on public.chat_threads;
create policy chat_threads_insert
  on public.chat_threads for insert
  with check (
    created_by_user_id = auth.uid()
    and public.is_org_member(organization_id, auth.uid())
  );

drop policy if exists chat_threads_update on public.chat_threads;
create policy chat_threads_update
  on public.chat_threads for update
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_threads_delete on public.chat_threads;
create policy chat_threads_delete
  on public.chat_threads for delete
  using (public.is_org_member(organization_id, auth.uid()));

-- Messages policies
drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select
  on public.chat_messages for select
  using (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_messages_insert on public.chat_messages;
create policy chat_messages_insert
  on public.chat_messages for insert
  with check (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_messages_update on public.chat_messages;
create policy chat_messages_update
  on public.chat_messages for update
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_messages_delete on public.chat_messages;
create policy chat_messages_delete
  on public.chat_messages for delete
  using (public.is_org_member(organization_id, auth.uid()));

-- Sources policies
drop policy if exists chat_sources_select on public.chat_message_sources;
create policy chat_sources_select
  on public.chat_message_sources for select
  using (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_sources_insert on public.chat_message_sources;
create policy chat_sources_insert
  on public.chat_message_sources for insert
  with check (public.is_org_member(organization_id, auth.uid()));

drop policy if exists chat_sources_delete on public.chat_message_sources;
create policy chat_sources_delete
  on public.chat_message_sources for delete
  using (public.is_org_member(organization_id, auth.uid()));

