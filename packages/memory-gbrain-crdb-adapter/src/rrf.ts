import type { BrainPageRow, RrfHit } from './types.js';

interface ScoredHit {
  page: BrainPageRow;
  score: number;
}

/**
 * Optional post-fold scoring hook (#251 Layer 2). Receives the page's
 * `metadata` object and returns a multiplier to apply to its rrfScore.
 * The fold passes `metadata` rather than the whole page so callers can't
 * depend on shape changes elsewhere — the only signal that should change
 * a page's retrieval rank is what's in metadata (authoringTier, userOverride,
 * bodyLen). When omitted the fold is pure RRF as before.
 */
export type TierWeightFn = (metadata: unknown) => number;

export interface RrfFoldOptions {
  tierWeight?: TierWeightFn;
}

/**
 * Reciprocal Rank Fusion fold. Given two ranked lists (text + vector), compute
 * `1 / (k + rank)` per list and sum per document. Documents missing from a
 * list get zero contribution from that list (rank → ∞).
 *
 * Standard literature uses k = 60. Smaller k weights the head harder; larger k
 * flattens the curve and gives the tail more influence.
 *
 * When `options.tierWeight` is provided, the per-page multiplier is applied
 * to the accumulated rrfScore before the final sort. A multiplier of 0 drops
 * the page from results (used by `userOverride: 'hidden'`). The original
 * `textRank` / `vectorRank` fields are preserved so consumers can still see
 * the raw ranking signal in observability or tests.
 */
export function rrfFold(
  textHits: ScoredHit[],
  vectorHits: ScoredHit[],
  k: number,
  rrfK: number,
  options: RrfFoldOptions = {},
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

  let entries = [...acc.values()];

  if (options.tierWeight) {
    const weight = options.tierWeight;
    for (const hit of entries) {
      // Coerce non-finite or non-number multipliers to 1.0 (identity) so a
      // misbehaving callback can't poison rrfScore into NaN/Infinity. Clamp
      // negatives to 0 — they share the same "drop the page" semantics as
      // userOverride: 'hidden'.
      const raw = weight(hit.page.metadata);
      let mult: number;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        mult = 1.0;
      } else if (raw < 0) {
        mult = 0;
      } else {
        mult = raw;
      }
      hit.rrfScore *= mult;
    }
    // Drop hidden / clamped-to-zero pages; keep everything else even if it
    // got pushed down. Filtering before sort means k slots stay full of
    // surviving results.
    entries = entries.filter((h) => h.rrfScore > 0);
  }

  return entries.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, k);
}
