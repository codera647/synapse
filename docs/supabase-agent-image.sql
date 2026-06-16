-- Agent mode — Image generation. Allow the 'image' artifact format. Run in the Supabase SQL editor
-- after supabase-agent-docs.sql. Idempotent. (Generated images reuse the existing file_key/png_key
-- columns, so no new columns are needed.)

alter table public.agent_artifacts drop constraint if exists agent_artifacts_format_check;
alter table public.agent_artifacts
  add constraint agent_artifacts_format_check
  check (format in ('vega_lite','mermaid','document','pdf','image'));
