import type { BrainPageRow, RrfHit } from './types.js';

interface ScoredHit {
  page: BrainPageRow;
  score: number;
}

/**
 * Optional post-fold scoring hook (#251 Layer 2). Receives the page's
 * `metadata` object and returns an additive bonus to apply to its
 * rrfScore. The fold passes `metadata` rather than the whole page so
 * callers can't depend on shape changes elsewhere — the only signal that
 * should change a page's retrieval rank is what's in metadata
 * (authoringTier, userOverride, bodyLen). When omitted the fold is pure
 * RRF as before.
 *
 * **Why additive, not multiplicative.** The original cut of this hook
 * multiplied (`score *= weight`). The labeled-retrieval ablation in
 * `packages/memory-gbrain/src/__tests__/tier-ablation-eval.test.ts`
 * surfaced that this is structurally broken: a 1.5× promote + 0.8×
 * demote produces a 1.875× swing, which lets a weak-overlap authored
 * page leapfrog a strong-but-demoted primary hit. PR #272 confirmed
 * the regression survives a switch to real OpenAI-shape embeddings.
 *
 * Additive bonuses (per-tier `tierBonus(metadata)` in `tier-weights.ts`)
 * preserve the rank order on strong-vs-weak comparisons while still
 * breaking close ties in favor of authored content.
 *
 * Special sentinel: `Number.NEGATIVE_INFINITY` means "drop this page
 * entirely" — used by `userOverride: 'hidden'`. This is the ONLY way a
 * tier-weight callback can remove a page from results; ordinary negative
 * bonuses demote rank without affecting inclusion.
 */
export type TierWeightFn = (metadata: unknown) => number;

export interface RrfFoldOptions {
  /**
   * Per-page additive bonus to apply to rrfScore. Returns
   * `Number.NEGATIVE_INFINITY` to drop the page (hidden override).
   */
  tierWeight?: TierWeightFn;
  /**
   * Apply the tier bonus ONLY to pages whose raw rrfScore is at least
   * this fraction of the top page's raw score. Default 0.85.
   *
   * **Why.** Real semantic embedders produce non-trivial vector
   * similarity even between topically-unrelated content (any two
   * "professional emails" land in similar regions of embedding space).
   * The PR #272 real-embedding eval showed that without a gate, weak-
   * match authored pages from unrelated queries climb into a target
   * query's top-K via vector overlap alone, get the additive bonus,
   * and leapfrog the legitimate primary hit.
   *
   * The gate cuts the bonus's reach. Only pages within `floorRatio *
   * topRawScore` are eligible; the tail of the candidate pool keeps
   * its unweighted score. This means a weak-overlap authored distractor
   * never gets the boost — its raw score is below the gate.
   *
   * `userOverride: 'hidden'` ignores the gate (sentinel always drops).
   */
  tierWeightFloorRatio?: number;
}

/**
 * Reciprocal Rank Fusion fold. Given two ranked lists (text + vector), compute
 * `1 / (k + rank)` per list and sum per document. Documents missing from a
 * list get zero contribution from that list (rank → ∞).
 *
 * Standard literature uses k = 60. Smaller k weights the head harder; larger k
 * flattens the curve and gives the tail more influence.
 *
 * When `options.tierWeight` is provided, the per-page additive bonus is
 * applied to the accumulated rrfScore before the final sort. A bonus of
 * `Number.NEGATIVE_INFINITY` drops the page from results (used by
 * `userOverride: 'hidden'`). The original `textRank` / `vectorRank`
 * fields are preserved so consumers can still see the raw ranking
 * signal in observability or tests.
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
    const bonusFn = options.tierWeight;
    const floorRatio = options.tierWeightFloorRatio ?? 0.85;
    // Compute the gate threshold up-front: only pages with raw rrfScore
    // ≥ floorRatio * topRawScore are eligible for the bonus. The
    // `userOverride: 'hidden'` sentinel bypasses the gate (a hidden
    // page must be dropped no matter where it ranks).
    let topRawScore = 0;
    for (const hit of entries) {
      if (hit.rrfScore > topRawScore) topRawScore = hit.rrfScore;
    }
    const threshold = topRawScore * floorRatio;

    for (const hit of entries) {
      const raw = bonusFn(hit.page.metadata);
      // -Infinity → drop the page (userOverride: 'hidden'). Bypasses gate.
      if (raw === Number.NEGATIVE_INFINITY) {
        hit.rrfScore = Number.NEGATIVE_INFINITY;
        continue;
      }
      // Gate: weak-relevance pages get no bonus, regardless of tier.
      if (hit.rrfScore < threshold) continue;
      // Coerce non-finite / non-number returns to 0 (no contribution) so a
      // misbehaving callback can't poison rrfScore into NaN.
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      hit.rrfScore += raw;
    }
    // Drop ONLY pages that were explicitly hidden via the
    // NEGATIVE_INFINITY sentinel. Ordinary negative bonuses are allowed
    // to push scores below zero; they reorder, they don't remove.
    // (Without this, a sufficiently negative bonus would silently
    // change inclusion semantics in a way the tier-weight contract
    // doesn't promise.)
    entries = entries.filter((h) => h.rrfScore !== Number.NEGATIVE_INFINITY);
  }

  return entries.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, k);
}
