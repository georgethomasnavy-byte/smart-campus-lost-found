/**
 * ============================================================================
 *  MATCHING CONFIGURATION
 * ============================================================================
 *  Every number used by the matching engine lives here so the behaviour can be
 *  tuned without touching the algorithm itself.
 *
 *  THIS IS NOT MACHINE LEARNING.  There is no model, no training, no
 *  embedding and no external API: the score is a deterministic, rule-based
 *  weighted sum that you can compute by hand and defend in a viva.
 *
 *  Total weight = 100 points.
 * ============================================================================
 */
import type { ItemCategory } from '../models/database.types';
import type { MatchLevel } from '../models/common.model';

/** Signal weights (must add up to 100). */
export const MATCH_WEIGHTS = {
  /** same / related category */
  category: 30,
  /** item name (title) similarity */
  title: 25,
  /** description keyword overlap */
  description: 15,
  /** how close the two locations are */
  location: 20,
  /** how close the two dates are */
  date: 10,
} as const;

export type MatchSignalKey = keyof typeof MATCH_WEIGHTS;

/** Score interpretation bands (spec §19). */
export const MATCH_LEVELS: ReadonlyArray<{ level: MatchLevel; min: number; label: string }> = [
  { level: 'very-strong', min: 90, label: 'Very strong match' },
  { level: 'strong', min: 75, label: 'Strong possible match' },
  { level: 'possible', min: 60, label: 'Possible match' },
  { level: 'low', min: 40, label: 'Low similarity' },
  { level: 'no-match', min: 0, label: 'No useful match' },
];

/** Only scores at or above this value are stored / shown as a match. */
export const MIN_MATCH_SCORE = 40;

/** Scores at or above this value also send a notification immediately. */
export const NOTIFY_FROM_SCORE = 60;

/** Date signal falls to zero beyond this many days apart. */
export const DATE_WINDOW_DAYS = 21;

/**
 * Categories that are considered "close enough" to share some credit.
 * Chosen by hand for campus items: a wallet and a bag are both personal
 * carry items, an ID card and a document are both paperwork, and so on.
 */
export const RELATED_CATEGORIES: Record<ItemCategory, ItemCategory[]> = {
  Electronics: ['Accessories'],
  'ID Cards': ['Documents', 'Accessories'],
  Wallets: ['Bags', 'Accessories'],
  Keys: ['Accessories', 'Bags'],
  Bags: ['Wallets', 'Accessories', 'Books'],
  Books: ['Documents', 'Bags'],
  Clothing: ['Accessories', 'Bags'],
  Accessories: ['Wallets', 'Keys', 'Clothing', 'Electronics', 'ID Cards'],
  Documents: ['ID Cards', 'Books'],
  Other: [],
};

/** Fraction of the category weight earned by a related (not identical) category. */
export const RELATED_CATEGORY_FACTOR = 0.6;

/**
 * Fraction of the category weight earned when either side is "Other".
 * Deliberately neutral: choosing "Other" should not punish a report, but it
 * must not create matches on its own either.
 */
export const OTHER_CATEGORY_FACTOR = 0.5;

/** Substring / token-subset bonuses for the title signal. */
export const TITLE_CONTAINS_BONUS = 0.25;
export const TITLE_SUBSET_BONUS = 0.2;

/** Words ignored when comparing text (they carry no identifying information). */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'my', 'is', 'was', 'were', 'in', 'on', 'at', 'of', 'and',
  'or', 'to', 'for', 'with', 'it', 'its', 'i', 'me', 'near', 'around', 'about',
  'lost', 'found', 'item', 'thing', 'something', 'somewhere', 'please', 'help',
  'has', 'have', 'had', 'this', 'that', 'these', 'those', 'from', 'by', 'very',
]);

/** Version string recorded in matches.matching_details for traceability. */
export const MATCH_ALGORITHM_VERSION = 'rule-based-v2';

/** Safety cap: how many opposite-type items we fetch when scoring one report. */
export const MATCH_CANDIDATE_LIMIT = 300;
