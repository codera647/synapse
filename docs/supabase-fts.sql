-- Phase 1 — Level-1 keyword retrieval via Postgres full-text search (BM25-like).
--
-- Adds a generated `fts` tsvector column on chunk_embeddings (from embedding_text/text),
-- a GIN index, and a `keyword_search_chunks_fts` RPC that ranks with ts_rank_cd. The chat
-- runtime's keyword_search_chunks() calls this RPC and falls back to the old ILIKE scan if
-- it isn't installed, so applying this migration is safe and incremental.
--
-- Run once in the Supabase SQL editor.

-- GIN index builds need more working memory than Supabase's 32 MB default. Raise it for THIS
-- session only (it's a per-session setting and resets afterward). Bump higher (e.g. '512MB')
-- if the table is large and you still hit "memory required is N MB".
set maintenance_work_mem = '256MB';

-- 1) Generated tsvector over the chunk's text (prefer embedding_text, which also carries the
--    section heading/title context; fall back to raw text). STORED so it's GIN-indexable.
alter table public.chunk_embeddings
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(embedding_text, text, ''))) stored;

create index if not exists idx_chunk_embeddings_fts
  on public.chunk_embeddings using gin (fts);

-- 2) Ranked keyword search over a set of libraries (library_id cast to text to match the
--    other match RPCs, since chunk_embeddings ids are stored as text). websearch_to_tsquery
--    accepts natural queries ("foo bar", quoted phrases, OR).
create or replace function public.keyword_search_chunks_fts(
  p_library_ids uuid[],
  p_query text,
  p_match_count int default 20
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
    ce.organization_id::uuid,
    ce.library_id::uuid,
    ce.doc_id::uuid,
    ce.page_start,
    ce.page_end,
    coalesce(ce.embedding_text, ce.text) as text,
    ts_rank_cd(ce.fts, websearch_to_tsquery('english', p_query))::float as score
  from public.chunk_embeddings ce
  where ce.library_id::text = any(p_library_ids::text[])
    and ce.fts @@ websearch_to_tsquery('english', p_query)
  order by score desc
  limit greatest(1, p_match_count);
$$;
