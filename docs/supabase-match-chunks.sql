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
  -- Casts make this robust whether chunk_embeddings stores ids as text or uuid (some columns,
  -- e.g. organization_id, are stored as text in this DB). Comparisons cast both sides to text.
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
  where ce.organization_id::text = p_organization_id::text
    and ce.library_id::text = any(p_library_ids::text[])
  order by ce.embedding <=> p_query_embedding asc
  limit greatest(1, p_match_count);
$$;

-- If you have RLS enabled on chunk_embeddings, add a policy or run via service role.

