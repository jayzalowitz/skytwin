import type { BrainPageRow, RrfHit } from './types.js';

interface ScoredHit {
  page: BrainPageRow;
  score: number;
}

/**
 * Reciprocal Rank Fusion fold. Given two ranked lists (text + vector), compute
 * `1 / (k + rank)` per list and sum per document. Documents missing from a
 * list get zero contribution from that list (rank → ∞).
 *
 * Standard literature uses k = 60. Smaller k weights the head harder; larger k
 * flattens the curve and gives the tail more influence.
 *
 * Returned rows include `textRank` and `vectorRank` so consumers can reason
 * about *why* a page ranked where it did — useful in observability + tests.
 */
export function rrfFold(
  textHits: ScoredHit[],
  vectorHits: ScoredHit[],
  k: number,
  rrfK: number,
): RrfHit[] {
  const acc = new Map<string, RrfHit>();

  textHits.forEach((hit, i) => {
    const rank = i + 1;
    const contribution = 1 / (rrfK + rank);
    const existing = acc.get(hit.page.id);
    if (existing) {
      existing.rrfScore += contribution;
      existing.textRank = rank;
    } else {
      acc.set(hit.page.id, {
        id: hit.page.id,
        rrfScore: contribution,
        textRank: rank,
        vectorRank: null,
        page: hit.page,
      });
    }
  });

  vectorHits.forEach((hit, i) => {
    const rank = i + 1;
    const contribution = 1 / (rrfK + rank);
    const existing = acc.get(hit.page.id);
    if (existing) {
      existing.rrfScore += contribution;
      existing.vectorRank = rank;
    } else {
      acc.set(hit.page.id, {
        id: hit.page.id,
        rrfScore: contribution,
        textRank: null,
        vectorRank: rank,
        page: hit.page,
      });
    }
  });

  return [...acc.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, k);
}
