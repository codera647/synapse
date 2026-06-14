-- Let org co-members read each other's basic profile (name, email, avatar).
-- The default users policy is `auth.uid() = id` (read only your own row), which means teammate
-- names can't be shown in the Team screen / team library "by <owner>" tags. This adds a second
-- permissive SELECT policy (policies OR together) granting read access to anyone who shares an
-- organization with you. Run once in the Supabase SQL editor.

drop policy if exists users_read_comembers on public.users;
create policy users_read_comembers on public.users for select
  using (
    auth.uid() = id
    or exists (
      select 1
      from public.organization_members m_self
      join public.organization_members m_other
        on m_self.organization_id = m_other.organization_id
      where m_self.user_id = auth.uid()
        and m_other.user_id = users.id
    )
  );
