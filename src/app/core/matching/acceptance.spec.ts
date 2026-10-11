/**
 * ACCEPTANCE REPLAY (§42, matching half) — runs offline, no network needed.
 *
 * `tests/acceptance.mjs` drives the full §42 scenario against a live Supabase
 * project; it cannot run without an account, so this spec replays the very same
 * data through the very same algorithm inside the test runner.  It proves the
 * deterministic half of the acceptance criteria — that the reports Student A
 * and Student B submit in the scenario do produce an automatic match with the
 * right score, the right band and the right stored breakdown.
 *
 * The rest of §42 (registration, storage, claims, admin approval, RLS) is
 * verified by `npm run e2e` against a real project.
 */
import { describe, expect, it } from 'vitest';
import { buildMatchDetails, findMatches, levelLabel, scoreToLevel } from './matching.engine';
import { MIN_MATCH_SCORE, NOTIFY_FROM_SCORE } from './matching.config';
import type { ItemSummary } from '../models/common.model';

/* The exact values used by tests/acceptance.mjs for Student A and Student B. */
const today = new Date();
const daysAgo = (days: number) =>
  new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);

const studentALostWallet: ItemSummary = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  type: 'lost',
  title: 'Black leather wallet',
  category: 'Wallets',
  description:
    'Black leather bi-fold wallet with a broken left zip. Contains my library card and a family photo.',
  location: 'Central Library, 2nd floor reading room',
  date_occurred: daysAgo(3),
  status: 'active',
};

const studentBFoundWallet: ItemSummary = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  type: 'found',
  title: 'Found: black leather wallet',
  category: 'Wallets',
  description:
    'Found a black leather wallet with a broken zip on a study table in the library. Kept at the reading-room desk.',
  location: 'Central Library, 2nd floor reading room',
  date_occurred: daysAgo(2),
  status: 'active',
};

describe('§42 acceptance scenario — matching half', () => {
  it('produces an automatic match for the two acceptance reports', () => {
    const matches = findMatches(studentALostWallet, [studentBFoundWallet]);

    expect(matches).toHaveLength(1);
    expect(matches[0].item.id).toBe(studentBFoundWallet.id);
  });

  it('scores the pair above both the recording and the notification threshold', () => {
    const [match] = findMatches(studentALostWallet, [studentBFoundWallet]);

    expect(match.score).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    expect(match.score).toBeGreaterThanOrEqual(NOTIFY_FROM_SCORE);
    expect(match.score).toBeLessThanOrEqual(100);
  });

  it('puts the acceptance pair in a "strong" or "very strong" band', () => {
    const [match] = findMatches(studentALostWallet, [studentBFoundWallet]);

    expect(['strong', 'very-strong']).toContain(scoreToLevel(match.score));
    expect(levelLabel(scoreToLevel(match.score))).toBeTruthy();
  });

  it('explains the score with a breakdown that adds up exactly', () => {
    const [match] = findMatches(studentALostWallet, [studentBFoundWallet]);
    const sum = match.breakdown.reduce((total, row) => total + row.points, 0);

    expect(sum).toBe(match.score);
    expect(match.breakdown.map((row) => row.key)).toEqual([
      'category',
      'title',
      'description',
      'location',
      'date',
    ]);
    // every explanation is human-readable — the UI prints them verbatim
    for (const row of match.breakdown) {
      expect(row.explanation.length).toBeGreaterThan(5);
      expect(row.points).toBeLessThanOrEqual(row.maxPoints);
    }
  });

  it('stores everything the item-details page needs in matching_details', () => {
    const [match] = findMatches(studentALostWallet, [studentBFoundWallet]);
    const details = buildMatchDetails(match.score, match.level, match.breakdown);

    expect(details.breakdown).toHaveLength(5);
    expect(details.level).toBe(scoreToLevel(match.score));
    expect(details.algorithm).toContain('rule-based');
    expect(details.weights).toMatchObject({
      category: 30,
      title: 25,
      description: 15,
      location: 20,
      date: 10,
    });
    // the stored breakdown must add up to the stored score — never drift
    expect(details.breakdown.reduce((total, row) => total + row.points, 0)).toBe(match.score);
  });

  it('is deterministic: the same pair always scores identically', () => {
    const runs = Array.from({ length: 5 }, () =>
      findMatches(studentALostWallet, [studentBFoundWallet])[0].score,
    );
    expect(new Set(runs).size).toBe(1);
  });

  it('never matches an item with itself, or lost against lost', () => {
    // same report passed as its own candidate
    expect(findMatches(studentALostWallet, [studentALostWallet])).toHaveLength(0);

    // another LOST report of a wallet is not a match — only FOUND reports are
    const secondLostWallet: ItemSummary = {
      ...studentALostWallet,
      id: 'cccccccc-0000-4000-8000-000000000003',
      title: 'Lost black wallet again',
    };
    expect(findMatches(studentALostWallet, [secondLostWallet])).toHaveLength(0);
  });

  it('excludes reports that are finished with (returned / rejected)', () => {
    const returned: ItemSummary = { ...studentBFoundWallet, status: 'returned' };
    const rejected: ItemSummary = { ...studentBFoundWallet, status: 'rejected' };

    expect(findMatches(studentALostWallet, [returned])).toHaveLength(0);
    expect(findMatches(studentALostWallet, [rejected])).toHaveLength(0);
  });

  it('ignores unrelated found items (no false notification)', () => {
    const unrelated: ItemSummary = {
      id: 'dddddddd-0000-4000-8000-000000000004',
      type: 'found',
      title: 'Blue water bottle with coding club stickers',
      category: 'Other',
      description: 'Stainless steel blue bottle, dented at the bottom, found in the canteen queue.',
      location: 'Canteen, near the juice counter',
      date_occurred: daysAgo(9),
      status: 'active',
    };

    const matches = findMatches(studentALostWallet, [studentBFoundWallet, unrelated]);

    expect(matches.map((match) => match.item.id)).toEqual([studentBFoundWallet.id]);
  });

  it('ranks the wallet above everything else when several candidates are given', () => {
    const candidates: ItemSummary[] = [
      {
        id: 'eeeeeeee-0000-4000-8000-000000000005',
        type: 'found',
        title: 'Found: black leather purse',
        category: 'Wallets',
        description: 'Black leather purse found outside block A.',
        location: 'Block A entrance',
        date_occurred: daysAgo(6),
        status: 'active',
      },
      studentBFoundWallet,
      {
        id: 'ffffffff-0000-4000-8000-000000000006',
        type: 'found',
        title: 'Found: black leather wallet',
        category: 'Wallets',
        description: 'A black leather wallet handed in at the front office, library side.',
        location: 'Front office',
        date_occurred: daysAgo(8),
        status: 'active',
      },
    ];

    const matches = findMatches(studentALostWallet, candidates);

    expect(matches[0].item.id).toBe(studentBFoundWallet.id);
    // results are ordered best-first, so the UI can render them directly
    const scores = matches.map((match) => match.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
