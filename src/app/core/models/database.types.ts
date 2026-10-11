/**
 * Database row types — a hand-written mirror of the SQL in
 * supabase/migrations.  Keeping them in one place means a schema change is a
 * one-file change, and every service is type-checked against it.
 */

/* ------------------------------- enums ---------------------------------- */

export type CampusRole = 'student' | 'faculty' | 'staff';

export type UserRole = CampusRole | 'admin';

export const CAMPUS_ROLES: readonly CampusRole[] = ['student', 'faculty', 'staff'];

export type ItemType = 'lost' | 'found';

export const ITEM_CATEGORIES = [
  'Electronics',
  'ID Cards',
  'Wallets',
  'Keys',
  'Bags',
  'Books',
  'Clothing',
  'Accessories',
  'Documents',
  'Other',
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export type ItemStatus = 'active' | 'matched' | 'claimed' | 'returned' | 'closed' | 'rejected';

export type VerificationStatus = 'pending' | 'verified' | 'rejected';

export type ClaimStatus = 'pending' | 'needs_info' | 'approved' | 'rejected' | 'cancelled';

export type MatchStatus = 'suggested' | 'accepted' | 'dismissed';

export type ClaimReviewDecision = 'approved' | 'rejected' | 'needs_info';

export type NotificationType =
  | 'match'
  | 'match_accepted'
  | 'claim_submitted'
  | 'claim_approved'
  | 'claim_rejected'
  | 'claim_cancelled'
  | 'claim_needs_info'
  | 'item_handed_over'
  | 'report_verified'
  | 'report_rejected'
  | 'item_status'
  | 'system';

export type AbuseReportStatus = 'pending' | 'reviewed' | 'dismissed' | 'actioned';

/* ------------------------------- tables --------------------------------- */

export interface Profile {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  role: UserRole;
  /** Campus identity is retained even when this account is granted admin privileges. */
  campus_role: CampusRole;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

/** The public-safe view of a profile (no e-mail, no phone). */
export interface PublicProfile {
  user_id: string;
  full_name: string;
  role: UserRole;
  campus_role: CampusRole;
}

export interface Item {
  id: string;
  reported_by: string;
  type: ItemType;
  title: string;
  category: ItemCategory;
  description: string;
  /** General public campus location; never the exact private find spot. */
  location: string;
  date_occurred: string; // YYYY-MM-DD
  keywords: string;
  identifying_characteristics: string;
  /** Public pickup instructions, kept separate from private verification data. */
  collection_instructions: string | null;
  image_url: string | null;
  image_path: string | null;
  status: ItemStatus;
  verification_status: VerificationStatus;
  resolved_at: string | null;
  handed_over_at: string | null;
  handed_over_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Private exact discovery location; only the finder and admins may read it. */
export interface ItemPrivateDetails {
  item_id: string;
  exact_found_location: string;
  created_at: string;
  updated_at: string;
}

/** An item joined with its reporter's public information. */
export type ItemWithReporter = Item & { reporter?: PublicProfile | null };

export interface Claim {
  id: string;
  item_id: string;
  claimant_id: string;
  message: string;
  /** Private claimant answer to where they believe they lost the item. */
  lost_location_answer: string;
  status: ClaimStatus;
  admin_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Publicly visible, intentionally limited claim history row. */
export interface PublicClaimHistory {
  id: string;
  item_id: string;
  claimant_name: string;
  campus_role: CampusRole;
  claim_date: string;
  status: ClaimStatus;
}

export interface ClaimReviewEvent {
  id: string;
  claim_id: string;
  item_id: string;
  reviewed_by: string | null;
  from_status: ClaimStatus;
  to_status: ClaimStatus;
  notes: string | null;
  created_at: string;
  reviewer?: PublicProfile | null;
}

export interface ClaimVerificationEvidence {
  exact_found_location: string | null;
  lost_location_answer: string;
  /** Supporting word-overlap percentage only; it is not proof of ownership. */
  location_similarity: number;
}

/** A private claim joined with the item and the people involved. */
export interface ClaimWithRelations extends Claim {
  item?: ItemWithReporter | null;
  claimant?: PublicProfile | null;
  reviewer?: PublicProfile | null;
  review_history?: ClaimReviewEvent[];
  verification_evidence?: ClaimVerificationEvidence;
}

/** Public item search RPC result. */
export interface PublicItemSearchResult {
  rows: Item[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Match {
  id: string;
  lost_item_id: string;
  found_item_id: string;
  score: number;
  matching_details: MatchDetails | null;
  status: MatchStatus;
  created_at: string;
  updated_at: string;
}

/** Shape stored in matches.matching_details (jsonb). */
export interface MatchDetails {
  breakdown: MatchBreakdownItem[];
  level: string;
  algorithm: string;
  weights: Record<string, number>;
}

export interface MatchBreakdownItem {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  explanation: string;
}

/** A match joined with both items — what the UI actually renders. */
export interface MatchWithItems extends Match {
  lost_item?: ItemWithReporter | null;
  found_item?: ItemWithReporter | null;
}

export interface AppNotification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: NotificationType;
  related_item_id: string | null;
  related_claim_id: string | null;
  is_read: boolean;
  created_at: string;
}

export interface AbuseReport {
  id: string;
  reported_by: string;
  item_id: string;
  reason: string;
  description: string | null;
  status: AbuseReportStatus;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface AbuseReportWithRelations extends AbuseReport {
  item?: ItemWithReporter | null;
  reporter?: PublicProfile | null;
}

export interface ActivityLog {
  id: number;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityLogWithUser extends ActivityLog {
  user?: PublicProfile | null;
}

/* --------------------------- helper payloads ----------------------------- */

/** Statistics returned by the public_stats() database function. */
export interface PublicStats {
  active_lost_items: number;
  found_items: number;
  possible_matches: number;
  recovered_items: number;
  total_items: number;
  registered_students: number;
  registered_campus_users: number;
}

/** Statistics returned by the admin_stats() database function. */
export interface AdminStats {
  total_students: number;
  total_faculty: number;
  total_staff: number;
  total_campus_users: number;
  total_admins: number;
  total_items: number;
  total_lost: number;
  total_found: number;
  pending_verification: number;
  verified_items: number;
  pending_claims: number;
  total_claims: number;
  approved_claims: number;
  rejected_claims: number;
  possible_matches: number;
  strong_matches: number;
  recovered_items: number;
  open_abuse_reports: number;
  recovery_rate: number;
}

/** One row of admin_category_stats(). */
export interface CategoryStat {
  category: ItemCategory;
  total: number;
  lost: number;
  found: number;
  returned: number;
}
