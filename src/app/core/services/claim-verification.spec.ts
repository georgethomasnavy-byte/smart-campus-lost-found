import { describe, expect, it } from 'vitest';
import { locationEvidenceSimilarity } from './claim-verification';

describe('locationEvidenceSimilarity', () => {
  it('returns 100 for a case-insensitive exact match', () => {
    expect(locationEvidenceSimilarity('Library, south desk', 'library, south desk')).toBe(100);
  });

  it('returns a supporting partial-overlap score for similar answers', () => {
    const score = locationEvidenceSimilarity('Near the east library entrance', 'East library entrance, beside the stairs');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('returns zero for empty or unrelated answers', () => {
    expect(locationEvidenceSimilarity('', 'Science lab')).toBe(0);
    expect(locationEvidenceSimilarity('Parking lot', 'Science lab')).toBe(0);
  });
});
