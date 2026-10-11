-- ============================================================================
--  SMART CAMPUS LOST AND FOUND  ·  OPTIONAL DEMO DATA
-- ============================================================================
--  ⚠  THIS FILE IS NEVER APPLIED AUTOMATICALLY.  The four files in
--     `supabase/migrations/` are the only scripts that must run.  This one is
--     for demonstrations, screenshots and classroom walkthroughs only.
--
--  HOW TO USE (README section "Optional demo data"):
--     1. Register at least one account through the running app.
--     2. Open Supabase → SQL editor → paste this whole file.
--     3. Change `demo_email` below to the e-mail you registered with.
--     4. Run it.  Then log in and open the dashboard: sample reports,
--        a demo match and the resulting notifications are all there.
--
--  HOW TO UNDO: run the DELETE block at the very bottom of this file.
--
--  NOTE: the e-mail must use the allowed college domain configured in
--  supabase/migrations/20260101000400_email_domain.sql (default: saintgits.org).
--
--  Notes
--   • Every row belongs to the e-mail you configure, so nothing is attributed
--     to a stranger and RLS never stops you editing it from the UI.
--   • The demo match carries an illustrative score (88) with a breakdown that
--     adds up to it.  Real scores are produced by the deterministic engine in
--     `src/app/core/matching/` whenever a report is created or edited — this
--     seed only demonstrates the notification and claim flow.
--   • Inserting into `matches` fires `trg_matches_created`, which writes the
--     notifications exactly like the application would.
-- ============================================================================

begin;

do $$
declare
  -- ⟱⟱⟱  CHANGE THIS to the e-mail you registered with  ⟱⟱⟱
  demo_email   text := 'student@saintgits.org';
  demo_user    uuid;
  lost_wallet  uuid;
  found_wallet uuid;
  lost_phone   uuid;
  found_bottle uuid;
begin
  select user_id into demo_user
  from public.profiles
  where lower(email) = lower(demo_email)
  limit 1;

  if demo_user is null then
    raise exception
      'No profile found for %. Register that account first, then set demo_email at the top of this script.',
      demo_email;
  end if;

  -- ---------------------------------------------------------------- items ---
  -- (guarded: re-running the script does not create duplicates)
  if not exists (select 1 from public.items where reported_by = demo_user and title = 'Black leather wallet') then
    insert into public.items (reported_by, type, title, category, description, location, date_occurred,
                              status, verification_status)
    values (demo_user, 'lost', 'Black leather wallet', 'Wallets',
            'Black leather bi-fold wallet with a small tear on the left zip. Contains my library card and a photo.',
            'Central Library, 2nd floor reading room', current_date - 3, 'active', 'verified')
    returning id into lost_wallet;
  else
    select id into lost_wallet from public.items
    where reported_by = demo_user and title = 'Black leather wallet' limit 1;
  end if;

  if not exists (select 1 from public.items where reported_by = demo_user and title = 'Found: black wallet near library') then
    insert into public.items (reported_by, type, title, category, description, location, date_occurred,
                              status, verification_status)
    values (demo_user, 'found', 'Found: black wallet near library', 'Wallets',
            'Found a black leather wallet with a broken zip on a study table. Handed to the reading-room desk.',
            'Central Library, 2nd floor reading room', current_date - 2, 'active', 'verified')
    returning id into found_wallet;
  else
    select id into found_wallet from public.items
    where reported_by = demo_user and title = 'Found: black wallet near library' limit 1;
  end if;

  if not exists (select 1 from public.items where reported_by = demo_user and title = 'Blue water bottle with stickers') then
    insert into public.items (reported_by, type, title, category, description, location, date_occurred,
                              status, verification_status)
    values (demo_user, 'lost', 'Blue water bottle with stickers', 'Other',
            'Stainless steel blue bottle covered in coding-club stickers, dented at the bottom.',
            'Canteen, near the juice counter', current_date - 6, 'active', 'pending')
    returning id into lost_phone;
  else
    select id into lost_phone from public.items
    where reported_by = demo_user and title = 'Blue water bottle with stickers' limit 1;
  end if;

  if not exists (select 1 from public.items where reported_by = demo_user and title = 'Found: umbrella in Block B') then
    insert into public.items (reported_by, type, title, category, description, location, date_occurred,
                              status, verification_status)
    values (demo_user, 'found', 'Found: umbrella in Block B', 'Accessories',
            'Folded blue umbrella with a wooden handle left in classroom B-204 after the evening lecture.',
            'Block B, classroom 204', current_date - 1, 'active', 'pending')
    returning id into found_bottle;
  else
    select id into found_bottle from public.items
    where reported_by = demo_user and title = 'Found: umbrella in Block B' limit 1;
  end if;

  -- -------------------------------------------------------------- matches ---
  -- Same pair as the §42 acceptance scenario: a lost wallet and a found wallet.
  if lost_wallet is not null and found_wallet is not null then
    insert into public.matches (lost_item_id, found_item_id, score, status, matching_details)
    values (
      lost_wallet,
      found_wallet,
      88,
      'suggested',
      jsonb_build_object(
        'level', 'strong',
        'algorithm', 'rule-based-v1',
        'weights', jsonb_build_object('category', 30, 'title', 25, 'description', 15, 'location', 20, 'date', 10),
        'breakdown', jsonb_build_array(
          jsonb_build_object('key', 'category', 'label', 'Category', 'points', 30, 'maxPoints', 30,
                             'explanation', 'Demo data: both reports use the "Wallets" category.'),
          jsonb_build_object('key', 'title',    'label', 'Item name', 'points', 22, 'maxPoints', 25,
                             'explanation', 'Demo data: "wallet" and "black leather" appear in both names.'),
          jsonb_build_object('key', 'description', 'label', 'Description', 'points', 14, 'maxPoints', 15,
                             'explanation', 'Demo data: both descriptions mention a black leather wallet and a zip.'),
          jsonb_build_object('key', 'location', 'label', 'Location', 'points', 17, 'maxPoints', 20,
                             'explanation', 'Demo data: both reports name the Central Library reading room.'),
          jsonb_build_object('key', 'date',     'label', 'Date', 'points', 5, 'maxPoints', 10,
                             'explanation', 'Demo data: the two dates are a few days apart.')
        )
      )
    )
    on conflict (lost_item_id, found_item_id) do nothing;

    -- the item statuses usually move to 'matched' when the app records a match
    update public.items
       set status = 'matched'
     where id in (lost_wallet, found_wallet)
       and status = 'active';
  end if;

  -- --------------------------------------------------------------- claims ---
  if found_wallet is not null then
    insert into public.claims (item_id, claimant_id, message, status)
    select found_wallet, demo_user,
           'This is my wallet: it is black leather, the left zip is torn, and it holds my library card and a family photo.',
           'pending'
    where not exists (
      select 1 from public.claims c
      where c.item_id = found_wallet and c.claimant_id = demo_user
    );
  end if;

  -- ---------------------------------------------------------- notifications ---
  insert into public.notifications (user_id, title, message, type, related_item_id)
  values (demo_user, 'Demo data loaded',
          'Sample reports, one match and one claim were created for your account. Explore the dashboard, matches and claims pages.',
          'system', lost_wallet);

  raise notice 'Demo data ready for % (user id %).', demo_email, demo_user;
end $$;

commit;

-- ============================================================================
--  UNDO  ·  run this block to remove everything the block above created
-- ============================================================================
-- begin;
-- delete from public.notifications
--  where user_id in (select user_id from public.profiles where email = 'student@saintgits.org')
--    and title = 'Demo data loaded';
-- delete from public.claims
--  where claimant_id in (select user_id from public.profiles where email = 'student@saintgits.org')
--    and item_id in (select id from public.items where title in
--      ('Black leather wallet', 'Found: black wallet near library',
--       'Blue water bottle with stickers', 'Found: umbrella in Block B'));
-- delete from public.items
--  where title in ('Black leather wallet', 'Found: black wallet near library',
--                  'Blue water bottle with stickers', 'Found: umbrella in Block B');
-- -- matches and their notifications disappear automatically (ON DELETE CASCADE)
-- commit;
