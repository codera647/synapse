-- Record WHO sent each chat message, so team chats can show each user's avatar/name next to
-- their messages. Nullable (existing rows + assistant/system messages have no sender).
--
-- Run once in the Supabase SQL editor.

alter table public.chat_messages
  add column if not exists created_by_user_id uuid references public.users(id) on delete set null;

create index if not exists idx_chat_messages_sender
  on public.chat_messages (created_by_user_id);
