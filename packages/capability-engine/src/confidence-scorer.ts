/**
 * Deterministic v1 confidence scorer.
 * score = min(1, log10(evidenceCount + 1) / 2 + 0.2 * kindsDistinct)
 * Capped at 1.0, floored at 0.0.
 * The prompt-driven replacement ships in #189.
 */
export function scoreConfidence(evidenceCount: number, kindsDistinct: number): number {
  if (evidenceCount <= 0) return 0;
  const raw = Math.log10(evidenceCount + 1) / 2 + 0.2 * kindsDistinct;
  return Math.min(1, Math.max(0, raw));
}
