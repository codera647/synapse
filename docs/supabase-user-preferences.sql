-- ─────────────────────────────────────────────────────────────────────────────
-- Synapse — user settings & personalization
--
-- 1. user_preferences: a 1:1 row per user holding identity + tone/style presets that
--    personalize chat responses (injected into the LLM system prompt at answer time).
-- 2. An `avatars` Storage bucket (public read) so users can upload a profile image; each
--    user may only write under their own `{uid}/...` folder. The public URL is saved into
--    public.users.avatar_url (which already exists and is read by the team member list).
--
-- Run once in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Preferences table ─────────────────────────────────────────────────────
create table if not exists public.user_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,

  -- Identity (About you)
  nickname text,
  occupation text,
  about_me text,

  -- Base tone: default | professional | friendly | concise
  base_tone text not null default 'default',

  -- Characteristic levels (mirrors ChatGPT "Characteristics"): default | more | less
  char_warmth text not null default 'default',
  char_enthusiasm text not null default 'default',
  char_headers_lists text not null default 'default',
  char_emoji text not null default 'default',

  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

-- A user can read/write only their own preferences row.
drop policy if exists user_prefs_rw on public.user_preferences;
create policy user_prefs_rw on public.user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── 2. Avatars storage bucket ────────────────────────────────────────────────
-- Public bucket so avatar URLs can be served without signing. Upsert the bucket row.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Anyone can READ avatar objects (public profile images).
drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects for select
  using (bucket_id = 'avatars');

-- A user may INSERT/UPDATE/DELETE objects only under their own top-level folder:
-- path convention = `{auth.uid()}/avatar.<ext>`  → foldername(name)[1] must equal their uid.
drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
