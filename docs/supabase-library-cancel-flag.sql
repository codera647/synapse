-- Durable cancel signal for the pipeline.
--
-- Problem: cancelling a library only set libraries.pipeline_status='canceled' and flipped the
-- in-flight batch_stage_jobs to 'canceled'. But any worker that was mid-batch when you cancelled
-- would finish its batch, then OVERWRITE pipeline_status back to 'running' and enqueue the next
-- stage — resurrecting the whole pipeline. Cancel looked ignored.
--
-- Fix: a dedicated boolean the cancel path sets and ONLY start/resume clears. Workers READ it but
-- never write it, so it cannot be clobbered by an in-flight worker. Every worker treats
-- cancel_requested=true exactly like pipeline_status='canceled' (abort current job, refuse to
-- enqueue the next stage).
--
-- Run once in the Supabase SQL editor.

alter table public.libraries
  add column if not exists cancel_requested boolean not null default false;
