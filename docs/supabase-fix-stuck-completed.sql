-- One-off repair for libraries wrongly marked 'completed' / 100% while their clustering jobs
-- are failed or still pending. This happened from a stage-config mismatch: embedding finalized
-- the library (because 'clustering' wasn't in PIPELINE_STAGES) while orphaned clustering jobs
-- (from the backfill) failed. The code now prevents this for new libraries; this fixes existing
-- ones so the card shows the real state and Resume can re-run clustering.
--
-- After running this, click Resume on the affected library (clustering must be in PIPELINE_STAGES
-- and CLUSTER_WORKERS >= 1 on the VM).

update public.libraries l
set pipeline_status = 'failed',
    status = 'error',
    pipeline_error = 'Clustering did not finish — click Resume to retry.'
where l.pipeline_status = 'completed'
  and exists (
    select 1 from public.batch_stage_jobs j
    where j.library_id = l.id and j.stage = 'clustering' and j.status <> 'done'
  );
