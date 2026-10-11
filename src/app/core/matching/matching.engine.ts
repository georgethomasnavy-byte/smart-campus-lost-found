/**
 * ============================================================================
 *  THE MATCHING ENGINE  ·  deterministic, rule-based, 100 % explainable
 * ============================================================================
 *  A new report is compared against every open report of the OPPOSITE type
 *  (lost -> found and found -> lost) and receives a score out of 100 built
 *  from five weighted signals:
 *
 *      category 30 | title 25 | description 15 | location 20 | date 10
 *
 *  The engine is a set of PURE FUNCTIONS: same input always gives the same
 *  output, nothing is random, nothing is learned, and there is no network
 *  call.  That is what makes it testable (see matching.engine.spec.ts) and
 *  what makes the result explainable to a user — every score can be broken
 *  down line by line in the interface.
 * ============================================================================
 */
import {
  DATE_WINDOW_DAYS,
  MATCH_ALGORITHM_VERSION,
  MATCH_LEVELS,
  MATCH_WEIGHTS,
  OTHER_CATEGORY_FACTOR,
  RELATED_CATEGORIES,
  RELATED_CATEGORY_FACTOR,
  STOP_WORDS,
  TITLE_CONTAINS_BONUS,
  TITLE_SUBSET_BONUS,
} from './matching.config';
import type {
  ItemSummary,
  MatchBreakdown,
  MatchCandidate,
  MatchLevel,
} from '../models/common.model';

/* ==========================================================================
 * 1. Text utilities (pure)
 * ========================================================================== */

/** Lower-case, trim and collapse whitespace. */
export function normalise(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Split text into meaningful word tokens.
 * Used instead of a heavy NLP library: this is simple, fast and explainable.
 */
export function tokenise(...values: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const raw of normalise(value).split(/[^a-z0-9]+/)) {
      if (raw.length > 1 && !STOP_WORDS.has(raw)) {
        tokens.add(raw);
      }
    }
  }
  return tokens;
}

/**
 * Sørensen–Dice similarity of two token sets: 2·|A∩B| / (|A|+|B|).
 * Chosen over cosine distance because it needs no vectors and is symmetric.
 */
export function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared++;
    }
  }
  return (2 * shared) / (a.size + b.size);
}

/** Tokens present in both sets (for the human-readable explanation). */
export function sharedTokens(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => b.has(token)).sort();
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

/** Whole days between two ISO dates, or NaN when a date cannot be parsed. */
export function daysBetween(first: string, second: string): number {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${second}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return Number.NaN;
  }
  return Math.abs(a - b) / 86_400_000;
}

/* ==========================================================================
 * 2. The five scoring signals
 *    Each returns { ratio (0..1), explanation } so the caller can both compute
 *    the weighted score and show the user why it got that score.
 * ========================================================================== */

interface SignalResult {
  ratio: number;
  explanation: string;
}

/** 30 points — identical category, related category, or "Other" wildcard. */
export function scoreCategory(a: ItemSummary, b: ItemSummary): SignalResult {
  if (a.category === b.category) {
    return { ratio: 1, explanation: `Same category (${a.category})` };
  }

  if (a.category === 'Other' || b.category === 'Other') {
    return {
      ratio: OTHER_CATEGORY_FACTOR,
      explanation: 'One report used the "Other" category',
    };
  }

  const related =
    (RELATED_CATEGORIES[a.category] ?? []).includes(b.category) ||
    (RELATED_CATEGORIES[b.category] ?? []).includes(a.category);

  if (related) {
    return {
      ratio: RELATED_CATEGORY_FACTOR,
      explanation: `Related categories (${a.category} / ${b.category})`,
    };
  }

  return { ratio: 0, explanation: `Different categories (${a.category} / ${b.category})` };
}

/** 25 points — the item name, which is usually the strongest clue. */
export function scoreTitle(a: ItemSummary, b: ItemSummary): SignalResult {
  const tokensA = tokenise(a.title);
  const tokensB = tokenise(b.title);
  const similarity = diceSimilarity(tokensA, tokensB);

  const nameA = normalise(a.title);
  const nameB = normalise(b.title);
  const contains = nameA.length > 0 && nameB.length > 0 &&
    (nameA.includes(nameB) || nameB.includes(nameA));

  // every word of the shorter name appears in the longer one
  const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  let subset = false;
  if (small.size >= 2) {
    subset = [...small].every((token) => large.has(token));
  }

  const bonus = contains
    ? TITLE_CONTAINS_BONUS
    : subset
      ? TITLE_SUBSET_BONUS
      : 0;

  const shared = sharedTokens(tokensA, tokensB);
  const explanation = shared.length
    ? `Shared words: ${shared.slice(0, 6).join(', ')}`
    : 'No shared words in the item names';

  return { ratio: clamp(similarity + bonus), explanation };
}

/** 15 points — extra detail only a real owner would describe. */
export function scoreDescription(a: ItemSummary, b: ItemSummary): SignalResult {
  // Explicit keywords and identifying characteristics complement the free-text
  // description. These are public item attributes; private exact locations and
  // claimant answers are never passed to the matching engine.
  const tokensA = tokenise(a.description, a.keywords, a.identifying_characteristics);
  const tokensB = tokenise(b.description, b.keywords, b.identifying_characteristics);
  const similarity = diceSimilarity(tokensA, tokensB);
  const shared = sharedTokens(tokensA, tokensB);

  return {
    ratio: clamp(similarity),
    explanation: shared.length
      ? `${shared.length} shared detail word(s): ${shared.slice(0, 5).join(', ')}`
      : 'No shared detail words',
  };
}

/** 20 points — did the item go missing / turn up in the same place? */
export function scoreLocation(a: ItemSummary, b: ItemSummary): SignalResult {
  const rawA = normalise(a.location);
  const rawB = normalise(b.location);

  if (!rawA || !rawB) {
    return { ratio: 0, explanation: 'Location missing on one report' };
  }
  if (rawA === rawB) {
    return { ratio: 1, explanation: `Same location (${a.location})` };
  }
  if (rawA.includes(rawB) || rawB.includes(rawA)) {
    return { ratio: 0.8, explanation: `Location closely matches (${a.location} / ${b.location})` };
  }

  const similarity = diceSimilarity(tokenise(rawA), tokenise(rawB));
  return {
    ratio: clamp(similarity),
    explanation: similarity > 0.3
      ? `Locations are similar (${a.location} / ${b.location})`
      : 'Different locations',
  };
}

/** 10 points — items lost and found around the same time are far more likely to be the same item. */
export function scoreDate(a: ItemSummary, b: ItemSummary): SignalResult {
  const days = daysBetween(a.date_occurred, b.date_occurred);

  if (Number.isNaN(days)) {
    return { ratio: 0.5, explanation: 'Date missing on one report' };
  }
  if (days === 0) {
    return { ratio: 1, explanation: 'Both dates are the same day' };
  }

  const ratio = clamp(1 - days / DATE_WINDOW_DAYS);
  return {
    ratio,
    explanation: `${Math.round(days)} day(s) apart`,
  };
}

/* ==========================================================================
 * 3. The public API of the engine
 * ========================================================================== */

/** Map a 0-100 score onto its interpretation band. */
export function scoreToLevel(score: number): MatchLevel {
  for (const band of MATCH_LEVELS) {
    if (score >= band.min) {
      return band.level;
    }
  }
  return 'no-match';
}

/** Human label for a band (used by badges). */
export function levelLabel(level: MatchLevel): string {
  return MATCH_LEVELS.find((band) => band.level === level)?.label ?? 'No useful match';
}

/**
 * Score a LOST item against a FOUND item.
 *
 * Returns null when the comparison is not allowed:
 *   * the two items are the same row
 *   * the pair is not lost -> found (never lost/lost or found/found)
 */
export function scorePair(
  lost: ItemSummary,
  found: ItemSummary
): { score: number; level: MatchLevel; breakdown: MatchBreakdown[] } | null {
  if (lost.id === found.id) {
    return null;
  }
  if (lost.type !== 'lost' || found.type !== 'found') {
    return null;
  }

  const category = scoreCategory(lost, found);
  const title = scoreTitle(lost, found);
  const description = scoreDescription(lost, found);
  const location = scoreLocation(lost, found);
  const date = scoreDate(lost, found);

  // Each signal is rounded to a whole point FIRST, so the five numbers shown
  // to the user always add up exactly to the score they are shown.
  const breakdown: MatchBreakdown[] = [
    { key: 'category', label: 'Category', points: pointsFor('category', category.ratio), maxPoints: MATCH_WEIGHTS.category, explanation: category.explanation },
    { key: 'title', label: 'Item name', points: pointsFor('title', title.ratio), maxPoints: MATCH_WEIGHTS.title, explanation: title.explanation },
    { key: 'description', label: 'Description', points: pointsFor('description', description.ratio), maxPoints: MATCH_WEIGHTS.description, explanation: description.explanation },
    { key: 'location', label: 'Location', points: pointsFor('location', location.ratio), maxPoints: MATCH_WEIGHTS.location, explanation: location.explanation },
    { key: 'date', label: 'Date', points: pointsFor('date', date.ratio), maxPoints: MATCH_WEIGHTS.date, explanation: date.explanation },
  ];

  const score = Math.min(100, breakdown.reduce((total, part) => total + part.points, 0));

  return { score, level: scoreToLevel(score), breakdown };
}

/**
 * Score one item against a list of candidates and return the worthwhile
 * matches, strongest first.
 *
 * @param item       the report that was just created
 * @param candidates open reports of the opposite type
 * @param minScore   discard anything below this score (default 40)
 */
export function findMatches(
  item: ItemSummary,
  candidates: ItemSummary[],
  minScore = 40
): MatchCandidate[] {
  const lost = item.type === 'lost' ? item : null;
  const found = item.type === 'found' ? item : null;

  const results: MatchCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.id === item.id || candidate.type === item.type) {
      continue; // never match an item with itself or with its own type
    }
    if (seen.has(candidate.id)) {
      continue; // defensive: a join could hand us the same row twice
    }
    seen.add(candidate.id);
    if (candidate.status === 'rejected' || candidate.status === 'returned' || candidate.status === 'closed') {
      continue; // nothing useful left to match
    }

    const pair = lost && candidate.type === 'found'
      ? scorePair(lost, candidate)
      : found && candidate.type === 'lost'
        ? scorePair(candidate, found)
        : null;

    if (!pair || pair.score < minScore) {
      continue;
    }

    results.push({
      item: candidate,
      score: pair.score,
      level: pair.level,
      breakdown: pair.breakdown,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Storage payload written to matches.matching_details, so a stored match can
 * still be explained months later.
 */
export function buildMatchDetails(
  score: number,
  level: MatchLevel,
  breakdown: MatchBreakdown[]
): { breakdown: MatchBreakdown[]; level: string; algorithm: string; weights: Record<string, number> } {
  return {
    breakdown,
    level,
    algorithm: MATCH_ALGORITHM_VERSION,
    weights: { ...MATCH_WEIGHTS },
  };
}

/** Awarded points for one signal: weight x ratio, as a whole number. */
function pointsFor(signal: keyof typeof MATCH_WEIGHTS, ratio: number): number {
  return Math.round(MATCH_WEIGHTS[signal] * clamp(ratio));
}
