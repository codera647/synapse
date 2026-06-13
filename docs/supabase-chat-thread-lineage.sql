-- Chat thread lineage: link auto-created continuation chats back to their parent.
--
-- When a chat's context window fills up, Synapse summarizes it and spawns a "continuation"
-- thread. These columns record that relationship so the sidebar can draw the connected
-- timeline (main chat -> child -> grandchild).
--
-- Run this once in the Supabase SQL editor BEFORE deploying the frontend that reads them.
-- Safe to re-run (idempotent).

alter table chat_threads
  add column if not exists parent_thread_id uuid references chat_threads(id) on delete set null,
  add column if not exists root_thread_id   uuid references chat_threads(id) on delete set null;

-- parent_thread_id: the thread this one was continued FROM (null for an original/root chat).
-- root_thread_id:   the original chat at the top of the lineage (null for a root chat; for a
--                   continuation it equals the root of its parent). Lets us group a whole
--                   lineage with one key: coalesce(root_thread_id, id).

create index if not exists idx_chat_threads_parent on chat_threads(parent_thread_id);
create index if not exists idx_chat_threads_root   on chat_threads(root_thread_id);
