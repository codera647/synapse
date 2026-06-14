-- One-off backfill: enqueue the clustering stage for libraries that finished embedding
-- but were stuck below 100% because, before the fix, embed_worker never created the
-- clustering batch_stage_jobs (so cluster_worker had nothing to claim and the library
-- never finalized — the "stuck at 85.71%" symptom).
--
-- cluster_worker will pick these up, run KMeans (gated on all-embeddings-done, with a
-- per-library lock so only one job does the real work), write cluster_id +
-- library_clusters, and finalize the library to completed/100%.
--
-- Safe to re-run (idempotent via the (batch_id, stage) unique constraint). Run once in
-- the Supabase SQL editor AFTER deploying the backend with clustering enabled
-- (CLUSTER_WORKERS >= 1).

insert into public.batch_stage_jobs (organization_id, library_id, batch_id, stage, status, payload)
select b.organization_id, b.library_id, b.id, 'clustering', 'queued', '{}'::jsonb
from public.library_batches b
join public.libraries l on l.id = b.library_id
where coalesce(l.pipeline_status, '') <> 'completed'
  and exists (
    select 1 from public.batch_stage_jobs e
    where e.batch_id = b.id and e.stage = 'embedding' and e.status = 'done'
  )
  and not exists (
    select 1 from public.batch_stage_jobs c
    where c.batch_id = b.id and c.stage = 'clustering'
  )
on conflict (batch_id, stage) do nothing;
