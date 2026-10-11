/**
 * Shared UI/domain models that are not database rows.
 */
import type { ItemCategory, ItemStatus, ItemType, VerificationStatus } from './database.types';

// re-exported so feature code can import everything from one place
export type {
  ItemCategory,
  ItemStatus,
  ItemType,
  VerificationStatus,
  CampusRole,
  UserRole,
  MatchStatus,
  ClaimStatus,
  NotificationType,
} from './database.types';

/** Standard "list + total" envelope used by every listing service. */
export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Filters accepted by the item search service (all server-side). */
export interface ItemFilters {
  /** free-text search across title, description, location, category */
  search?: string;
  type?: ItemType | '';
  category?: ItemCategory | '';
  location?: string;
  status?: ItemStatus | '';
  verificationStatus?: VerificationStatus | '';
  /** ISO dates (YYYY-MM-DD) */
  dateFrom?: string;
  dateTo?: string;
  /** 'newest' | 'oldest' | 'score' */
  sort?: 'newest' | 'oldest' | 'relevance';
  page?: number;
  pageSize?: number;
  /** restrict to one reporter (used by "My reports") */
  reportedBy?: string;
  /** hide rejected reports (default true) */
  hideRejected?: boolean;
}

/** Value object produced by the report forms. */
export interface ItemFormValue {
  type: ItemType;
  title: string;
  category: ItemCategory;
  description: string;
  /** Public campus area, not the exact discovery spot. */
  location: string;
  date_occurred: string;
  keywords: string;
  identifying_characteristics: string;
  collection_instructions?: string | null;
  /** Finder-only data; saved to item_private_details, never to the public item row. */
  exact_found_location?: string | null;
  imageFile?: File | null;
}

/** One result row of the matching engine. */
export interface MatchCandidate {
  item: ItemSummary;
  score: number;
  level: MatchLevel;
  breakdown: MatchBreakdown[];
}

export interface MatchBreakdown {
  key: 'category' | 'title' | 'description' | 'location' | 'date';
  label: string;
  points: number;
  maxPoints: number;
  explanation: string;
}

export type MatchLevel =
  | 'no-match'
  | 'low'
  | 'possible'
  | 'strong'
  | 'very-strong';

/** Only the fields the matching engine needs — keeps the engine decoupled. */
export interface ItemSummary {
  id: string;
  type: ItemType;
  title: string;
  category: ItemCategory;
  description: string;
  location: string;
  date_occurred: string;
  keywords?: string;
  identifying_characteristics?: string;
  status?: ItemStatus;
}

/** Async state machine used to drive loading / error / empty states. */
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** A toast / inline alert message. */
export interface AppMessage {
  kind: 'success' | 'error' | 'info' | 'warning';
  text: string;
  title?: string;
}

/** Option used by <select> controls. */
export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}
