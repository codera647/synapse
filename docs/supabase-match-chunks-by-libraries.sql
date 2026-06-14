-- Cross-org vector search for TEAM chat.
-- A team's pooled libraries can belong to different members' organizations, so this variant
-- filters by library_ids ONLY (authorization is enforced before the call — the caller must be a
-- team member and the libraries must be shared into the team). Run once in the Supabase SQL editor.
--
-- Requires: create extension if not exists vector;

create or replace function public.match_chunk_embeddings_by_libraries(
  p_library_ids uuid[],
  p_query_embedding vector(1024),
  p_match_count int default 8
)
returns table (
  chunk_id text,
  organization_id uuid,
  library_id uuid,
  doc_id uuid,
  page_start int,
  page_end int,
  text text,
  score float
)
language sql
stable
as $$
  -- Cast each column to the declared return type. In this DB some id columns are stored as text,
  -- so the explicit casts keep the function's output matching its signature.
  select
    ce.chunk_id::text,
    ce.organization_id::uuid,
    ce.library_id::uuid,
    ce.doc_id::uuid,
    ce.page_start::int,
    ce.page_end::int,
    coalesce(ce.embedding_text, ce.text)::text,
    (1 - (ce.embedding <=> p_query_embedding))::float
  from public.chunk_embeddings ce
  where ce.library_id::text = any(p_library_ids::text[])
  order by ce.embedding <=> p_query_embedding asc
  limit greatest(1, p_match_count);
$$;
