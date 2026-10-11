-- ============================================================================
--  SMART CAMPUS LOST AND FOUND  ·  Migration 4 of 4  ·  VIEWS & FUNCTIONS
-- ============================================================================
--  * profiles_public ........ safe reporter names for public listings
--  * public_stats() ......... real home-page counters (never hard-coded)
--  * admin_stats() .......... every number on the admin dashboard
--  * bootstrap_first_admin() secure one-time admin creation
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles_public
--    The profiles table is locked down (it holds e-mail, phone and role), so
--    public pages read the reporter's display name from this view instead.
--    Only two non-sensitive columns are exposed.
-- ---------------------------------------------------------------------------
create or replace view public.profiles_public as
  select user_id, full_name, role
  from public.profiles;

comment on view public.profiles_public is
  'Public-safe slice of profiles: display name + role only. No e-mail, no phone.';

grant select on public.profiles_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. public_stats()
--    Home page counters.  Aggregates only - no row data leaves the database.
-- ---------------------------------------------------------------------------
create or replace function public.public_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'active_lost_items',    (select count(*) from public.items
                              where type = 'lost'  and status not in ('rejected', 'returned', 'closed')),
    'found_items',          (select count(*) from public.items
                              where type = 'found' and status not in ('rejected', 'returned', 'closed')),
    'possible_matches',     (select count(*) from public.matches where status = 'suggested'),
    'recovered_items',      (select count(*) from public.items where status = 'returned'),
    'total_items',          (select count(*) from public.items where status <> 'rejected'),
    'registered_students',  (select count(*) from public.profiles where role = 'student')
  );
$$;

comment on function public.public_stats() is
  'Counters for the landing page. Safe for anonymous visitors: aggregate numbers only.';

grant execute on function public.public_stats() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_stats()
--    Every figure on the administrator dashboard, in one round trip.
--    Raises an exception for non-admins, so it cannot be called sideways.
-- ---------------------------------------------------------------------------
create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_students',        (select count(*) from public.profiles where role = 'student'),
    'total_admins',          (select count(*) from public.profiles where role = 'admin'),
    'total_items',           (select count(*) from public.items where status <> 'rejected'),
    'total_lost',            (select count(*) from public.items where type = 'lost'  and status <> 'rejected'),
    'total_found',           (select count(*) from public.items where type = 'found' and status <> 'rejected'),
    'pending_verification',  (select count(*) from public.items where verification_status = 'pending' and status <> 'rejected'),
    'verified_items',        (select count(*) from public.items where verification_status = 'verified'),
    'pending_claims',        (select count(*) from public.claims where status = 'pending'),
    'total_claims',          (select count(*) from public.claims),
    'approved_claims',       (select count(*) from public.claims where status = 'approved'),
    'rejected_claims',       (select count(*) from public.claims where status = 'rejected'),
    'possible_matches',      (select count(*) from public.matches),
    'strong_matches',        (select count(*) from public.matches where score >= 75),
    'recovered_items',       (select count(*) from public.items where status = 'returned'),
    'open_abuse_reports',    (select count(*) from public.reports where status = 'pending'),
    'recovery_rate',         coalesce((
                               select round(100.0 * count(*) filter (where status = 'returned')
                                            / nullif(count(*) filter (where status <> 'rejected'), 0))
                               from public.items), 0)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.admin_stats() is
  'All administrator KPI numbers. Second line of defence: raises unless the caller is an admin.';

revoke all on function public.admin_stats() from anon;
grant execute on function public.admin_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. bootstrap_first_admin()
--    Creating an admin must never be possible from the registration form.
--    This function succeeds ONLY while the database contains no admin at all,
--    which makes it safe to expose: after the first promotion it can never be
--    used again.  Run it once, right after your first sign-up:
--
--        select public.bootstrap_first_admin();
--
--    (The alternative, service-role method is documented in the README.)
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_first_admin()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_mail text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to claim the first administrator account.' using errcode = '42501';
  end if;

  if exists (select 1 from public.profiles where role = 'admin') then
    raise exception 'An administrator already exists. Ask them to promote you.' using errcode = '42501';
  end if;

  update public.profiles
     set role = 'admin'
   where user_id = v_uid
  returning email into v_mail;

  if v_mail is null then
    raise exception 'No profile found for the current user.' using errcode = '42501';
  end if;

  perform public.write_activity_log(v_uid, 'admin_bootstrapped', 'profile', v_uid,
                                    jsonb_build_object('email', v_mail));

  return jsonb_build_object('ok', true, 'email', v_mail, 'message', 'You are now an administrator.');
end;
$$;

comment on function public.bootstrap_first_admin() is
  'One-time, self-disabling promotion of the first administrator. Refuses as soon as one admin exists.';

revoke all on function public.bootstrap_first_admin() from anon;
grant execute on function public.bootstrap_first_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Convenience: per-category and per-month aggregates for the admin charts
-- ---------------------------------------------------------------------------
create or replace function public.admin_category_stats()
returns table (category public.item_category, total bigint, lost bigint, found bigint, returned bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  return query
    select i.category,
           count(*)                                   as total,
           count(*) filter (where i.type = 'lost')    as lost,
           count(*) filter (where i.type = 'found')   as found,
           count(*) filter (where i.status = 'returned') as returned
    from public.items i
    where i.status <> 'rejected'
    group by i.category
    order by total desc;
end;
$$;

revoke all on function public.admin_category_stats() from anon;
grant execute on function public.admin_category_stats() to authenticated;

-- ============================================================================
--  End of migration 4.  The database is now complete and secure.
--  See supabase/seed.sql for optional demo data.
-- ============================================================================
