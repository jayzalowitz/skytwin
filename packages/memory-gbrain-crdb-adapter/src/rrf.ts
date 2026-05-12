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
  /**
   * When `tierWeight` is set, apply the multiplier ONLY to pages whose
   * raw rrfScore is at least this fraction of the top page's raw score.
   * Default 0.85. Prevents weak-match distractors that happen to share an
   * authored tier from being boosted above legitimate rank-1 primary hits
   * with a demoted tier. The labeled retrieval ablation showed this was
   * load-bearing — without the gate, a rank-30 authored distractor at
   * score 0.010 × 1.5 = 0.015 beat a rank-1 received primary at score
   * 0.016 × 0.8 = 0.013, breaking `received_content` queries entirely.
   *
   * RRF scores decay slowly (1/(60+rank)) so the floor needs to be high
   * enough to keep tail-of-pool candidates out: at floor 0.5 the gate is
   * effectively no-op (rank 1..62 all pass); at 0.85 the gate lets in
   * roughly top-12 candidates, which matches the "rerank plausible
   * candidates, don't promote noise" intent of Layer 2.
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
    const floorRatio = options.tierWeightFloorRatio ?? 0.85;
    // Determine the gating threshold: only pages whose raw rrfScore is
    // at least `floorRatio * topRawScore` get tier-weighted. Pages below
    // the threshold are kept at their unweighted rrfScore — they can
    // neither boost above strong matches nor get demoted below noise.
    // This is the load-bearing change for the labeled-retrieval ablation.
    let topRawScore = 0;
    for (const hit of entries) {
      if (hit.rrfScore > topRawScore) topRawScore = hit.rrfScore;
    }
    const threshold = topRawScore * floorRatio;

    for (const hit of entries) {
      if (hit.rrfScore < threshold) continue;
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
    // surviving results. Pages below the threshold aren't affected by the
    // multiplier, so they survive at their original rrfScore.
    entries = entries.filter((h) => h.rrfScore > 0);
  }

  return entries.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, k);
}
