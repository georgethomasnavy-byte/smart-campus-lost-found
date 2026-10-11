#!/usr/bin/env node
/**
 * Live Supabase acceptance test for the current campus lost-and-found workflow.
 *
 * This test uses only the public anon key and signed-in user sessions. It does
 * not create or promote an administrator: configure E2E_ADMIN_EMAIL and
 * E2E_ADMIN_PASSWORD for a pre-provisioned administrator account. The first
 * administrator must be provisioned by the trusted Supabase project owner as
 * documented in START-HERE.md.
 *
 * Required migrations: all seven files in supabase/migrations/, in filename
 * order. Disable Supabase email confirmation for the temporary test accounts.
 *
 * The test creates throw-away campus accounts, reports, photos, one match and
 * claims. Cleanup removes item/claim/match/private-detail/notification rows by
 * deleting the test items, and removes photos where possible. Auth accounts
 * and append-only audit records remain for manual cleanup/inspection.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function loadDotEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const current = line.trim();
    if (!current || current.startsWith('#')) continue;
    const split = current.indexOf('=');
    if (split < 0) continue;
    values[current.slice(0, split).trim()] = current.slice(split + 1).trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

const dotenv = loadDotEnv();
const env = (name, fallback = '') => (process.env[name] ?? dotenv[name] ?? fallback).trim();
const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');
const ADMIN_EMAIL = env('E2E_ADMIN_EMAIL');
const ADMIN_PASSWORD = env('E2E_ADMIN_PASSWORD');
let EMAIL_DOMAIN = env('E2E_EMAIL_DOMAIN', 'example.test');

function fatal(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR')) {
  fatal('Set SUPABASE_URL and SUPABASE_ANON_KEY before running the live acceptance test. See .env.example.');
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  fatal('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to an existing, pre-provisioned administrator. This test never creates an admin.');
}

const { createClient } = await import('@supabase/supabase-js');
const { build } = await import('esbuild');
const engineDir = join(root, '.angular', 'e2e');
mkdirSync(engineDir, { recursive: true });
const engineFile = join(engineDir, 'engine.mjs');
await build({
  stdin: {
    contents: [
      "export * from './src/app/core/matching/matching.engine.ts';",
      "export * from './src/app/core/matching/matching.config.ts';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'e2e-engine-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: engineFile,
  logLevel: 'silent',
});
const { findMatches, buildMatchDetails, scoreToLevel, MIN_MATCH_SCORE } = await import(`file://${engineFile}`);

const results = [];
let failures = 0;
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function check(label, passed, detail = '') {
  const ok = Boolean(passed);
  if (!ok) failures += 1;
  results.push({ label, ok, detail: String(detail ?? '') });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m(${detail})\x1b[0m` : ''}`);
  return ok;
}
function assert(label, passed, detail = '') {
  if (!check(label, passed, detail)) throw new Error(`Acceptance check failed: ${label}${detail ? ` — ${detail}` : ''}`);
}
function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = `E2e-Campus-${runId}-Aa9!`;
const created = { items: [], storage: [] };
const userClients = new Map();
let admin = null;
let adminUser = null;
let emailDomainSource = 'E2E_EMAIL_DOMAIN fallback';
const testEmail = (label) => `e2e.${label}.${runId}@${EMAIL_DOMAIN}`;

async function resolveEmailDomain(anon) {
  try {
    const { data, error } = await anon.rpc('allowed_email_domain');
    if (!error && typeof data === 'string') {
      if (data.trim()) {
        EMAIL_DOMAIN = data.trim();
        emailDomainSource = 'allowed_email_domain()';
      } else {
        emailDomainSource = 'database allows any domain; E2E_EMAIL_DOMAIN used for test accounts';
      }
    }
  } catch {
    emailDomainSource = 'could not read database setting; E2E_EMAIL_DOMAIN fallback';
  }
}

async function signUpCampusMember(label, fullName, campusRole = 'student') {
  const client = makeClient();
  const address = testEmail(label);
  const { data, error } = await client.auth.signUp({
    email: address,
    password: PASSWORD,
    options: { data: { full_name: fullName, campus_role: campusRole } },
  });
  if (error) {
    throw new Error(`Could not register ${address}: ${error.message}. Check the email-domain rule and disable email confirmation for the test.`);
  }
  if (!data.session || !data.user) {
    throw new Error(`Supabase returned no session for ${address}; disable email confirmation for the temporary E2E accounts.`);
  }
  userClients.set(data.user.id, client);
  return { client, user: data.user, email: address };
}

async function uploadPhoto(client, userId, label) {
  // A tiny valid PNG so the real storage bucket and per-user folder policy run.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const path = `${userId}/acceptance-${label}-${runId}.png`;
  const { error } = await client.storage.from('item-images').upload(path, png, {
    contentType: 'image/png',
    upsert: false,
  });
  if (error) throw new Error(`Photo upload failed (${label}): ${error.message}`);
  created.storage.push({ path, userId });
  const { data } = client.storage.from('item-images').getPublicUrl(path);
  return { path, url: data.publicUrl };
}

async function createItemReport(client, input) {
  const { data, error } = await client.rpc('create_item_report', {
    p_type: input.type,
    p_title: input.title,
    p_category: input.category,
    p_description: input.description,
    p_location: input.location,
    p_date_occurred: input.dateOccurred,
    p_keywords: input.keywords,
    p_identifying_characteristics: input.characteristics,
    p_collection_instructions: input.collectionInstructions ?? null,
    p_exact_found_location: input.exactFoundLocation ?? null,
    p_image_url: input.imageUrl ?? null,
    p_image_path: input.imagePath ?? null,
  });
  if (error) throw new Error(`create_item_report(${input.type}) failed: ${error.message}`);
  if (!data || typeof data.id !== 'string') throw new Error(`create_item_report(${input.type}) returned no item id`);
  created.items.push(data.id);
  return data;
}

async function notificationsFor(client, userId) {
  const { data, error } = await client.from('notifications').select('*').eq('user_id', userId);
  if (error) throw new Error(`Notification read failed: ${error.message}`);
  return data ?? [];
}

async function cleanup() {
  if (!admin) return;
  section('Cleanup');
  let deletedItems = 0;
  for (const id of [...new Set(created.items)].reverse()) {
    const { data, error } = await admin.from('items').delete().eq('id', id).select('id');
    if (!error && data?.length) deletedItems += 1;
    else if (error) console.log(`  \x1b[2mcleanup note: item ${id}: ${error.message}\x1b[0m`);
  }
  let deletedPhotos = 0;
  for (const file of created.storage) {
    const owner = userClients.get(file.userId);
    if (!owner) continue;
    const { error } = await owner.storage.from('item-images').remove([file.path]);
    if (!error) deletedPhotos += 1;
    else console.log(`  \x1b[2mcleanup note: photo ${file.path}: ${error.message}\x1b[0m`);
  }
  check('created item rows removed (claims, matches, private detail and linked notifications cascade)', deletedItems === new Set(created.items).size, `${deletedItems}/${new Set(created.items).size} items`);
  check('uploaded photos removed where the owner policy permits', deletedPhotos === created.storage.length, `${deletedPhotos}/${created.storage.length} photos`);
  console.log('  \x1b[2mTemporary auth accounts and immutable activity-log records remain; remove accounts in Supabase Auth if desired.\x1b[0m');
}

async function runScenario() {
  const anon = makeClient();
  await resolveEmailDomain(anon);
  console.log('\x1b[1mSmart Campus Lost and Found — Supabase acceptance test\x1b[0m');
  console.log(`  Project : ${SUPABASE_URL}`);
  console.log(`  Run id  : ${runId}`);
  console.log(`  Domain  : @${EMAIL_DOMAIN} (${emailDomainSource})`);

  // The admin is a pre-existing, out-of-band provisioned account. Never sign
  // up, self-promote, or invoke the legacy bootstrap function in this test.
  admin = makeClient();
  const { data: adminSession, error: adminLoginError } = await admin.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert('pre-provisioned administrator can sign in', !adminLoginError && !!adminSession.user, adminLoginError?.message ?? ADMIN_EMAIL);
  adminUser = adminSession.user;
  const { data: adminProfile, error: adminProfileError } = await admin
    .from('profiles').select('role,campus_role').eq('user_id', adminUser.id).single();
  assert('configured account is already an administrator', !adminProfileError && adminProfile?.role === 'admin', adminProfileError?.message ?? `role=${adminProfile?.role}`);

  section('1. Campus registration and role boundaries');
  const a = await signUpCampusMember('student-a', 'Acceptance Student A', 'student');
  const b = await signUpCampusMember('faculty-b', 'Acceptance Faculty B', 'faculty');
  const c = await signUpCampusMember('staff-c', 'Acceptance Staff C', 'staff');
  const forgedAdmin = await signUpCampusMember('forged-admin', 'Acceptance Forged Admin', 'admin');
  const users = [a, b, c, forgedAdmin];
  for (const [index, member] of users.entries()) {
    const { data: profile, error } = await member.client.from('profiles')
      .select('role,campus_role').eq('user_id', member.user.id).single();
    const requested = ['student', 'faculty', 'staff', 'admin'][index];
    const expected = index === 3 ? 'student' : requested;
    assert(`${requested} signup is mapped to a safe campus role`, !error && profile?.role === expected && profile?.campus_role === expected,
      error?.message ?? `role=${profile?.role}, campus_role=${profile?.campus_role}`);
  }
  const userA = a.user;
  const userB = b.user;
  const userC = c.user;
  const userForged = forgedAdmin.user;
  assert('new campus members have active sessions', users.every((member) => !!member.user?.id));

  const { data: publicProfile, error: publicProfileError } = await anon.from('profiles_public')
    .select('*').eq('user_id', userB.id).single();
  const publicProfileKeys = Object.keys(publicProfile ?? {});
  assert('public profile view omits email and phone', !publicProfileError && !publicProfileKeys.includes('email') && !publicProfileKeys.includes('phone'),
    publicProfileError?.message ?? publicProfileKeys.join(', '));

  const { data: selfRoleUpdate, error: selfRoleError } = await a.client.from('profiles')
    .update({ role: 'admin' }).eq('user_id', userA.id).select('role');
  const { data: roleAfterAttempt } = await admin.from('profiles').select('role').eq('user_id', userA.id).single();
  assert('a member cannot self-promote by editing the profile row', !!selfRoleError || !selfRoleUpdate?.length,
    selfRoleError?.message ?? `effective role=${roleAfterAttempt?.role}`);
  assert('the attempted self-promotion left the account non-admin', roleAfterAttempt?.role === 'student', `role=${roleAfterAttempt?.role}`);
  const { error: adminSelfChangeError } = await admin.rpc('set_profile_role', {
    p_user_id: adminUser.id, p_role: 'student', p_notes: 'E2E self-change must be denied',
  });
  assert('an administrator cannot change their own role through the role RPC', !!adminSelfChangeError, adminSelfChangeError?.message ?? 'RPC unexpectedly succeeded');

  section('2. Reporting, safe search, private exact location');
  const dateLost = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const dateFound = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const lostPhoto = await uploadPhoto(a.client, userA.id, 'wallet-lost');
  const lostItem = await createItemReport(a.client, {
    type: 'lost',
    title: 'Black leather wallet',
    category: 'Wallets',
    description: 'Black leather bi-fold wallet with a broken left zip, library card and family photograph.',
    location: 'Central Library, second-floor reading room',
    dateOccurred: dateLost,
    keywords: 'wallet black leather zip library',
    characteristics: 'Bi-fold shape; small silver zipper pull.',
    imageUrl: lostPhoto.url,
    imagePath: lostPhoto.path,
  });
  assert('lost report is created through the validated database RPC', !!lostItem.id && lostItem.status === 'active', `${lostItem.id}, status=${lostItem.status}`);
  assert('database-created lost report is unverified by default', lostItem.verification_status === 'pending');

  const foundPhoto = await uploadPhoto(b.client, userB.id, 'wallet-found');
  const exactLocation = `E2E-PRIVATE-EXACT-SPOT-${runId}: third desk west of the book-return machine`;
  const collectionInstructions = 'Ask at the central library service desk and show the listing number to collect the item.';
  const foundItem = await createItemReport(b.client, {
    type: 'found',
    title: 'Found black leather wallet',
    category: 'Wallets',
    description: 'Black leather wallet with a small zipper pull, found on a library study table.',
    location: 'Central Library, second-floor reading room',
    dateOccurred: dateFound,
    keywords: 'wallet black leather zip library',
    characteristics: 'Bi-fold shape; small silver zipper pull.',
    collectionInstructions,
    exactFoundLocation: exactLocation,
    imageUrl: foundPhoto.url,
    imagePath: foundPhoto.path,
  });
  assert('found report is created and has public collection instructions', !!foundItem.id && foundItem.collection_instructions === collectionInstructions, `${foundItem.id}`);
  assert('RPC response does not include the private exact find location', !JSON.stringify(foundItem).includes(exactLocation));

  const { data: privateForFinder, error: privateFinderError } = await b.client.from('item_private_details')
    .select('exact_found_location').eq('item_id', foundItem.id).single();
  assert('finder can view their own exact discovery location', !privateFinderError && privateForFinder?.exact_found_location === exactLocation,
    privateFinderError?.message ?? 'exact location did not match');
  const { data: privateForClaimant, error: privateClaimantError } = await a.client.from('item_private_details')
    .select('exact_found_location').eq('item_id', foundItem.id);
  assert('claimant cannot read the finder-only exact location', !!privateClaimantError || (privateForClaimant?.length ?? 0) === 0,
    privateClaimantError?.message ?? `${privateForClaimant?.length ?? 0} row(s)`);
  const { data: privateForAnon, error: privateAnonError } = await anon.from('item_private_details')
    .select('exact_found_location').eq('item_id', foundItem.id);
  assert('anonymous search cannot read private location records', !!privateAnonError || (privateForAnon?.length ?? 0) === 0,
    privateAnonError?.message ?? `${privateForAnon?.length ?? 0} row(s)`);

  const { data: publicItem, error: publicItemError } = await anon.from('items').select('*').eq('id', foundItem.id).single();
  assert('public item includes public instructions, not exact location', !publicItemError &&
    publicItem?.collection_instructions === collectionInstructions &&
    !JSON.stringify(publicItem).includes(exactLocation), publicItemError?.message ?? 'checked public item fields');

  const { data: searchResult, error: searchError } = await anon.rpc('search_public_items', {
    p_search: 'wallet', p_type: 'found', p_category: 'Wallets', p_location: 'Central Library',
    p_status: 'active', p_date_from: null, p_date_to: null, p_page: 1, p_page_size: 10,
    p_hide_rejected: true, p_sort: 'relevance',
  });
  const searchRows = searchResult?.rows ?? [];
  const foundInSearch = searchRows.find((row) => row.id === foundItem.id);
  assert('allow-listed search filters return the found report', !searchError && !!foundInSearch, searchError?.message ?? `${searchRows.length} result(s)`);
  assert('search results expose collection instructions but not exact location',
    foundInSearch?.collection_instructions === collectionInstructions && !JSON.stringify(searchResult).includes(exactLocation));
  const { error: invalidRangeError } = await anon.rpc('search_public_items', {
    p_date_from: '2026-10-10', p_date_to: '2026-10-01', p_page: 1, p_page_size: 9,
  });
  assert('database rejects an invalid date range', !!invalidRangeError, invalidRangeError?.message ?? 'invalid range unexpectedly accepted');

  section('3. Matching and persistent duplicate-safe notifications');
  const candidate = findMatches({
    id: lostItem.id, type: lostItem.type, title: lostItem.title, category: lostItem.category,
    description: lostItem.description, location: lostItem.location, date_occurred: lostItem.date_occurred,
    keywords: lostItem.keywords, identifying_characteristics: lostItem.identifying_characteristics,
  }, [{
    id: foundItem.id, type: foundItem.type, title: foundItem.title, category: foundItem.category,
    description: foundItem.description, location: foundItem.location, date_occurred: foundItem.date_occurred,
    keywords: foundItem.keywords, identifying_characteristics: foundItem.identifying_characteristics,
  }])[0];
  assert('real matching engine produces a candidate over the save threshold', !!candidate && candidate.score >= MIN_MATCH_SCORE,
    candidate ? `${candidate.score}% (${scoreToLevel(candidate.score)})` : 'no candidate');
  const matchPayload = {
    lost_item_id: lostItem.id,
    found_item_id: foundItem.id,
    score: candidate.score,
    status: 'suggested',
    matching_details: buildMatchDetails(candidate.score, candidate.level, candidate.breakdown),
  };
  const { data: insertedMatches, error: firstMatchError } = await b.client.from('matches')
    .upsert([matchPayload], { onConflict: 'lost_item_id,found_item_id', ignoreDuplicates: true }).select('*');
  const match = insertedMatches?.[0];
  assert('match pair is persisted once using duplicate-safe upsert', !firstMatchError && !!match?.id,
    firstMatchError?.message ?? `score=${match?.score}`);
  const { data: duplicateMatches, error: duplicateMatchError } = await b.client.from('matches')
    .upsert([matchPayload], { onConflict: 'lost_item_id,found_item_id', ignoreDuplicates: true }).select('id');
  const { data: persistedPair } = await admin.from('matches').select('id')
    .eq('lost_item_id', lostItem.id).eq('found_item_id', foundItem.id);
  assert('repeat match run creates no duplicate pair or error', !duplicateMatchError && (duplicateMatches?.length ?? 0) === 0 && (persistedPair?.length ?? 0) === 1,
    duplicateMatchError?.message ?? `${persistedPair?.length ?? 0} stored pair(s)`);

  const matchNotesA = await notificationsFor(a.client, userA.id);
  const matchNotesB = await notificationsFor(b.client, userB.id);
  const aMatchNotes = matchNotesA.filter((n) => n.type === 'match' && n.related_item_id === foundItem.id);
  const bMatchNotes = matchNotesB.filter((n) => n.type === 'match' && n.related_item_id === lostItem.id);
  assert('both members receive persistent match notifications linked to the other item', aMatchNotes.length === 1 && bMatchNotes.length === 1,
    `A=${aMatchNotes.length}, B=${bMatchNotes.length}`);
  assert('duplicate-safe match persistence does not duplicate notifications',
    matchNotesA.filter((n) => n.type === 'match' && n.related_item_id === foundItem.id).length === 1 &&
    matchNotesB.filter((n) => n.type === 'match' && n.related_item_id === lostItem.id).length === 1);
  const { data: matchVisibleToA, error: matchVisibleError } = await a.client.from('matches').select('id')
    .eq('id', match.id).maybeSingle();
  assert('a member can see a match involving their own report', !matchVisibleError && !!matchVisibleToA, matchVisibleError?.message ?? 'not visible');

  section('4. Claims: private evidence, public-safe history and separate admin decisions');
  const privateEvidence = `E2E-PRIVATE-CLAIM-EVIDENCE-${runId}`;
  const claimMessage = `This wallet is mine; ${privateEvidence}. The zipper pull has a tiny scratch.`;
  const { data: claim, error: claimError } = await a.client.from('claims').insert({
    item_id: foundItem.id,
    claimant_id: userA.id,
    message: claimMessage,
    lost_location_answer: 'I last remember having it beside the east reading tables.',
    status: 'pending',
    admin_notes: null,
    reviewed_by: null,
    reviewed_at: null,
  }).select('*').single();
  assert('claim submission requires and stores private location/evidence', !claimError && claim?.status === 'pending' && claim?.lost_location_answer,
    claimError?.message ?? `status=${claim?.status}`);

  const { data: claimNotificationsB, error: claimNotificationsError } = await b.client.from('notifications')
    .select('*').eq('user_id', userB.id).eq('type', 'claim_submitted').eq('related_claim_id', claim.id);
  assert('finder is notified when a claim is submitted', !claimNotificationsError && (claimNotificationsB?.length ?? 0) === 1,
    claimNotificationsError?.message ?? `${claimNotificationsB?.length ?? 0} notice(s)`);
  assert('finder-facing notification omits private claimant evidence',
    !JSON.stringify(claimNotificationsB ?? []).includes(privateEvidence));

  const { data: claimsVisibleToFinder, error: claimsFinderError } = await b.client.from('claims').select('*').eq('id', claim.id);
  assert('finder cannot read the claimant private evidence table', !!claimsFinderError || (claimsVisibleToFinder?.length ?? 0) === 0,
    claimsFinderError?.message ?? `${claimsVisibleToFinder?.length ?? 0} row(s)`);
  const { data: claimPrivateToClaimant, error: ownClaimError } = await a.client.from('claims').select('*').eq('id', claim.id).single();
  assert('claimant can access their own private claim', !ownClaimError && claimPrivateToClaimant?.message === claimMessage,
    ownClaimError?.message ?? 'own claim not visible');

  const { data: historyAfterSubmit, error: historyError } = await anon.from('claim_history').select('*')
    .eq('item_id', foundItem.id);
  const historyFields = Object.keys(historyAfterSubmit?.[0] ?? {});
  assert('public claim history includes status but omits proof, notes and contacts', !historyError &&
    (historyAfterSubmit?.length ?? 0) === 1 && historyFields.includes('claimant_name') && historyFields.includes('campus_role') &&
    !historyFields.some((field) => ['message', 'lost_location_answer', 'admin_notes', 'email', 'phone'].includes(field)) &&
    !JSON.stringify(historyAfterSubmit ?? []).includes(privateEvidence), historyError?.message ?? historyFields.join(', '));

  const { error: directReviewError } = await a.client.from('claims').update({
    status: 'approved', reviewed_by: userA.id, reviewed_at: new Date().toISOString(),
  }).eq('id', claim.id);
  const { data: stillPendingClaim } = await admin.from('claims').select('status').eq('id', claim.id).single();
  assert('a claimant cannot approve a claim with a direct table update', !!directReviewError || stillPendingClaim?.status === 'pending',
    directReviewError?.message ?? `status=${stillPendingClaim?.status}`);
  const { error: nonAdminReviewError } = await a.client.rpc('review_claim', {
    p_claim_id: claim.id, p_decision: 'approved', p_notes: 'Not an administrator',
  });
  assert('review_claim rejects a non-administrator', !!nonAdminReviewError, nonAdminReviewError?.message ?? 'RPC unexpectedly succeeded');

  const needsInfoNote = `E2E-PRIVATE-REVIEW-${runId}: please confirm one additional distinguishing mark.`;
  const { data: needsInfoResult, error: needsInfoError } = await admin.rpc('review_claim', {
    p_claim_id: claim.id, p_decision: 'needs_info', p_notes: needsInfoNote,
  });
  assert('administrator can request more information through the review RPC', !needsInfoError && needsInfoResult?.status === 'needs_info',
    needsInfoError?.message ?? JSON.stringify(needsInfoResult));
  const { data: claimantAfterRequest } = await a.client.from('claims').select('status,admin_notes')
    .eq('id', claim.id).single();
  assert('claimant receives the private review note on their own claim', claimantAfterRequest?.status === 'needs_info' && claimantAfterRequest?.admin_notes === needsInfoNote,
    `status=${claimantAfterRequest?.status}`);
  const needsInfoNotifications = await notificationsFor(a.client, userA.id);
  const needsInfoNotice = needsInfoNotifications.filter((n) => n.type === 'claim_needs_info' && n.related_claim_id === claim.id);
  assert('claimant is notified of the information request without exposing its private note', needsInfoNotice.length === 1 &&
    !JSON.stringify(needsInfoNotice).includes(needsInfoNote), `${needsInfoNotice.length} notice(s)`);

  // A second member's claim is rejected with a private review note. The note
  // must not be copied into the public notification or the public history view.
  const secondClaimEvidence = `E2E-SECOND-PRIVATE-${runId}`;
  const { data: secondClaim, error: secondClaimError } = await c.client.from('claims').insert({
    item_id: foundItem.id,
    claimant_id: userC.id,
    message: `I may own this item; ${secondClaimEvidence}; my keychain has a blue tag.`,
    lost_location_answer: 'Near the north campus entrance.',
    status: 'pending',
    admin_notes: null,
    reviewed_by: null,
    reviewed_at: null,
  }).select('*').single();
  assert('a second member can submit a separate claim', !secondClaimError && !!secondClaim?.id,
    secondClaimError?.message ?? 'no claim id');
  const rejectionNote = `E2E-PRIVATE-REJECTION-NOTE-${runId}`;
  const { error: rejectError, data: rejectResult } = await admin.rpc('review_claim', {
    p_claim_id: secondClaim.id, p_decision: 'rejected', p_notes: rejectionNote,
  });
  assert('administrator can reject a claim without deleting its history', !rejectError && rejectResult?.status === 'rejected',
    rejectError?.message ?? JSON.stringify(rejectResult));
  const staffNotifications = await notificationsFor(c.client, userC.id);
  const rejectionNotifications = staffNotifications.filter((n) => n.type === 'claim_rejected' && n.related_claim_id === secondClaim.id);
  assert('rejection notification does not leak the private review note', rejectionNotifications.length === 1 &&
    !JSON.stringify(rejectionNotifications).includes(rejectionNote), `${rejectionNotifications.length} notice(s)`);
  const { data: safeHistoryAfterRejection } = await anon.from('claim_history').select('*').eq('item_id', foundItem.id);
  assert('public history includes rejected claim status but no evidence or review notes',
    safeHistoryAfterRejection?.some((row) => row.id === secondClaim.id && row.status === 'rejected') &&
    !JSON.stringify(safeHistoryAfterRejection ?? []).includes(secondClaimEvidence) &&
    !JSON.stringify(safeHistoryAfterRejection ?? []).includes(rejectionNote));

  const responseMessage = `Additional ownership detail for ${privateEvidence}: a tiny scratch is beside the silver pull.`;
  const { data: responseResult, error: responseError } = await a.client.rpc('respond_to_claim_request', {
    p_claim_id: claim.id,
    p_message: responseMessage,
    p_lost_location_answer: 'Beside the east reading tables, shortly before the afternoon lecture.',
  });
  assert('claimant can respond to an information request through the secure RPC', !responseError && responseResult?.status === 'pending',
    responseError?.message ?? JSON.stringify(responseResult));
  const { data: pendingAgain } = await admin.from('claims').select('status').eq('id', claim.id).single();
  assert('response returns the claim to the administrator review queue', pendingAgain?.status === 'pending', `status=${pendingAgain?.status}`);

  const approvalNote = 'Ownership details corroborated; coordinate collection at the service desk.';
  const { data: approvalResult, error: approvalError } = await admin.rpc('review_claim', {
    p_claim_id: claim.id, p_decision: 'approved', p_notes: approvalNote,
  });
  assert('administrator approves ownership through the review RPC', !approvalError && approvalResult?.status === 'approved',
    approvalError?.message ?? JSON.stringify(approvalResult));
  const { data: approvedClaim } = await admin.from('claims').select('status,reviewed_by,reviewed_at')
    .eq('id', claim.id).single();
  assert('claim audit records the approval reviewer and time', approvedClaim?.status === 'approved' &&
    approvedClaim?.reviewed_by === adminUser.id && !!approvedClaim?.reviewed_at,
    `status=${approvedClaim?.status}, reviewer=${approvedClaim?.reviewed_by}`);

  const { data: itemAfterApproval } = await admin.from('items')
    .select('status,resolved_at,handed_over_at,handed_over_by').eq('id', foundItem.id).single();
  assert('ownership approval does not mark the item returned or fabricate handover',
    itemAfterApproval?.status === 'claimed' && itemAfterApproval?.resolved_at === null &&
    itemAfterApproval?.handed_over_at === null && itemAfterApproval?.handed_over_by === null,
    JSON.stringify(itemAfterApproval));
  const approvalNotesA = await notificationsFor(a.client, userA.id);
  const approvalNotesB = await notificationsFor(b.client, userB.id);
  assert('claimant and finder are both notified of the ownership decision',
    approvalNotesA.some((n) => n.type === 'claim_approved' && n.related_claim_id === claim.id) &&
    approvalNotesB.some((n) => n.type === 'claim_approved' && n.related_claim_id === claim.id));

  const { data: reviewHistory, error: reviewHistoryError } = await admin.from('claim_review_history')
    .select('from_status,to_status,notes,reviewed_by').eq('claim_id', claim.id).order('created_at');
  assert('admin-only review audit contains the request and approval transitions', !reviewHistoryError &&
    reviewHistory?.some((row) => row.to_status === 'needs_info') && reviewHistory?.some((row) => row.to_status === 'approved'),
    reviewHistoryError?.message ?? JSON.stringify(reviewHistory));
  const { data: historyForClaimant, error: privateHistoryError } = await a.client.from('claim_review_history')
    .select('*').eq('claim_id', claim.id);
  assert('non-admin cannot read private claim review history', !!privateHistoryError || (historyForClaimant?.length ?? 0) === 0,
    privateHistoryError?.message ?? `${historyForClaimant?.length ?? 0} row(s)`);
  const { data: publicHistoryAfterApproval } = await anon.from('claim_history').select('*').eq('item_id', foundItem.id);
  assert('safe public history shows the approved outcome but never the private review note',
    publicHistoryAfterApproval?.some((row) => row.id === claim.id && row.status === 'approved') &&
    !JSON.stringify(publicHistoryAfterApproval ?? []).includes(needsInfoNote) &&
    !JSON.stringify(publicHistoryAfterApproval ?? []).includes(approvalNote) &&
    !JSON.stringify(publicHistoryAfterApproval ?? []).includes(privateEvidence));

  section('5. Physical handover is finder-confirmed and database-enforced');
  const { error: adminDirectReturnedError } = await admin.from('items').update({
    status: 'returned', resolved_at: new Date().toISOString(),
  }).eq('id', foundItem.id);
  const { data: afterDirectReturnedAttempt } = await admin.from('items').select('status,handed_over_at')
    .eq('id', foundItem.id).single();
  assert('administrator cannot directly set returned status', !!adminDirectReturnedError &&
    afterDirectReturnedAttempt?.status === 'claimed' && afterDirectReturnedAttempt?.handed_over_at === null,
    adminDirectReturnedError?.message ?? JSON.stringify(afterDirectReturnedAttempt));

  const { error: claimantHandoverError } = await a.client.rpc('confirm_item_handover', { p_item_id: foundItem.id });
  assert('claimant cannot confirm the finder handover', !!claimantHandoverError, claimantHandoverError?.message ?? 'RPC unexpectedly succeeded');
  const { error: adminHandoverError } = await admin.rpc('confirm_item_handover', { p_item_id: foundItem.id });
  assert('administrator cannot confirm physical handover on behalf of the finder', !!adminHandoverError,
    adminHandoverError?.message ?? 'RPC unexpectedly succeeded');
  const { data: stillClaimed } = await admin.from('items').select('status').eq('id', foundItem.id).single();
  assert('failed handover attempts leave item claimed', stillClaimed?.status === 'claimed', `status=${stillClaimed?.status}`);

  const { data: handoverResult, error: handoverError } = await b.client.rpc('confirm_item_handover', { p_item_id: foundItem.id });
  assert('the reporting finder can confirm physical handover', !handoverError && handoverResult?.status === 'returned',
    handoverError?.message ?? JSON.stringify(handoverResult));
  const { data: returnedItem } = await admin.from('items')
    .select('status,resolved_at,handed_over_at,handed_over_by').eq('id', foundItem.id).single();
  assert('returned status is paired with the finder and actual handover timestamp',
    returnedItem?.status === 'returned' && !!returnedItem?.resolved_at && !!returnedItem?.handed_over_at &&
    returnedItem?.handed_over_by === userB.id, JSON.stringify(returnedItem));
  const handoverNotesA = await notificationsFor(a.client, userA.id);
  assert('claimant receives a persistent physical-handover notification',
    handoverNotesA.some((n) => n.type === 'item_handed_over' && n.related_item_id === foundItem.id));

  section('6. Security helpers, search state and audit');
  const { error: forgedNotificationError } = await a.client.rpc('create_notification', {
    p_user_id: userB.id, p_title: 'forged', p_message: 'forged', p_type: 'system',
    p_item_id: foundItem.id, p_claim_id: null,
  });
  assert('authenticated members cannot call the SECURITY DEFINER notification helper', !!forgedNotificationError,
    forgedNotificationError?.message ?? 'RPC unexpectedly succeeded');
  const { error: forgedLogError } = await a.client.rpc('write_activity_log', {
    p_user_id: userB.id, p_action: 'forged', p_entity_type: 'item', p_entity_id: foundItem.id, p_details: {},
  });
  assert('authenticated members cannot forge audit entries through the helper', !!forgedLogError,
    forgedLogError?.message ?? 'RPC unexpectedly succeeded');

  const { data: finalSearch, error: finalSearchError } = await anon.rpc('search_public_items', {
    p_search: 'wallet', p_type: 'found', p_category: 'Wallets', p_location: 'Central Library',
    p_status: 'returned', p_date_from: null, p_date_to: null, p_page: 1, p_page_size: 10,
    p_hide_rejected: true, p_sort: 'newest',
  });
  const finalRows = finalSearch?.rows ?? [];
  const returnedInSearch = finalRows.find((row) => row.id === foundItem.id);
  assert('public filtered search reflects the returned state after handover', !finalSearchError && returnedInSearch?.status === 'returned',
    finalSearchError?.message ?? `status=${returnedInSearch?.status}`);
  assert('returned public search does not expose exact discovery location', !JSON.stringify(finalSearch).includes(exactLocation));

  const { data: studentLogs, error: studentLogsError } = await a.client.from('activity_logs').select('*').limit(5);
  assert('campus members cannot read the administrator audit log', !!studentLogsError || (studentLogs?.length ?? 0) === 0,
    studentLogsError?.message ?? `${studentLogs?.length ?? 0} row(s)`);
  const { data: adminLogs, error: adminLogsError } = await admin.from('activity_logs')
    .select('action,entity_id').order('created_at', { ascending: false }).limit(500);
  assert('administrator can read the append-only audit log', !adminLogsError && Array.isArray(adminLogs),
    adminLogsError?.message ?? `${adminLogs?.length ?? 0} row(s)`);
  assert('audit records claim review and finder-confirmed handover',
    (adminLogs ?? []).some((row) => row.action === 'item_handed_over' && row.entity_id === foundItem.id) &&
    (adminLogs ?? []).some((row) => row.entity_id === claim.id && String(row.action).startsWith('claim_')));

  const { data: adminPrivateLocation, error: adminPrivateLocationError } = await admin.from('item_private_details')
    .select('exact_found_location').eq('item_id', foundItem.id).single();
  assert('administrator can access private verification location for moderation', !adminPrivateLocationError &&
    adminPrivateLocation?.exact_found_location === exactLocation, adminPrivateLocationError?.message ?? 'location mismatch');

  section('7. Email-domain guard');
  const { data: configuredDomain, error: domainError } = await anon.rpc('allowed_email_domain');
  if (!domainError && typeof configuredDomain === 'string' && configuredDomain.trim()) {
    const outsider = makeClient();
    const { data: outsiderData, error: outsiderError } = await outsider.auth.signUp({
      email: `e2e.outsider.${runId}@not-${runId}.invalid`, password: PASSWORD,
      options: { data: { full_name: 'Outside Domain User', campus_role: 'student' } },
    });
    assert('database rejects registration outside the configured campus domain', !!outsiderError || !outsiderData?.session,
      outsiderError?.message ?? 'sign-up unexpectedly produced a session');
  } else {
    check('email-domain test', true, 'skipped: no database domain restriction is configured');
  }
}

try {
  await runScenario();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n\x1b[31mScenario stopped safely: ${message}\x1b[0m`);
  if (!results.some((row) => !row.ok)) check('scenario completed without an uncaught error', false, message);
} finally {
  await cleanup();
}

const passed = results.filter((row) => row.ok).length;
console.log(`\n\x1b[1mResult: ${passed}/${results.length} checks passed\x1b[0m`);
if (failures > 0) {
  console.log('\x1b[31m✖ ACCEPTANCE TEST FAILED\x1b[0m');
  for (const row of results.filter((entry) => !entry.ok)) {
    console.log(`  • ${row.label}${row.detail ? ` — ${row.detail}` : ''}`);
  }
  process.exitCode = 1;
} else {
  console.log('\x1b[32m✔ ACCEPTANCE TEST PASSED — the live database workflow satisfied the checks.\x1b[0m');
}
