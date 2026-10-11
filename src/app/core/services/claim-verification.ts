/**
 * A small, deterministic evidence aid for administrators. This is deliberately
 * not an ownership decision: a text similarity score may help compare a
 * claimant's believed lost location with the finder's private exact location,
 * but administrators must review the full evidence and never approve from the
 * score alone.
 */
export function locationEvidenceSimilarity(claimantAnswer: string, exactFoundLocation: string): number {
  const normalise = (value: string) => value.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
  const answer = normalise(claimantAnswer);
  const exact = normalise(exactFoundLocation);
  if (!answer || !exact) {
    return 0;
  }
  if (answer === exact) {
    return 100;
  }

  const tokens = (value: string) => new Set(
    (value.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1),
  );
  const answerTokens = tokens(answer);
  const exactTokens = tokens(exact);
  if (answerTokens.size === 0 || exactTokens.size === 0) {
    return 0;
  }
  const shared = [...answerTokens].filter((token) => exactTokens.has(token)).length;
  const union = new Set([...answerTokens, ...exactTokens]).size;
  return Math.round((shared / union) * 100);
}
