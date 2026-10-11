-- ============================================================================
--  SMART CAMPUS LOST AND FOUND  ·  Migration 2 of 4  ·  ROW LEVEL SECURITY
-- ============================================================================
--  Security is enforced in the DATABASE, not only in Angular guards.
--
--  Every table has RLS enabled. A student talking directly to the Supabase
--  REST API (bypassing the Angular app entirely) can still only:
--    * read public listings
--    * create/edit their OWN reports
--    * create claims on other people's items
--    * read + mark-read their OWN notifications
--    * insert a small whitelist of self-service activity log entries
--
--  and can never:
--    * change their own role            (profiles: guard trigger + policy)
--    * edit another user's report       (items: policy)
--    * self-verify a report             (items: guard trigger)
--    * mark their own item "returned"   (items: guard trigger)
--    * approve their own claim          (claims: policy + guard trigger)
--    * change a match score             (matches: guard trigger)
--    * read or edit the activity log    (no policy for students)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Explicit privileges.  RLS then narrows them down row by row.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

-- anonymous visitors may only browse listings + the public helper view
grant select on public.items to anon;
revoke all on public.profiles, public.claims, public.matches,
              public.notifications, public.reports, public.activity_logs
       from anon;

grant select, insert, update, delete on public.profiles      to authenticated;
grant select, insert, update, delete on public.items         to authenticated;
grant select, insert, update, delete on public.claims        to authenticated;
grant select, insert, update, delete on public.matches       to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.reports       to authenticated;
grant select, insert                 on public.activity_logs to authenticated;
grant usage, select on sequence public.activity_logs_id_seq  to authenticated;

-- ---------------------------------------------------------------------------
-- 1. profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- a user may create their own profile row, but ONLY as a student
drop policy if exists profiles_insert_self_as_student on public.profiles;
create policy profiles_insert_self_as_student on public.profiles
  for insert to authenticated
  with check (user_id = auth.uid() and role = 'student');

drop policy if exists profiles_insert_admin on public.profiles;
create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_admin on public.profiles
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
-- NOTE: the trg_guard_profile trigger additionally blocks any change of
-- role / user_id / email by a non-admin, so "role" can never be self-elevated.

drop policy if exists profiles_delete_admin on public.profiles;
create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. items
-- ---------------------------------------------------------------------------
alter table public.items enable row level security;

-- everyone (even anonymous visitors) can browse everything except rejected
-- reports; the owner and admins can always see their own / everything.
drop policy if exists items_select_public on public.items;
create policy items_select_public on public.items
  for select to anon, authenticated
  using (
    status <> 'rejected'
    or reported_by = auth.uid()
    or public.is_admin()
  );

-- a student may only create an active, unverified report owned by themselves
drop policy if exists items_insert_own on public.items;
create policy items_insert_own on public.items
  for insert to authenticated
  with check (
    reported_by = auth.uid()
    and status = 'active'
    and verification_status = 'pending'
  );

drop policy if exists items_update_own_or_admin on public.items;
create policy items_update_own_or_admin on public.items
  for update to authenticated
  using (reported_by = auth.uid() or public.is_admin())
  with check (reported_by = auth.uid() or public.is_admin());
-- trg_guard_item limits WHAT a student may change (no self-verification, no
-- "returned" status, no re-assignment to another user).

-- deleting a report is allowed while it is unresolved and has no approved claim
drop policy if exists items_delete_own_or_admin on public.items;
create policy items_delete_own_or_admin on public.items
  for delete to authenticated
  using (
    public.is_admin()
    or (
      reported_by = auth.uid()
      and status in ('active', 'matched', 'closed')
      and not exists (
        select 1 from public.claims c
        where c.item_id = items.id and c.status = 'approved'
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. claims
-- ---------------------------------------------------------------------------
alter table public.claims enable row level security;

-- visible to the claimant, to the reporter of the item, and to admins
drop policy if exists claims_select_involved on public.claims;
create policy claims_select_involved on public.claims
  for select to authenticated
  using (
    claimant_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.items i
      where i.id = claims.item_id and i.reported_by = auth.uid()
    )
  );

-- a student may claim someone else's unresolved item only
drop policy if exists claims_insert_own on public.claims;
create policy claims_insert_own on public.claims
  for insert to authenticated
  with check (
    claimant_id = auth.uid()
    and status = 'pending'
    and admin_notes is null
    and reviewed_by is null
    and exists (
      select 1 from public.items i
      where i.id = claims.item_id
        and i.reported_by <> auth.uid()
        and i.status in ('active', 'matched', 'claimed')
        and i.verification_status <> 'rejected'
    )
  );

-- students may only touch their own pending claim (to cancel it);
-- approvals / rejections are admin-only.  trg_guard_claim enforces the rest.
drop policy if exists claims_update_claimant_or_admin on public.claims;
create policy claims_update_claimant_or_admin on public.claims
  for update to authenticated
  using (public.is_admin() or (claimant_id = auth.uid() and status = 'pending'))
  with check (public.is_admin() or (claimant_id = auth.uid() and status in ('pending', 'cancelled')));

drop policy if exists claims_delete_admin on public.claims;
create policy claims_delete_admin on public.claims
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. matches
-- ---------------------------------------------------------------------------
alter table public.matches enable row level security;

drop policy if exists matches_select_involved on public.matches;
create policy matches_select_involved on public.matches
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.items i
      where i.id in (matches.lost_item_id, matches.found_item_id)
        and i.reported_by = auth.uid()
    )
  );

-- The matching engine runs in the browser, so students may insert match rows
-- for THEIR OWN items only, and the database independently verifies that the
-- pair really is lost -> found.  Duplicate pairs are impossible thanks to the
-- unique constraint uq_match_pair.
drop policy if exists matches_insert_own_items on public.matches;
create policy matches_insert_own_items on public.matches
  for insert to authenticated
  with check (
    status = 'suggested'
    and score between 0 and 100
    and exists (
      select 1 from public.items i
      where i.id = matches.lost_item_id and i.type = 'lost'
    )
    and exists (
      select 1 from public.items i
      where i.id = matches.found_item_id and i.type = 'found'
    )
    and (
      public.is_admin()
      or exists (
        select 1 from public.items i
        where i.id in (matches.lost_item_id, matches.found_item_id)
          and i.reported_by = auth.uid()
      )
    )
  );

-- students may accept/dismiss a match that involves one of their own items.
-- trg_guard_match makes the score itself immutable.
drop policy if exists matches_update_involved on public.matches;
create policy matches_update_involved on public.matches
  for update to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.items i
      where i.id in (matches.lost_item_id, matches.found_item_id)
        and i.reported_by = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.items i
      where i.id in (matches.lost_item_id, matches.found_item_id)
        and i.reported_by = auth.uid()
    )
  );

drop policy if exists matches_delete_admin on public.matches;
create policy matches_delete_admin on public.matches
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. notifications
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Cross-user notifications are written by SECURITY DEFINER triggers, so
-- students do not need (and do not get) INSERT rights on this table.
drop policy if exists notifications_insert_admin on public.notifications;
create policy notifications_insert_admin on public.notifications
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
-- trg_guard_notification limits this to flipping is_read.

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- 6. reports  (abuse / problem reports raised by students)
-- ---------------------------------------------------------------------------
alter table public.reports enable row level security;

drop policy if exists reports_select_own_or_admin on public.reports;
create policy reports_select_own_or_admin on public.reports
  for select to authenticated
  using (reported_by = auth.uid() or public.is_admin());

drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
  for insert to authenticated
  with check (
    reported_by = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and exists (
      select 1 from public.items i
      where i.id = reports.item_id and i.reported_by <> auth.uid()
    )
  );

drop policy if exists reports_update_admin on public.reports;
create policy reports_update_admin on public.reports
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists reports_delete_admin on public.reports;
create policy reports_delete_admin on public.reports
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. activity_logs  ·  append-only audit trail
-- ---------------------------------------------------------------------------
alter table public.activity_logs enable row level security;

-- ONLY administrators can read the audit trail.
drop policy if exists activity_logs_select_admin on public.activity_logs;
create policy activity_logs_select_admin on public.activity_logs
  for select to authenticated
  using (public.is_admin());

-- A user may append a small whitelist of self-service events (login, profile
-- change).  Everything security-relevant is written by SECURITY DEFINER
-- triggers.  There is deliberately NO update and NO delete policy, which makes
-- the table append-only for every client, including admins.
drop policy if exists activity_logs_insert_self_service on public.activity_logs;
create policy activity_logs_insert_self_service on public.activity_logs
  for insert to authenticated
  with check (
    (user_id = auth.uid() and action in ('user_login', 'user_logout', 'profile_updated'))
    or public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- 8. Verification helper: check that RLS is on everywhere
-- ---------------------------------------------------------------------------
create or replace view public.rls_status as
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

comment on view public.rls_status is
  'Handy check: select * from public.rls_status;  every application table must show rls_enabled = true.';

grant select on public.rls_status to authenticated;

-- ============================================================================
--  End of migration 2.  Next: 20260101000200_storage.sql
-- ============================================================================
