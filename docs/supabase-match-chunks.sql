-- Vector search RPC for Synapse chat runtime.
-- Run this once in Supabase SQL editor.
--
-- Requires:
--   create extension if not exists vector;
--
-- Notes:
-- - Uses cosine distance (lower is better) and converts to similarity (higher is better).
-- - Scopes to organization + selected library ids.

create or replace function public.match_chunk_embeddings(
  p_organization_id uuid,
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
  select
    ce.chunk_id,
    ce.organization_id,
    ce.library_id,
    ce.doc_id,
    ce.page_start,
    ce.page_end,
    coalesce(ce.embedding_text, ce.text) as text,
    (1 - (ce.embedding <=> p_query_embedding))::float as score
  from public.chunk_embeddings ce
  where ce.organization_id = p_organization_id
    and ce.library_id = any(p_library_ids)
  order by ce.embedding <=> p_query_embedding asc
  limit greatest(1, p_match_count);
$$;

-- If you have RLS enabled on chunk_embeddings, add a policy or run via service role.

