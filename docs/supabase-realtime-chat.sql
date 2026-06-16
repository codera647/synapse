-- Real-time team chat: stream new messages to every member's screen (no refresh needed).
--
-- The ChatPanel subscribes to Supabase Realtime on `chat_messages` for the open thread. For those
-- events to be delivered, the table MUST be in the `supabase_realtime` publication. Run this once
-- in the Supabase SQL editor (idempotent).

-- 1) Add chat_messages to the realtime publication so INSERT/UPDATE events are broadcast.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- 2) (Optional) Ensure full row data is sent on UPDATE/DELETE events. INSERT already carries the
--    full new row, which is all the client needs, so this is only useful if you later stream partial
--    answers via UPDATEs.
-- alter table public.chat_messages replica identity full;

-- 3) RLS reminder (no change needed if team chat already works on refresh):
--    Realtime respects RLS — a member only receives a row if their SELECT policy on chat_messages
--    allows reading it. Since teammates can already see each other's messages after a refresh, the
--    SELECT policy is correct; Realtime will deliver the same rows live. Sources (chat_message_sources)
--    are fetched on demand when a message arrives, so they do NOT need to be added to the publication.
