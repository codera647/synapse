-- Team collaboration — Phase 1 foundation.
-- Run this ONCE in the Supabase SQL editor BEFORE deploying the Phase 1 frontend.
-- Idempotent (safe to re-run). See docs/team-collaboration-design.md.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Library ownership — who created each library (enables team pooling + keeps
--    personal libraries personal). Backfill existing libraries to the org owner.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.libraries
  add column if not exists created_by_user_id uuid references public.users(id);

update public.libraries l
set created_by_user_id = (
  select m.user_id
  from public.organization_members m
  where m.organization_id = l.organization_id
  order by (m.role = 'owner') desc, m.created_at asc
  limit 1
)
where l.created_by_user_id is null;

create index if not exists idx_libraries_owner on public.libraries(created_by_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Chat scope — personal threads stay private; team threads are shared.
--    Existing threads default to personal (is_team = false).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.chat_threads
  add column if not exists is_team boolean not null default false;

create index if not exists idx_chat_threads_team
  on public.chat_threads(organization_id, is_team);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Invitations — invite by email (works even if the invitee has no account yet).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  invited_by_user_id uuid not null references public.users(id),
  role text not null default 'member',
  token text not null unique,
  status text not null default 'pending',   -- pending | accepted | revoked | expired
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_by_user_id uuid references public.users(id),
  accepted_at timestamptz
);
create index if not exists idx_org_invites_email on public.organization_invitations(lower(email));
create index if not exists idx_org_invites_org on public.organization_invitations(organization_id);
-- At most one pending invite per (org, email).
create unique index if not exists uq_org_invites_pending
  on public.organization_invitations(organization_id, lower(email))
  where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Per-library sharing — a member explicitly shares one of their libraries with
--    a team (org). The team library pool = libraries shared to that org.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.team_library_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade, -- the TEAM
  library_id uuid not null references public.libraries(id) on delete cascade,
  shared_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, library_id)
);
create index if not exists idx_team_shares_org on public.team_library_shares(organization_id);
create index if not exists idx_team_shares_lib on public.team_library_shares(library_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS for the new sensitive tables (consistent with the chat tables, which use
--    public.is_org_member(org, user)). Members of the org can see its invitations
--    and shares; inserts are constrained to members.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.organization_invitations enable row level security;
alter table public.team_library_shares enable row level security;

-- Invitations: org members can read/manage; an invitee can also read invites to their own email.
drop policy if exists org_invites_select on public.organization_invitations;
create policy org_invites_select on public.organization_invitations for select
  using (
    public.is_org_member(organization_id, auth.uid())
    or lower(email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
  );

drop policy if exists org_invites_write on public.organization_invitations;
create policy org_invites_write on public.organization_invitations for all
  using (public.is_org_member(organization_id, auth.uid()))
  with check (public.is_org_member(organization_id, auth.uid()));

-- Team library shares: visible to org members; only the library owner can share/unshare.
drop policy if exists team_shares_select on public.team_library_shares;
create policy team_shares_select on public.team_library_shares for select
  using (public.is_org_member(organization_id, auth.uid()));

drop policy if exists team_shares_write on public.team_library_shares;
create policy team_shares_write on public.team_library_shares for all
  using (shared_by_user_id = auth.uid())
  with check (shared_by_user_id = auth.uid() and public.is_org_member(organization_id, auth.uid()));
