-- Knowledge graphs (entities + typed relations) generated on-demand per processed library.
-- Run in the Supabase SQL editor. RLS via the existing public.is_org_member (from chat persistence).

create table if not exists public.kg_graphs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  library_id uuid not null references public.libraries(id) on delete cascade,
  created_by_user_id uuid null references public.users(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','building','done','error','canceled')),
  stage text null,
  progress_current int not null default 0,
  progress_total int not null default 0,
  node_count int not null default 0,
  edge_count int not null default 0,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_kg_graphs_library on public.kg_graphs (library_id, created_at desc);

create table if not exists public.kg_nodes (
  id uuid primary key default gen_random_uuid(),
  graph_id uuid not null references public.kg_graphs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  library_id uuid not null references public.libraries(id) on delete cascade,
  name text not null,
  type text null,
  description text null,
  mention_count int not null default 1,
  source_chunk_ids text[] not null default '{}',
  embedding vector(1024) null,                 -- populated in the graph-RAG phase
  created_at timestamptz not null default now()
);
create index if not exists idx_kg_nodes_graph on public.kg_nodes (graph_id);

create table if not exists public.kg_edges (
  id uuid primary key default gen_random_uuid(),
  graph_id uuid not null references public.kg_graphs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_node_id uuid not null references public.kg_nodes(id) on delete cascade,
  target_node_id uuid not null references public.kg_nodes(id) on delete cascade,
  relation text not null,
  description text null,
  weight int not null default 1,
  source_chunk_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_kg_edges_graph on public.kg_edges (graph_id);
create index if not exists idx_kg_edges_source on public.kg_edges (source_node_id);
create index if not exists idx_kg_edges_target on public.kg_edges (target_node_id);

-- RLS -----------------------------------------------------------------------------------------
alter table public.kg_graphs enable row level security;
alter table public.kg_nodes enable row level security;
alter table public.kg_edges enable row level security;

drop policy if exists kg_graphs_select on public.kg_graphs;
create policy kg_graphs_select on public.kg_graphs for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists kg_graphs_insert on public.kg_graphs;
create policy kg_graphs_insert on public.kg_graphs for insert
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists kg_graphs_update on public.kg_graphs;
create policy kg_graphs_update on public.kg_graphs for update
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));
drop policy if exists kg_graphs_delete on public.kg_graphs;
create policy kg_graphs_delete on public.kg_graphs for delete
  using (public.is_org_member(organization_id, auth.uid()));

drop policy if exists kg_nodes_select on public.kg_nodes;
create policy kg_nodes_select on public.kg_nodes for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists kg_nodes_cud on public.kg_nodes;
create policy kg_nodes_cud on public.kg_nodes for all
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));

drop policy if exists kg_edges_select on public.kg_edges;
create policy kg_edges_select on public.kg_edges for select
  using (public.is_org_member(organization_id, auth.uid()));
drop policy if exists kg_edges_cud on public.kg_edges;
create policy kg_edges_cud on public.kg_edges for all
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));

-- Realtime: live build status / node+edge counts.
do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='kg_graphs') then
    alter publication supabase_realtime add table public.kg_graphs;
  end if;
end $$;
