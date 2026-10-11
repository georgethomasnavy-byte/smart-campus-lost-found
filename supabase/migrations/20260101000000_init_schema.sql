-- ============================================================================
--  SMART CAMPUS LOST AND FOUND  ·  Migration 1 of 4  ·  SCHEMA
-- ============================================================================
--  Creates every table, enum, constraint, index and trigger function used by
--  the application.  Run this FIRST, in order, in the Supabase SQL editor
--  (or with `supabase db push`).
--
--  Roles covered: student (default) and admin.
--  Everything is normalised: profiles -> items -> claims / matches / reports,
--  with notifications and activity_logs as the audit + messaging side tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";     -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Enumerated types
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.user_role          as enum ('student', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_type          as enum ('lost', 'found');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_category      as enum (
    'Electronics', 'ID Cards', 'Wallets', 'Keys', 'Bags',
    'Books', 'Clothing', 'Accessories', 'Documents', 'Other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_status        as enum (
    'active', 'matched', 'claimed', 'returned', 'closed', 'rejected'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.verification_status as enum ('pending', 'verified', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.claim_status        as enum ('pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.match_status        as enum ('suggested', 'accepted', 'dismissed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type   as enum (
    'match', 'match_accepted', 'claim_submitted', 'claim_approved',
    'claim_rejected', 'claim_cancelled', 'report_verified', 'report_rejected',
    'item_status', 'system'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.report_status       as enum ('pending', 'reviewed', 'dismissed', 'actioned');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. profiles  ·  one row per authenticated user (public.user)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  full_name   text not null check (char_length(trim(full_name)) between 3 and 80),
  email       text not null check (position('@' in email) > 1),
  role        public.user_role not null default 'student',
  phone       text check (phone is null or char_length(phone) <= 20),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile for every auth user. Role lives here and is never accepted from the client.';

-- ---------------------------------------------------------------------------
-- 3. items  ·  every lost / found report
-- ---------------------------------------------------------------------------
create table if not exists public.items (
  id                  uuid primary key default gen_random_uuid(),
  reported_by         uuid not null references public.profiles (user_id) on delete cascade,
  type                public.item_type not null,
  title               text not null check (char_length(trim(title)) between 2 and 120),
  category            public.item_category not null,
  description         text not null check (char_length(trim(description)) between 5 and 2000),
  location            text not null check (char_length(trim(location)) between 2 and 120),
  date_occurred       date not null check (date_occurred <= current_date),
  image_url           text,
  image_path          text,                        -- storage object path, used for cleanup
  status              public.item_status not null default 'active',
  verification_status public.verification_status not null default 'pending',
  resolved_at         timestamptz,                 -- set when returned / closed
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- database-backed full text search over the searchable columns
  search_vector       tsvector generated always as (
                        to_tsvector('english',
                          coalesce(title, '') || ' ' ||
                          coalesce(description, '') || ' ' ||
                          coalesce(location, '') || ' ' ||
                          replace(category::text, ' ', '_'))
                      ) stored
);

comment on table public.items is 'Lost and found reports. Only LOST vs FOUND pairs are ever matched.';

create index if not exists idx_items_type_status      on public.items (type, status);
create index if not exists idx_items_category         on public.items (category);
create index if not exists idx_items_location         on public.items (location);
create index if not exists idx_items_date_occurred    on public.items (date_occurred desc);
create index if not exists idx_items_reported_by      on public.items (reported_by);
create index if not exists idx_items_created_at       on public.items (created_at desc);
create index if not exists idx_items_verification     on public.items (verification_status);
create index if not exists idx_items_search_vector    on public.items using gin (search_vector);
create index if not exists idx_items_title_trgm       on public.items (lower(title));

-- ---------------------------------------------------------------------------
-- 4. claims  ·  a user asking to collect a found item (or a finder claim)
-- ---------------------------------------------------------------------------
create table if not exists public.claims (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.items (id) on delete cascade,
  claimant_id  uuid not null references public.profiles (user_id) on delete cascade,
  message      text not null check (char_length(trim(message)) between 15 and 1000),
  status       public.claim_status not null default 'pending',
  admin_notes  text check (admin_notes is null or char_length(admin_notes) <= 500),
  reviewed_by  uuid references public.profiles (user_id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- one open claim per user per item
  constraint uq_claim_per_user_item unique (item_id, claimant_id)
);

create index if not exists idx_claims_item      on public.claims (item_id, status);
create index if not exists idx_claims_claimant  on public.claims (claimant_id, status);
create index if not exists idx_claims_status    on public.claims (status);

-- ---------------------------------------------------------------------------
-- 5. matches  ·  deterministic (non-AI) similarity results, lost <-> found
-- ---------------------------------------------------------------------------
create table if not exists public.matches (
  id                uuid primary key default gen_random_uuid(),
  lost_item_id      uuid not null references public.items (id) on delete cascade,
  found_item_id     uuid not null references public.items (id) on delete cascade,
  score             smallint not null check (score between 0 and 100),
  matching_details  jsonb not null default '{}'::jsonb,
  status            public.match_status not null default 'suggested',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_match_pair_distinct check (lost_item_id <> found_item_id),
  constraint uq_match_pair unique (lost_item_id, found_item_id)
);

comment on table public.matches is
  'Output of the rule-based matching algorithm. Score is computed deterministically; it is immutable once written.';

create index if not exists idx_matches_lost   on public.matches (lost_item_id);
create index if not exists idx_matches_found  on public.matches (found_item_id);
create index if not exists idx_matches_score  on public.matches (score desc);

-- ---------------------------------------------------------------------------
-- 6. notifications  ·  in-app only (no paid e-mail / SMS)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (user_id) on delete cascade,
  title             text not null,
  message           text not null default '',
  type              public.notification_type not null default 'system',
  related_item_id   uuid references public.items (id) on delete cascade,
  related_claim_id  uuid references public.claims (id) on delete cascade,
  is_read           boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists idx_notifications_user    on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_unread  on public.notifications (user_id, is_read);

-- ---------------------------------------------------------------------------
-- 7. reports  ·  abuse / problem reports raised against an item by a student
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reported_by  uuid not null references public.profiles (user_id) on delete cascade,
  item_id      uuid not null references public.items (id) on delete cascade,
  reason       text not null check (char_length(trim(reason)) between 3 and 120),
  description  text check (description is null or char_length(description) <= 1000),
  status       public.report_status not null default 'pending',
  reviewed_by  uuid references public.profiles (user_id) on delete set null,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);

create index if not exists idx_reports_status on public.reports (status, created_at desc);
create index if not exists idx_reports_item   on public.reports (item_id);

-- ---------------------------------------------------------------------------
-- 8. activity_logs  ·  immutable audit trail (admins read, nobody edits)
-- ---------------------------------------------------------------------------
create table if not exists public.activity_logs (
  id           bigserial primary key,
  user_id      uuid references public.profiles (user_id) on delete set null,
  action       text not null,
  entity_type  text not null default 'system',
  entity_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_logs_created on public.activity_logs (created_at desc);
create index if not exists idx_logs_action  on public.activity_logs (action);
create index if not exists idx_logs_user    on public.activity_logs (user_id);

-- ============================================================================
-- 9. Helper functions used by the RLS policies (migration 2) and triggers
-- ============================================================================

-- Is the caller an administrator?  SECURITY DEFINER so it can read profiles
-- even though the caller may not have SELECT rights on that table.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'True when the current JWT belongs to an admin. Used by every admin-level RLS policy.';

-- True when the current write is performed by trusted server-side code
-- (a SECURITY DEFINER trigger/function) instead of by a client request.
-- Such writes may touch columns that are otherwise protected.
--
-- Two independent signals are required, so a browser client cannot fake it:
--   * app.internal_write GUC - set transaction-locally by our definer
--     functions; a REST client has no way to set it.
--   * pg_trigger_depth() > 1 - the write happens inside another trigger,
--     which is only reachable through our own definer triggers.
create or replace function public.internal_write()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.internal_write', true), 'off') = 'on'
      or pg_trigger_depth() > 1;
$$;

comment on function public.internal_write() is
  'Marks writes made by trusted SECURITY DEFINER trigger code so integrity guards can let them through.';

-- Convenience: the caller's user id as uuid (null when anonymous)
create or replace function public.current_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

-- keep updated_at fresh on every UPDATE
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Generic audit writer.  SECURITY DEFINER so trigger code can always write,
-- while the RLS INSERT policy still restricts what the client may write.
create or replace function public.write_activity_log(
  p_user_id     uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_details     jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (p_user_id, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Generic notification writer (definer: triggers notify OTHER users safely)
create or replace function public.create_notification(
  p_user_id         uuid,
  p_title           text,
  p_message         text,
  p_type            public.notification_type,
  p_item_id         uuid default null,
  p_claim_id        uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (user_id, title, message, type, related_item_id, related_claim_id)
  values (p_user_id, p_title, p_message, p_type, p_item_id, p_claim_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- ============================================================================
-- 10. Triggers
-- ============================================================================

-- 10.1  A new auth user automatically gets a profile row with role 'student'.
--       The role can never come from the client: it is hard-coded here.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(new.email, '@', 1)
  );
  -- keep the check(constraint) happy even for very short e-mail prefixes
  if char_length(v_name) < 3 then
    v_name := v_name || '_user';
  end if;

  insert into public.profiles (user_id, full_name, email, role, phone)
  values (new.id, left(v_name, 80), new.email, 'student', null)
  on conflict (user_id) do nothing;

  perform public.write_activity_log(new.id, 'user_registered', 'profile', new.id,
                                    jsonb_build_object('email', new.email));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 10.2  updated_at maintenance
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_items_updated on public.items;
create trigger trg_items_updated before update on public.items
  for each row execute function public.set_updated_at();

drop trigger if exists trg_claims_updated on public.claims;
create trigger trg_claims_updated before update on public.claims
  for each row execute function public.set_updated_at();

drop trigger if exists trg_matches_updated on public.matches;
create trigger trg_matches_updated before update on public.matches
  for each row execute function public.set_updated_at();

-- 10.3  Log item creation and edits
create or replace function public.log_item_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_activity_log(new.reported_by, 'report_created', 'item', new.id,
      jsonb_build_object('type', new.type, 'title', new.title, 'category', new.category));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform public.write_activity_log(coalesce(auth.uid(), new.reported_by), 'item_status_changed', 'item', new.id,
        jsonb_build_object('from', old.status, 'to', new.status, 'title', new.title));
    end if;
    if new.verification_status is distinct from old.verification_status then
      perform public.write_activity_log(coalesce(auth.uid(), new.reported_by), 'report_' || new.verification_status,
        'item', new.id, jsonb_build_object('title', new.title, 'verification_status', new.verification_status));
    end if;
    if new.status in ('returned', 'closed') and old.status not in ('returned', 'closed') then
      perform public.write_activity_log(coalesce(auth.uid(), new.reported_by), 'item_' || new.status, 'item', new.id,
        jsonb_build_object('title', new.title));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_items_log on public.items;
create trigger trg_items_log after insert or update on public.items
  for each row execute function public.log_item_change();

-- 10.4  Notify the reporter when an admin verifies or rejects their report
create or replace function public.notify_verification_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.verification_status is distinct from old.verification_status then
    if new.verification_status = 'verified' then
      perform public.create_notification(new.reported_by,
        'Report verified',
        'Your report "' || new.title || '" has been verified by an administrator.',
        'report_verified', new.id, null);
    elsif new.verification_status = 'rejected' then
      perform public.create_notification(new.reported_by,
        'Report rejected',
        'Your report "' || new.title || '" was rejected. Please review the campus lost-and-found guidelines.',
        'report_rejected', new.id, null);
    end if;
  end if;

  if new.status = 'rejected' and old.status <> 'rejected' then
    perform public.create_notification(new.reported_by,
      'Report removed',
      'Your report "' || new.title || '" has been removed by an administrator.',
      'item_status', new.id, null);
  end if;

  if new.status = 'returned' and old.status <> 'returned' then
    perform public.create_notification(new.reported_by,
      'Item recovered',
      '"' || new.title || '" has been marked as returned. Thank you for using the campus lost and found.',
      'item_status', new.id, null);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_items_notify on public.items;
create trigger trg_items_notify after update on public.items
  for each row execute function public.notify_verification_change();

-- 10.5  Claims: notify admins on submission, set the item status to 'claimed'
create or replace function public.on_claim_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   public.items;
  v_admin  record;
  v_name   text;
begin
  select * into v_item from public.items where id = new.item_id;
  select full_name into v_name from public.profiles where user_id = new.claimant_id;

  -- every admin is told about the new claim
  for v_admin in select user_id from public.profiles where role = 'admin' loop
    perform public.create_notification(v_admin.user_id,
      'New claim awaiting review',
      coalesce(v_name, 'A student') || ' submitted a claim for "' || v_item.title || '".',
      'claim_submitted', v_item.id, new.id);
  end loop;

  -- the claimer sees it in their own feed too
  perform public.create_notification(new.claimant_id,
    'Claim submitted',
    'Your claim for "' || v_item.title || '" is pending administrator review.',
    'claim_submitted', v_item.id, new.id);

  -- the item is now claimed (unless it is already returned)
  if v_item.status in ('active', 'matched') then
    perform set_config('app.internal_write', 'on', true);
    update public.items set status = 'claimed' where id = v_item.id;
    perform set_config('app.internal_write', 'off', true);
  end if;

  perform public.write_activity_log(new.claimant_id, 'claim_created', 'claim', new.id,
    jsonb_build_object('item_id', new.item_id, 'title', v_item.title));
  return new;
end;
$$;

drop trigger if exists trg_claims_created on public.claims;
create trigger trg_claims_created after insert on public.claims
  for each row execute function public.on_claim_created();

-- 10.6  Claims: admin decision -> notify claimant + reporter, resolve the item
create or replace function public.on_claim_reviewed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.items;
begin
  if new.status is distinct from old.status and new.status in ('approved', 'rejected', 'cancelled') then
    select * into v_item from public.items where id = new.item_id;

    if new.status = 'approved' then
      perform public.create_notification(new.claimant_id,
        'Claim approved',
        'Your claim for "' || v_item.title || '" was approved. Please collect it from the campus lost-and-found desk.',
        'claim_approved', v_item.id, new.id);

      perform public.create_notification(v_item.reported_by,
        'Item returned to its owner',
        '"' || v_item.title || '" has been handed over after claim verification.',
        'claim_approved', v_item.id, new.id);

      perform set_config('app.internal_write', 'on', true);
      update public.items
         set status = 'returned', resolved_at = now()
       where id = v_item.id;

      -- any other pending claim on the same item is auto-rejected
      update public.claims
         set status = 'rejected',
             admin_notes = coalesce(admin_notes, 'Item was returned to another claimant.'),
             reviewed_by = new.reviewed_by,
             reviewed_at = now()
       where item_id = v_item.id and id <> new.id and status = 'pending';
      perform set_config('app.internal_write', 'off', true);

    elsif new.status = 'rejected' then
      perform public.create_notification(new.claimant_id,
        'Claim rejected',
        coalesce('Your claim for "' || v_item.title || '" was rejected. ' || new.admin_notes,
                 'Your claim for "' || v_item.title || '" was rejected.'),
        'claim_rejected', v_item.id, new.id);

      -- item becomes available again
      if v_item.status = 'claimed' then
        perform set_config('app.internal_write', 'on', true);
        update public.items set status = 'active' where id = v_item.id;
        perform set_config('app.internal_write', 'off', true);
      end if;

    elsif new.status = 'cancelled' then
      perform public.create_notification(v_item.reported_by,
        'Claim withdrawn',
        'A claim on "' || v_item.title || '" was withdrawn by the claimant.',
        'claim_cancelled', v_item.id, new.id);

      if v_item.status = 'claimed' then
        perform set_config('app.internal_write', 'on', true);
        update public.items set status = 'active' where id = v_item.id;
        perform set_config('app.internal_write', 'off', true);
      end if;
    end if;

    perform public.write_activity_log(coalesce(auth.uid(), new.claimant_id),
      'claim_' || new.status, 'claim', new.id,
      jsonb_build_object('item_id', new.item_id, 'title', v_item.title, 'notes', new.admin_notes));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_claims_reviewed on public.claims;
create trigger trg_claims_reviewed after update on public.claims
  for each row execute function public.on_claim_reviewed();

-- 10.7  New match -> notify both parties
create or replace function public.on_match_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lost   public.items;
  v_found  public.items;
begin
  select * into v_lost  from public.items where id = new.lost_item_id;
  select * into v_found from public.items where id = new.found_item_id;

  if new.score >= 60 then
    perform public.create_notification(v_lost.reported_by,
      'Possible match found',
      'Your lost item "' || v_lost.title || '" may have been found: "' || v_found.title ||
      '" at ' || v_found.location || ' (match score ' || new.score || '%).',
      'match', v_lost.id, null);

    perform public.create_notification(v_found.reported_by,
      'Possible owner found',
      'The item you found ("' || v_found.title || '") may belong to the reporter of "' || v_lost.title ||
      '" (match score ' || new.score || '%).',
      'match', v_found.id, null);
  end if;

  perform public.write_activity_log(v_lost.reported_by, 'match_created', 'match', new.id,
    jsonb_build_object('lost_item_id', new.lost_item_id, 'found_item_id', new.found_item_id, 'score', new.score));
  return new;
end;
$$;

drop trigger if exists trg_matches_created on public.matches;
create trigger trg_matches_created after insert on public.matches
  for each row execute function public.on_match_created();

-- 10.8  Integrity guards: values students must never be able to change.
--       RLS decides WHO may update a row; these triggers decide WHAT they may touch.

create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.internal_write() or public.is_admin()) then
    if new.role is distinct from old.role then
      raise exception 'Changing a role is not allowed.' using errcode = '42501';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'Changing the account link is not allowed.' using errcode = '42501';
    end if;
    if new.email is distinct from old.email then
      raise exception 'E-mail addresses cannot be changed here.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile on public.profiles;
create trigger trg_guard_profile before update on public.profiles
  for each row execute function public.guard_profile_update();

create or replace function public.guard_item_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.internal_write() or public.is_admin() then
    return new;                        -- trusted server-side code / admins
  end if;

  if new.reported_by is distinct from old.reported_by then
    raise exception 'A report cannot be re-assigned to another user.' using errcode = '42501';
  end if;

  -- a student may only close their own active report, never mark it returned
  if new.status is distinct from old.status
     and new.status not in ('closed', 'active') then
    raise exception 'Only an administrator can set the status "%".', new.status using errcode = '42501';
  end if;

  if new.verification_status is distinct from old.verification_status then
    raise exception 'Verification status can only be changed by an administrator.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_item on public.items;
create trigger trg_guard_item before update on public.items
  for each row execute function public.guard_item_update();

create or replace function public.guard_match_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.internal_write() or public.is_admin() then
    return new;
  end if;

  if new.score            is distinct from old.score
     or new.lost_item_id  is distinct from old.lost_item_id
     or new.found_item_id is distinct from old.found_item_id
     or new.matching_details is distinct from old.matching_details then
    raise exception 'Match scores are computed by the matching engine and cannot be edited.' using errcode = '42501';
  end if;

  if new.status not in ('suggested', 'accepted', 'dismissed') then
    raise exception 'Invalid match status.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_match on public.matches;
create trigger trg_guard_match before update on public.matches
  for each row execute function public.guard_match_update();

create or replace function public.guard_claim_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.internal_write() or public.is_admin() then
    return new;
  end if;

  -- a student may only cancel their own pending claim, nothing else
  if new.status = 'cancelled' and old.status = 'pending' then
    if new.item_id     is distinct from old.item_id
       or new.claimant_id is distinct from old.claimant_id
       or new.message     is distinct from old.message
       or new.admin_notes is distinct from old.admin_notes then
      raise exception 'Only the claim status can be changed when cancelling.' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Only an administrator can review claims.' using errcode = '42501';
end;
$$;

drop trigger if exists trg_guard_claim on public.claims;
create trigger trg_guard_claim before update on public.claims
  for each row execute function public.guard_claim_update();

-- 10.9  Students may only mark their own notifications as read
create or replace function public.guard_notification_update()
returns trigger
language plpgsql
as $$
begin
  if public.internal_write() or public.is_admin() then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.title   is distinct from old.title
     or new.message is distinct from old.message
     or new.type    is distinct from old.type then
    raise exception 'Notifications can only be marked as read.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_notification on public.notifications;
create trigger trg_guard_notification before update on public.notifications
  for each row execute function public.guard_notification_update();

-- 10.10  Report (abuse) review logging
create or replace function public.on_report_reviewed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    perform public.write_activity_log(coalesce(auth.uid(), new.reported_by),
      'abuse_report_' || new.status, 'report', new.id,
      jsonb_build_object('item_id', new.item_id, 'reason', new.reason));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reports_reviewed on public.reports;
create trigger trg_reports_reviewed after update on public.reports
  for each row execute function public.on_report_reviewed();

-- ============================================================================
--  End of migration 1.  Next: 20260101000100_rls_policies.sql
-- ============================================================================
