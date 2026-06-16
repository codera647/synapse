-- Agent mode — Phase 2 (Docs + PDF). Extends agent_artifacts to hold generated documents.
-- Run in the Supabase SQL editor after supabase-agent-persistence.sql. Idempotent.

alter table public.agent_artifacts add column if not exists markdown_text text;  -- document body (markdown)
alter table public.agent_artifacts add column if not exists file_key text;        -- R2 key of a downloadable file (e.g. the rendered PDF)

-- Allow the document/pdf formats alongside the visual ones.
alter table public.agent_artifacts drop constraint if exists agent_artifacts_format_check;
alter table public.agent_artifacts
  add constraint agent_artifacts_format_check
  check (format in ('vega_lite','mermaid','document','pdf'));
