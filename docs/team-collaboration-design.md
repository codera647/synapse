# Team Collaboration — Design & Implementation Plan

Goal: a separate **Team** mode where members of an organization pool their libraries and chat
collaboratively, while the existing **Personal** chat stays private. Invites are by email.

## DECISIONS (locked 2026-06-14)
1. **Library sharing = EXPLICIT per-library.** Each member chooses which libraries to share with a
   team (via `team_library_shares`). The team pool = explicitly-shared libraries (NOT all member
   libraries). §1 & §3.1 updated accordingly.
2. **Email = Cloudflare Email Service** (frontend already runs on Cloudflare Workers).
3. **Personal chats become private-per-creator** (§1.3 migration); only Team-mode threads are shared.
4. **Build Phase 1 foundation first.**

---

## 0. The core model (and the one tricky bit)

**A "team" = an organization with more than one member.** The membership table
(`organization_members`) already exists, so teams are mostly an *access + UX* layer on top.

The tricky requirement from the example:

> User A (owns org1) invites User B (owns org2). B joins **org1**. A is **not** added to org2.
> Yet in the Team section A can use B's libraries **and** B can use A's libraries.

A's libraries live in org1; B's libraries live in org2. Plain org-membership only gets B access to
org1's libraries — not A access to B's (org2) libraries. So library access in a team can't be purely
org-scoped. The clean fix:

- Give every library an **owner** (`created_by_user_id`).
- **Team library pool = all libraries owned by any member of the team.** Because A and B are both
  members of org1, the team pool = (A's libraries) ∪ (B's libraries), regardless of which org each
  library physically sits in. This is exactly the mutual access the example asks for.

Two scopes, cleanly separated:

| | **Personal** (existing chat) | **Team** (new mode) |
|---|---|---|
| Libraries shown | only **your** libraries | every **team member's** libraries (pooled) |
| Chat threads | **private** to you | **shared** — visible to all team members |
| Where it lives | current dashboard | new "Team" mode/screen |

---

## 1. Data model changes

**1.1 Library ownership** (enables the team pool + keeps personal private)
```sql
alter table libraries add column if not exists created_by_user_id uuid references users(id);
-- backfill existing libraries to the org's owner:
update libraries l set created_by_user_id = (
  select m.user_id from organization_members m
  where m.organization_id = l.organization_id and m.role = 'owner' limit 1
) where l.created_by_user_id is null;
```

**1.2 Membership status + invitations.** `organization_members` already has `invited_by_user_id`.
Add a dedicated invitation table so we can invite people who **don't have an account yet** (email-first):
```sql
create table organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,                          -- invitee email (lowercased)
  invited_by_user_id uuid not null references users(id),
  role text not null default 'member',
  token text not null unique,                   -- random; used in the accept link
  status text not null default 'pending',       -- pending | accepted | revoked | expired
  created_at timestamptz default now(),
  expires_at timestamptz default now() + interval '14 days',
  accepted_by_user_id uuid references users(id),
  accepted_at timestamptz
);
create index on organization_invitations (email);
create index on organization_invitations (organization_id);
```
Accepting an invite simply inserts an `organization_members` row (org_id, user_id, role='member',
invited_by_user_id) and marks the invitation `accepted`. **One-directional** by design — only B joins
org1; nothing is added to org2.

**1.3 Chat scope (personal vs team).** Threads are currently loaded by `organization_id` only.
Add a scope so personal stays private and team is shared:
```sql
alter table chat_threads add column if not exists is_team boolean not null default false;
-- (created_by_user_id already exists)
```
- **Personal load:** `where organization_id = :org and created_by_user_id = :me and is_team = false`
- **Team load:**     `where organization_id = :teamOrg and is_team = true`  (visible to all members via RLS `is_org_member`)

> Migration note: existing threads become **personal** (`is_team=false`) and get filtered to their
> creator — so today's "everyone in an org sees all threads" quietly becomes correct/private.

---

## 2. Invitation + email flow

1. In **Team → Members**, A types B's email → `POST /api/team/invite` creates an
   `organization_invitations` row (token) and sends an email.
2. **Email** (see §6 for provider): *"User A (a@x.com) invited you to their team 'org1' on Synapse"*
   with an **Accept** button → `https://app/.../team/accept?token=…`. From a system address, with
   **reply-to = A's email** and A's name in the body (we can't literally send "as" A without their
   mail credentials — covered in §6).
3. B clicks the link:
   - **Logged in & registered** → membership created, invitation accepted, redirect into the team.
   - **Not registered** → register/login (token preserved through auth) → auto-accept on return.
4. **In-app inbox** (works even if email fails): when B logs in, pending invitations matching B's
   email show as a banner/"Invitations" list with **Accept / Decline**. This makes the feature usable
   from day one without email being perfectly configured.

---

## 3. Access & retrieval (backend)

**3.1 Team library list** (frontend, Supabase): libraries whose `created_by_user_id` is in the team's
member set:
```sql
select * from libraries
where created_by_user_id in (
  select user_id from organization_members where organization_id = :teamOrg
);
```
This naturally spans orgs (A's in org1, B's in org2) — which is the whole point.

**3.2 Cross-org retrieval.** Team chat may select libraries from **different orgs**, but
`match_chunk_embeddings` filters by a single `organization_id`. Add a library-scoped variant:
```sql
-- new RPC: filter purely by library_ids (authorization done before the call)
match_chunk_embeddings_by_libraries(p_library_ids uuid[], p_query_embedding vector(1024), p_match_count int)
```
The chat backend gets a `team_id` (and/or the pooled `library_ids`) and uses this RPC for team chats;
personal chats keep the existing org-scoped path. `keyword_search_chunks` gets the same treatment.

**3.3 Authorization.** v1: the frontend only offers libraries the user can access (team membership),
and the chat request carries the team id. Hardening (recommended, can follow): the chat backend
verifies the caller is a member of the team and that every requested `library_id` is owned by a team
member, before retrieving. (Ties into the broader "enable RLS" security follow-up.)

---

## 4. Frontend — the Team mode

**4.1 Mode switcher.** A top-level **Personal ⇄ Team** toggle (in the dashboard navbar/sidebar).
Personal = today's experience. Team = the new screen.

**4.2 Team screen.**
- **Team picker** — pick which team (org you're a member of with >1 member). If you have none, a
  "Create a team / invite someone" empty state.
- **Members panel** — list members (avatar, name, email, role), **Invite by email**, pending
  invitations (resend/revoke), remove member (owner only).
- **Team chat** — the existing `ChatPanel`, but: library picker shows the **pooled** team libraries
  (grouped by owner), threads are **shared** (`is_team=true`), and a small "owned by …" tag on each
  library. Everything else (typewriter, visuals, citations, thinking modes) reused as-is.

**4.3 Personal mode** — unchanged UX, but thread loading now filters by `created_by_user_id` so your
chats are private even in a shared org.

---

## 5. Security / authorization notes

- Membership is the single source of truth for access. Every team query is bounded by
  "user ∈ members(team)".
- The app currently runs RLS on chat tables only; libraries/docs/chunks rely on app-layer filtering +
  the service-role backend. Team access must be enforced in those same app-layer filters (and, when
  RLS is turned on org-wide later, by membership-based policies). This is the right time to add the
  `organizations` / `organization_members` / `libraries` RLS policies.
- Invitation tokens: random, single-org, expiring, single-use.

---

## 6. Email provider (decision needed)

No email capability exists today. Options:
- **Resend** — simplest transactional email, generous free tier, 1 API key, works from a Next.js
  route. Recommended for speed.
- **Cloudflare Email Service** — natural since the frontend already runs on Cloudflare Workers; no
  extra vendor.
- **In-app invitations only (v1)** — ship the invite/accept inbox first; add email later. Lowest
  effort, still fully functional (B just sees the invite when they log in).

"From User A's email": true send-as-A requires A's mail credentials/OAuth (out of scope). The
professional equivalent is a system sender + **A's name in the subject/body + reply-to: A**.

---

## 7. Phasing

- **Phase 1 — Foundation (no email):** library `created_by_user_id` + backfill; `is_team` on threads;
  personal-thread privacy filter; invitation table; **in-app** invite + accept inbox; membership
  management UI. → teams work end-to-end internally.
- **Phase 2 — Team chat:** Team mode switcher + Team screen; pooled library picker; shared threads;
  cross-org retrieval RPC + backend team path.
- **Phase 3 — Email:** provider wired (Resend/Cloudflare); invite emails + accept-link flow incl.
  not-yet-registered users.
- **Phase 4 — Polish:** roles/permissions (owner vs member actions), per-library sharing opt-out,
  leave-team, audit, RLS hardening.

---

## 8. Open decisions (confirm before building)

1. **Library pooling:** automatic (joining a team shares all your libraries with it) vs explicit
   per-library "share to team"? (Plan assumes automatic for v1, opt-out later.)
2. **Email:** Resend, Cloudflare Email Service, or in-app-only for v1?
3. **Personal-thread privacy:** OK to make existing org-shared threads private-per-creator (the
   migration in §1.3)?
4. **Start point:** build Phase 1 (foundation + in-app invites) first, or do the data model + Team
   chat together?
