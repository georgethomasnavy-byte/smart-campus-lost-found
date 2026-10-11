import type { CampusRole } from '../models/database.types';

const CAMPUS_ROLE_SET: ReadonlySet<string> = new Set(['student', 'faculty', 'staff']);

/**
 * Convert untrusted registration metadata to an ordinary campus role.
 * In particular, "admin" and unknown values can never become administrator
 * privileges; the database trigger independently applies the same allowlist.
 */
export function coerceCampusRole(value: unknown): CampusRole {
  return typeof value === 'string' && CAMPUS_ROLE_SET.has(value.toLowerCase())
    ? (value.toLowerCase() as CampusRole)
    : 'student';
}
