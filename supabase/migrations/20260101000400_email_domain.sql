-- ============================================================================
--  SMART CAMPUS LOST AND FOUND  ·  Migration 5 of 5  ·  COLLEGE E-MAIL RULE
-- ============================================================================
--  Only college e-mail addresses may hold an account — enforced inside
--  PostgreSQL, because a check that lives only in the browser can be bypassed.
--
--  The domain is CONFIGURABLE, in one place. Default installed here:
--
--        saintgits.org
--
--  Change it any time (as an administrator, in the SQL editor):
--
--        select public.set_allowed_email_domain('yourcollege.edu');
--        -- or directly:
--        update public.app_settings set allowed_email_domain = 'yourcollege.edu';
--        -- accept every domain (handy for quick testing):
--        select public.set_allowed_email_domain('');
--
--  The running app reads this same value through public.allowed_email_domain(),
--  so the registration form and the database can never disagree.  If the app
--  cannot reach the function, it falls back to `collegeEmailDomain` in
--  src/environments/environment.ts — keep the two in step when you change it.
--
--  Safe to run repeatedly, like every other migration in this folder.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings table — exactly one row, enforced by the primary key + check
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id                   smallint primary key default 1 check (id = 1),
  allowed_email_domain text not null default 'saintgits.org'
                         check (position('@' in allowed_email_domain) = 0),
  updated_at           timestamptz not null default now()
);

comment on table public.app_settings is
  'Single-row application configuration. allowed_email_domain = "" accepts every e-mail domain.';

insert into public.app_settings (id, allowed_email_domain)
values (1, 'saintgits.org')
on conflict (id) do nothing;

drop trigger if exists trg_app_settings_updated on public.app_settings;
create trigger trg_app_settings_updated
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Row Level Security — everybody may read the rule, only admins change it
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;

grant select on public.app_settings to anon, authenticated;
grant update on public.app_settings to authenticated;

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select
  to anon, authenticated
  using (true);

drop policy if exists app_settings_update_admin on public.app_settings;
create policy app_settings_update_admin on public.app_settings
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. Public helper so the Angular registration form shows the same rule
-- ---------------------------------------------------------------------------
create or replace function public.allowed_email_domain()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select allowed_email_domain from public.app_settings where id = 1), '');
$$;

comment on function public.allowed_email_domain() is
  'The college e-mail domain accepted at registration. Empty string = any domain. Read by the registration form.';

revoke all on function public.allowed_email_domain() from public;
grant execute on function public.allowed_email_domain() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Administrator helper to change the rule safely
-- ---------------------------------------------------------------------------
create or replace function public.set_allowed_email_domain(p_domain text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator may change the college e-mail rule.'
      using errcode = 'insufficient_privilege';
  end if;

  v_domain := lower(trim(coalesce(p_domain, '')));
  v_domain := ltrim(v_domain, '@');

  if v_domain <> '' and position('.' in v_domain) = 0 then
    raise exception 'A domain needs at least one dot, e.g. saintgits.org (or empty to accept any).'
      using errcode = 'check_violation';
  end if;

  update public.app_settings set allowed_email_domain = v_domain where id = 1;

  perform public.write_activity_log(
    'email_domain_changed',
    'app_settings',
    null,
    jsonb_build_object('allowed_email_domain', v_domain)
  );

  return v_domain;
end $$;

revoke all on function public.set_allowed_email_domain(text) from public;
grant execute on function public.set_allowed_email_domain(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The enforcement itself — a BEFORE trigger on public.profiles
--    (profiles is created by the auth trigger inside the sign-up transaction,
--     so a rejected address makes the whole registration fail: no half-created
--     accounts, no orphan rows.)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_college_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text;
begin
  -- trusted server-side writes (administrators fixing data) are not blocked
  if public.internal_write() or public.is_admin() then
    return new;
  end if;

  select allowed_email_domain into v_domain from public.app_settings where id = 1;

  -- empty setting = no restriction
  if v_domain is null or v_domain = '' then
    return new;
  end if;

  if new.email is null or lower(new.email) not like '%@' || lower(v_domain) then
    raise exception 'Only % e-mail addresses may register.', v_domain
      using errcode = 'check_violation',
            hint = 'Ask the Lost & Found desk if you need an exception.';
  end if;

  return new;
end $$;

drop trigger if exists trg_profiles_email_domain on public.profiles;
create trigger trg_profiles_email_domain
  before insert or update of email on public.profiles
  for each row execute function public.enforce_college_email();

-- ---------------------------------------------------------------------------
-- 6. Verification helper — run this to see the rule that is active
-- ---------------------------------------------------------------------------
--   select public.allowed_email_domain();
--   (empty text means every domain is accepted)
-- ---------------------------------------------------------------------------
