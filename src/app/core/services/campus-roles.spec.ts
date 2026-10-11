import { describe, expect, it } from 'vitest';
import { coerceCampusRole } from './campus-roles';

describe('coerceCampusRole', () => {
  it.each(['student', 'faculty', 'staff'] as const)('accepts the campus role %s', (role) => {
    expect(coerceCampusRole(role)).toBe(role);
  });

  it('normalises case but never accepts administrator privileges from metadata', () => {
    expect(coerceCampusRole('FACULTY')).toBe('faculty');
    expect(coerceCampusRole('admin')).toBe('student');
    expect(coerceCampusRole('administrator')).toBe('student');
    expect(coerceCampusRole(null)).toBe('student');
  });
});
