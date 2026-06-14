# Team Chat — Multi-Org Redesign

The chat must stop depending on the dashboard's "current org." A user belongs to several
independent organizations (some they own, some they were invited to). The chat panel itself should
carry the org context.

## What's wrong today
- Team chat reads the dashboard's `currentOrg`, so a member has to switch orgs to reach a team.
- Personal chat shows `currentOrg`'s libraries — including ones shared into a team — instead of the
  user's own libraries.
- A user invited to someone else's org isn't the owner and shouldn't have to "switch orgs" to chat.

## New model — chat owns its org context

**Personal mode = your own stuff only.**
- Libraries: the ones **you created** (`libraries.created_by_user_id = you`), across all your orgs.
- Threads: your **private** threads (`created_by_user_id = you AND is_team = false`), across orgs.
- New personal thread is stamped with your **home org** (your first owned org) — purely to satisfy
  the not-null `organization_id`; it is never used to scope what you see.

**Team mode = pick a team, see what's shared with it.**
- An in-panel **team selector** (a dropdown), independent of the dashboard org. It lists every org
  you're a **member** of (your teams). If you're in just one, it's auto-selected; if several, you
  choose. No dashboard org-switching needed.
- The `+` library picker shows the libraries **shared into the selected team** (`team_library_shares`,
  i.e. what each owner allowed), each tagged with the **owner/teammate name** so you can tell whose
  library it is (they may live in different members' orgs).
- Threads: that team's **shared** threads (`is_team = true`, org = selected team) — visible to all
  members of that team.
- Retrieval already handles libraries that span orgs (the `cross_org` path + by-libraries RPC).

## UI
```
[ Personal | Team ]                          ← scope toggle (exists)
  └─ Team mode only:  [ ▼ Acme Team ]        ← team selector (your member orgs)
... chat threads + messages ...
[+]  → shared libraries of the selected team:  "Research PDFs · by Alice"
```

## Data flow (ChatWorkspace becomes self-sufficient)
On load it fetches, from the signed-in user:
- **member orgs** (`organization_members → organizations`) = the team-selector options + home org.
- **home org** = first org where role='owner' (fallback: first membership).
- **my libraries** (`created_by_user_id = me`) for personal mode.
- **selected team's shared libraries** (`team_library_shares` for the selected org → `libraries` +
  owner `users.name`) for team mode.

It passes to `ChatPanel`:
- `scope` (personal/team), the active `organization` (home org for personal, selected team for team),
  the right `libraries` list, and selection.

`ChatPanel` thread queries become:
- personal: `created_by_user_id = me AND is_team = false` (no org filter → your full history).
- team: `organization_id = <selectedTeam> AND is_team = true`.
Creation stamps `organization_id` = home org (personal) or selected team (team), and `is_team`.

## Net effect
- Invitees never touch the dashboard org switcher; they pick the team inside the chat.
- Personal chat is strictly your own libraries.
- A multi-team user switches teams in one dropdown and sees exactly what each team owner shared,
  labeled by who shared it.

## Open decisions
1. Team selector: list **all** orgs you're a member of, or only ones with **other members / shared
   libraries** (hide a solo personal org)?
2. Library tag in the picker: **owner name**, **org name**, or **both**?
