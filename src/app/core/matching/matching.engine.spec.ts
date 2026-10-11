/**
 * Unit tests for the rule-based matching engine.
 *
 * These are real behavioural tests: weighting, band thresholds, the
 * lost↔found-only rule, false-positive resistance, date decay and
 * determinism.  No network, no database, no mocking — the engine is pure.
 */
import {
  buildMatchDetails,
  diceSimilarity,
  findMatches,
  levelLabel,
  scoreCategory,
  scoreDate,
  scoreDescription,
  scoreLocation,
  scorePair,
  scoreTitle,
  scoreToLevel,
  tokenise,
} from './matching.engine';
import { MATCH_ALGORITHM_VERSION, MATCH_WEIGHTS, MIN_MATCH_SCORE, NOTIFY_FROM_SCORE } from './matching.config';
import type { ItemSummary } from '../models/common.model';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function item(partial: Partial<ItemSummary> & Pick<ItemSummary, 'id' | 'type'>): ItemSummary {
  return {
    title: 'Item',
    category: 'Other',
    description: 'a description',
    location: 'Campus',
    date_occurred: '2026-03-10',
    status: 'active',
    ...partial,
  };
}

const lostWallet = item({
  id: 'lost-1',
  type: 'lost',
  title: 'Black Wallet',
  category: 'Wallets',
  description: 'black leather wallet with my college id card and library card inside',
  location: 'College Canteen',
  date_occurred: '2026-03-10',
});

const foundWallet = item({
  id: 'found-1',
  type: 'found',
  title: 'Black Leather Wallet',
  category: 'Wallets',
  description: 'found a black leather wallet near the canteen, contains an id card',
  location: 'College Canteen',
  date_occurred: '2026-03-11',
});

/* ------------------------------------------------------------------ */
/* configuration sanity                                               */
/* ------------------------------------------------------------------ */

describe('matching configuration', () => {
  it('weights add up to exactly 100 points', () => {
    const total = Object.values(MATCH_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(100);
  });

  it('uses the weights required by the specification', () => {
    expect(MATCH_WEIGHTS).toEqual({
      category: 30,
      title: 25,
      description: 15,
      location: 20,
      date: 10,
    });
  });

  it('notifies at a score that is reachable only by genuine matches', () => {
    expect(NOTIFY_FROM_SCORE).toBeGreaterThan(MIN_MATCH_SCORE);
    expect(NOTIFY_FROM_SCORE).toBeLessThanOrEqual(100);
  });
});

/* ------------------------------------------------------------------ */
/* text helpers                                                       */
/* ------------------------------------------------------------------ */

describe('text helpers', () => {
  it('tokenises text, lower-cases it and drops stop words', () => {
    const tokens = tokenise('A Black Wallet was LOST near the library');
    expect(tokens.has('black')).toBe(true);
    expect(tokens.has('wallet')).toBe(true);
    expect(tokens.has('library')).toBe(true);
    expect(tokens.has('the')).toBe(false); // stop word
    expect(tokens.has('lost')).toBe(false); // stop word (it is a column, not a clue)
  });

  it('gives 1.0 for identical token sets and 0 for disjoint sets', () => {
    expect(diceSimilarity(tokenise('blue bottle'), tokenise('blue bottle'))).toBe(1);
    expect(diceSimilarity(tokenise('blue bottle'), tokenise('grey calculator'))).toBe(0);
  });

  it('is symmetric', () => {
    const a = tokenise('black leather wallet');
    const b = tokenise('leather wallet black brown');
    expect(diceSimilarity(a, b)).toBeCloseTo(diceSimilarity(b, a), 10);
  });
});

/* ------------------------------------------------------------------ */
/* individual signals                                                 */
/* ------------------------------------------------------------------ */

describe('category signal (30 points)', () => {
  const base = item({ id: 'x', type: 'lost', category: 'Wallets' });

  it('gives full credit for an identical category', () => {
    expect(scoreCategory(base, item({ id: 'y', type: 'found', category: 'Wallets' })).ratio).toBe(1);
  });

  it('gives partial credit for a related category', () => {
    const result = scoreCategory(base, item({ id: 'z', type: 'found', category: 'Bags' }));
    expect(result.ratio).toBe(0.6);
    expect(result.explanation).toContain('Related');
  });

  it('gives no credit for unrelated categories', () => {
    expect(scoreCategory(base, item({ id: 'w', type: 'found', category: 'Electronics' })).ratio).toBe(0);
  });

  it('stays neutral when either side chose "Other"', () => {
    const result = scoreCategory(item({ id: 'o1', type: 'lost', category: 'Other' }), base);
    expect(result.ratio).toBe(0.5);
  });
});

describe('title signal (25 points)', () => {
  it('rewards an exact name', () => {
    const a = item({ id: 'a', type: 'lost', title: 'Blue Milton Bottle' });
    const b = item({ id: 'b', type: 'found', title: 'Blue Milton Bottle' });
    expect(scoreTitle(a, b).ratio).toBe(1);
  });

  it('rewards a contained name ("Black Wallet" inside "Black Leather Wallet")', () => {
    const a = item({ id: 'a', type: 'lost', title: 'Black Wallet' });
    const b = item({ id: 'b', type: 'found', title: 'Black Leather Wallet' });
    expect(scoreTitle(a, b).ratio).toBeGreaterThanOrEqual(0.9);
  });

  it('rewards a token subset even when the wording differs', () => {
    const a = item({ id: 'a', type: 'lost', title: 'Casio Scientific Calculator' });
    const b = item({ id: 'b', type: 'found', title: 'Scientific Calculator Casio' });
    expect(scoreTitle(a, b).ratio).toBeGreaterThanOrEqual(0.9);
  });

  it('gives little credit for unrelated names', () => {
    const a = item({ id: 'a', type: 'lost', title: 'Black Wallet' });
    const b = item({ id: 'b', type: 'found', title: 'Blue Umbrella' });
    expect(scoreTitle(a, b).ratio).toBeLessThan(0.3);
  });
});

describe('location signal (20 points)', () => {
  it('gives full credit for the same place', () => {
    const a = item({ id: 'a', type: 'lost', location: 'Library' });
    const b = item({ id: 'b', type: 'found', location: 'Library' });
    expect(scoreLocation(a, b).ratio).toBe(1);
  });

  it('gives 0.8 when one location contains the other', () => {
    const a = item({ id: 'a', type: 'lost', location: 'Lab 3' });
    const b = item({ id: 'b', type: 'found', location: 'Computer Science Lab 3' });
    expect(scoreLocation(a, b).ratio).toBe(0.8);
  });

  it('returns 0 when a location is missing instead of throwing', () => {
    const a = item({ id: 'a', type: 'lost', location: '' });
    expect(scoreLocation(a, foundWallet).ratio).toBe(0);
  });
});

describe('date signal (10 points)', () => {
  it('gives full credit for the same day', () => {
    const a = item({ id: 'a', type: 'lost', date_occurred: '2026-03-10' });
    const b = item({ id: 'b', type: 'found', date_occurred: '2026-03-10' });
    expect(scoreDate(a, b).ratio).toBe(1);
  });

  it('decays linearly and reaches zero at the window edge', () => {
    const a = item({ id: 'a', type: 'lost', date_occurred: '2026-03-01' });
    const near = scoreDate(a, item({ id: 'b', type: 'found', date_occurred: '2026-03-04' })).ratio;
    const far = scoreDate(a, item({ id: 'c', type: 'found', date_occurred: '2026-03-18' })).ratio;
    const outside = scoreDate(a, item({ id: 'd', type: 'found', date_occurred: '2026-05-01' })).ratio;
    expect(near).toBeGreaterThan(far);
    expect(outside).toBe(0);
  });

  it('handles an unparseable date gracefully', () => {
    const a = item({ id: 'a', type: 'lost', date_occurred: 'not-a-date' });
    expect(scoreDate(a, foundWallet).ratio).toBe(0.5);
  });
});

describe('description signal (15 points)', () => {
  it('rewards shared identifying detail', () => {
    const a = item({ id: 'a', type: 'lost', description: 'black leather wallet id card inside' });
    const b = item({ id: 'b', type: 'found', description: 'black leather wallet containing id card' });
    expect(scoreDescription(a, b).ratio).toBeGreaterThan(0.6);
  });

  it('uses public keywords and identifying characteristics as additional clues', () => {
    const a = item({
      id: 'a', type: 'lost', description: 'personal item',
      keywords: 'blue enamel pin', identifying_characteristics: 'crescent moon sticker',
    });
    const b = item({
      id: 'b', type: 'found', description: 'personal item',
      keywords: 'blue pin', identifying_characteristics: 'crescent moon sticker',
    });
    expect(scoreDescription(a, b).ratio).toBeGreaterThan(0.4);
  });

  it('gives nothing for unrelated descriptions', () => {
    const a = item({ id: 'a', type: 'lost', description: 'blue water bottle with a dented cap' });
    const b = item({ id: 'b', type: 'found', description: 'grey calculator with roll number on it' });
    expect(scoreDescription(a, b).ratio).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* the pair score                                                     */
/* ------------------------------------------------------------------ */

describe('scorePair', () => {
  it('scores a near-identical lost/found pair as a very strong match', () => {
    const identical = item({
      id: 'same-lost',
      type: 'lost',
      title: 'Blue Milton Water Bottle',
      category: 'Other',
      description: 'blue steel bottle with a dented cap',
      location: 'Lab 3',
      date_occurred: '2026-03-10',
    });
    const twin = { ...identical, id: 'same-found', type: 'found' as const };

    const result = scorePair(identical, twin);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(100);
    expect(result!.level).toBe('very-strong');
  });

  it('scores a realistic wallet match well above the strong threshold', () => {
    const result = scorePair(lostWallet, foundWallet);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(75);
    expect(result!.level === 'strong' || result!.level === 'very-strong').toBe(true);
  });

  it('produces a breakdown that adds up to the total score', () => {
    const result = scorePair(lostWallet, foundWallet)!;
    const sum = result.breakdown.reduce((total, part) => total + part.points, 0);
    expect(Math.round(sum)).toBe(result.score);
    expect(result.breakdown).toHaveLength(5);
    expect(result.breakdown.map((part) => part.key)).toEqual([
      'category', 'title', 'description', 'location', 'date',
    ]);
  });

  it('never awards more than the maximum for a signal', () => {
    const result = scorePair(lostWallet, foundWallet)!;
    for (const part of result.breakdown) {
      expect(part.points).toBeLessThanOrEqual(part.maxPoints);
      expect(part.points).toBeGreaterThanOrEqual(0);
    }
  });

  it('explains itself in plain words', () => {
    const result = scorePair(lostWallet, foundWallet)!;
    for (const part of result.breakdown) {
      expect(part.explanation.length).toBeGreaterThan(3);
    }
  });

  it('refuses a pair that is not lost -> found', () => {
    expect(scorePair(foundWallet, lostWallet)).toBeNull();       // wrong order
    expect(scorePair(lostWallet, { ...foundWallet, type: 'lost' })).toBeNull();
    expect(scorePair(lostWallet, lostWallet)).toBeNull();        // same row
  });

  it('is deterministic: the same inputs always give the same score', () => {
    const first = scorePair(lostWallet, foundWallet)!;
    const second = scorePair(lostWallet, foundWallet)!;
    expect(first.score).toBe(second.score);
    expect(first.breakdown).toEqual(second.breakdown);
  });

  it('does not throw when optional text is empty', () => {
    const empty = item({ id: 'e1', type: 'lost', title: 'Wallet', description: '', location: '' });
    expect(() => scorePair(empty, foundWallet)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* score bands                                                        */
/* ------------------------------------------------------------------ */

describe('score interpretation bands', () => {
  it.each([
    [0, 'no-match'],
    [39, 'no-match'],
    [40, 'low'],
    [59, 'low'],
    [60, 'possible'],
    [74, 'possible'],
    [75, 'strong'],
    [89, 'strong'],
    [90, 'very-strong'],
    [100, 'very-strong'],
  ])('maps %i to "%s"', (score, expected) => {
    expect(scoreToLevel(score as number)).toBe(expected);
  });

  it('has a human label for every band', () => {
    for (const level of ['no-match', 'low', 'possible', 'strong', 'very-strong'] as const) {
      expect(levelLabel(level).length).toBeGreaterThan(3);
    }
  });
});

/* ------------------------------------------------------------------ */
/* findMatches                                                        */
/* ------------------------------------------------------------------ */

describe('findMatches', () => {
  const otherLosses = [
    item({ id: 'lost-2', type: 'lost', title: 'Grey Umbrella', category: 'Accessories', location: 'Library', description: 'navy umbrella' }),
  ];

  it('only ever compares lost with found', () => {
    // a lost item scored against other LOST items must return nothing
    expect(findMatches(lostWallet, otherLosses, 0)).toEqual([]);
    // ... and same for found/found
    expect(findMatches(foundWallet, [foundWallet, { ...foundWallet, id: 'found-9' }], 0)).toEqual([]);
  });

  it('never matches an item with itself', () => {
    const candidates = [{ ...lostWallet, type: 'found' as const, id: lostWallet.id }];
    expect(findMatches(lostWallet, candidates, 0)).toEqual([]);
  });

  it('returns the genuine match and ranks it first', () => {
    const weak = item({
      id: 'found-weak',
      type: 'found',
      title: 'Brown Umbrella',
      category: 'Accessories',
      location: 'Sports Ground',
      description: 'brown folding umbrella',
      date_occurred: '2026-02-01',
    });
    const results = findMatches(lostWallet, [weak, foundWallet], 40);
    expect(results.length).toBe(1);
    expect(results[0].item.id).toBe('found-1');
  });

  it('rejects pairs that score below the threshold (false-positive guard)', () => {
    const unrelated = item({
      id: 'found-calc',
      type: 'found',
      title: 'Grey Scientific Calculator',
      category: 'Electronics',
      location: 'Exam Hall',
      description: 'grey calculator with roll number written on the back',
      date_occurred: '2026-03-09',
    });
    expect(findMatches(lostWallet, [unrelated], 40)).toEqual([]);
    expect(findMatches(lostWallet, [unrelated], 0).length).toBe(1); // visible only if the bar is removed
  });

  it('ignores returned and rejected reports', () => {
    const returned = { ...foundWallet, id: 'found-returned', status: 'returned' as const };
    const rejected = { ...foundWallet, id: 'found-rejected', status: 'rejected' as const };
    expect(findMatches(lostWallet, [returned, rejected], 0)).toEqual([]);
  });

  it('lists every candidate only once', () => {
    const results = findMatches(lostWallet, [foundWallet, foundWallet], 0);
    expect(results.length).toBe(1);
  });

  it('sorts results by descending score', () => {
    const weaker = item({
      id: 'found-2',
      type: 'found',
      title: 'Black Wallet',
      category: 'Accessories',
      description: 'wallet found somewhere on campus',
      location: 'Main Gate',
      date_occurred: '2026-03-20',
    });
    const results = findMatches(lostWallet, [weaker, foundWallet], 0);
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('works in the opposite direction (found report finds the lost one)', () => {
    const results = findMatches(foundWallet, [lostWallet], 40);
    expect(results).toHaveLength(1);
    expect(results[0].item.id).toBe('lost-1');
  });
});

/* ------------------------------------------------------------------ */
/* match details persisted with the row                               */
/* ------------------------------------------------------------------ */

describe('buildMatchDetails', () => {
  it('records the algorithm version and the weights used', () => {
    const pair = scorePair(lostWallet, foundWallet)!;
    const details = buildMatchDetails(pair.score, pair.level, pair.breakdown);
    expect(details.algorithm).toBe(MATCH_ALGORITHM_VERSION);
    expect(details.weights).toEqual(MATCH_WEIGHTS);
    expect(details.breakdown).toHaveLength(5);
  });
});
