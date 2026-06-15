-- WAF-safe path for writing chunk text.
--
-- Problem: Supabase's REST API (PostgREST) is fronted by Cloudflare. When a chunk's text contains
-- code / HTML / SQL patterns (very common for code files, configs, logs), Cloudflare's managed WAF
-- ruleset blocks the entire POST with a 403 HTML page. supabase-py then fails with
-- "JSON could not be generated, code 403", and the embedding batch fails forever (retrying the
-- identical body always re-trips the same rule).
--
-- Fix: the worker base64-encodes the offending row's text fields and sends them through THIS RPC.
-- Base64 contains no attack patterns, so the WAF passes it. The function decodes server-side and
-- writes the real plaintext into chunk_embeddings, so the FTS tsvector / retrieval stay correct.
--
-- Run once in the Supabase SQL editor.

create or replace function public.set_chunk_text_b64(
  p_chunk_id text,
  p_text_b64 text default null,
  p_embedding_text_b64 text default null,
  p_context_prefix_b64 text default null,
  p_section_heading_b64 text default null,
  p_locator_b64 text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chunk_embeddings set
    text = case when p_text_b64 is null then text
                else convert_from(decode(p_text_b64, 'base64'), 'UTF8') end,
    embedding_text = case when p_embedding_text_b64 is null then embedding_text
                else convert_from(decode(p_embedding_text_b64, 'base64'), 'UTF8') end,
    context_prefix = case when p_context_prefix_b64 is null then context_prefix
                else convert_from(decode(p_context_prefix_b64, 'base64'), 'UTF8') end,
    section_heading = case when p_section_heading_b64 is null then section_heading
                else convert_from(decode(p_section_heading_b64, 'base64'), 'UTF8') end,
    locator = case when p_locator_b64 is null then locator
                else convert_from(decode(p_locator_b64, 'base64'), 'UTF8') end
  where chunk_id::text = p_chunk_id;
end;
$$;

revoke all on function public.set_chunk_text_b64(text, text, text, text, text, text) from anon, authenticated;
grant execute on function public.set_chunk_text_b64(text, text, text, text, text, text) to service_role;
