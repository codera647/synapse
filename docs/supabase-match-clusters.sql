-- Phase 3 — Level-2 cluster routing: rank a library's clusters by similarity to the query,
-- over the KMeans centroids the clustering stage wrote to public.library_clusters.
--
-- The chat runtime's DEFAULT Level-2 behavior is *soft diversification* (reorder retrieved
-- chunks to span clusters via chunk_embeddings.cluster_id — no RPC needed, no recall loss).
-- This RPC enables the optional HARD-routing variant (restrict retrieval to the top clusters)
-- and powers query->cluster routing for comprehensive queries. Requires clustering to have run.
--
-- Run once in the Supabase SQL editor.

create or replace function public.match_clusters(
  p_library_ids uuid[],
  p_query_embedding vector(1024),
  p_top_n int default 3
)
returns table (
  library_id uuid,
  cluster_id int,
  size int,
  score float
)
language sql
stable
as $$
  select
    lc.library_id::uuid,
    lc.cluster_id,
    lc.size,
    (1 - (lc.centroid <=> p_query_embedding))::float as score
  from public.library_clusters lc
  where lc.library_id::text = any(p_library_ids::text[])
  order by lc.centroid <=> p_query_embedding asc
  limit greatest(1, p_top_n);
$$;
