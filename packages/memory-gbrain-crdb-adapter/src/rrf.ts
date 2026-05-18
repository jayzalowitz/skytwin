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
   *
   * Out-of-range values (negative, > 1, NaN, Infinity) silently disable
   * the gate. Matches gbrain v0.35.6.0 `computeFloorThreshold` semantics
   * after the upstream codex outside-voice review caught the same defensive
   * gaps in PR #1091's original shape.
   */
  floorRatio?: number;
  /**
   * @deprecated Use `floorRatio` instead. Kept as a back-compat alias for
   * callers wired before the v0.35.6.0 naming alignment with gbrain
   * `SearchOpts.floorRatio` / `search.floor_ratio` config. `floorRatio`
   * wins if both are set.
   */
  tierWeightFloorRatio?: number;
}

/**
 * Default floor ratio for the tier-weight gate. 0.85 came from the labeled
 * retrieval ablation in [skytwin#272](https://github.com/jayzalowitz/skytwin/pull/272)
 * — the largest ratio that fully eliminated the leapfrog regression on the
 * SkyTwin corpus while preserving baseline rankings on queries with no
 * metadata signal. Upstream gbrain (PR #1129) cites the same starting value
 * for dense-embedder corpora.
 */
export const DEFAULT_FLOOR_RATIO = 0.85;

/**
 * Compute the absolute score floor below which the tier-weight bonus is
 * skipped. Returns `Number.NEGATIVE_INFINITY` (no gate) when:
 *   - `floorRatio` is `undefined` (callers haven't opted in to a custom value
 *     — but `rrfFold` defaults to `DEFAULT_FLOOR_RATIO` before calling this)
 *   - `floorRatio` is NaN, Infinity, < 0, or > 1 (out-of-range; defense in
 *     depth so a malformed value never gates anything)
 *   - No entry has a positive, finite rrfScore (all-NaN, all-negative, or
 *     empty input — no positive signal means no gate)
 *
 * Otherwise returns `topScore * floorRatio`, where `topScore` is the largest
 * finite rrfScore.
 *
 * Mirrors `computeFloorThreshold` in gbrain `src/core/search/hybrid.ts`
 * (v0.35.6.0). The three guards above are the codex outside-voice fixes
 * from upstream PR #1129 review pass — applied here so our additive
 * tier-weight path picks them up too.
 */
export function computeFloorThreshold(
  entries: ReadonlyArray<{ rrfScore: number }>,
  floorRatio: number | undefined,
): number {
  if (floorRatio === undefined) return Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(floorRatio) || floorRatio < 0 || floorRatio > 1) {
    return Number.NEGATIVE_INFINITY;
  }
  let top = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    if (Number.isFinite(e.rrfScore) && e.rrfScore > top) top = e.rrfScore;
  }
  if (!Number.isFinite(top) || top <= 0) return Number.NEGATIVE_INFINITY;
  return top * floorRatio;
}

/**
 * Walk a list of candidate floor ratios in priority order and return the
 * first VALID one. A value is valid iff it is a finite number in [0, 1].
 * The final argument is the unconditional fallback (typically
 * `DEFAULT_FLOOR_RATIO`) and is NOT validated — callers that want a
 * disabled gate should pass `Number.NaN` as a positional sentinel and
 * accept that the result will be the default. This keeps the function
 * total: it always returns a number. Used by `rrfFold` to resolve
 * `floorRatio` from new + deprecated option fields with fail-safe
 * fallback (codex T2 from gbrain PR #1129's outside-voice review).
 */
function pickValidFloorRatio(...candidates: Array<number | undefined>): number {
  for (const c of candidates) {
    if (c !== undefined && Number.isFinite(c) && c >= 0 && c <= 1) return c;
  }
  // Fallback: every candidate was invalid. The DEFAULT_FLOOR_RATIO is the
  // canonical last entry; if a caller passed something else as the final
  // candidate, return it anyway so this function stays total. Composition
  // discipline is the caller's job.
  return candidates[candidates.length - 1] ?? DEFAULT_FLOOR_RATIO;
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
    // Precedence with fail-safe validation (codex T2): walk the list of
    // candidate floor ratios in priority order and use the first VALID one.
    // A caller that wires both `floorRatio` AND the deprecated alias, with
    // the new option holding an out-of-range/NaN value (e.g. from buggy
    // config parsing), shouldn't accidentally nullify the legacy guard.
    // Falling back through the chain preserves the strongest valid signal
    // available; landing on `DEFAULT_FLOOR_RATIO` is the worst case.
    const floorRatio = pickValidFloorRatio(
      options.floorRatio,
      options.tierWeightFloorRatio,
      DEFAULT_FLOOR_RATIO,
    );
    // Single-baseline threshold (gbrain v0.35.6.0 shape): compute ONCE before
    // any bonus mutates rrfScore. Returns -Infinity when there's no positive
    // signal (all-negative scores, empty input) so the gate is disabled
    // rather than silently rejecting every entry against `top = 0`.
    const threshold = computeFloorThreshold(entries, floorRatio);

    for (const hit of entries) {
      const raw = bonusFn(hit.page.metadata);
      // -Infinity → drop the page (userOverride: 'hidden'). Bypasses gate.
      if (raw === Number.NEGATIVE_INFINITY) {
        hit.rrfScore = Number.NEGATIVE_INFINITY;
        continue;
      }
      // NaN-score defense (gbrain v0.35.6.0 / codex outside-voice T1a): a
      // non-finite rrfScore would slip past `hit.rrfScore < threshold`
      // because `NaN < x` is false in JS, then get the bonus added and
      // poison the sort. Explicitly skip the bonus for non-finite scores;
      // the post-loop `isFinite` filter then removes them from results so
      // they can't contaminate the sort (which treats NaN comparator
      // results as 0 / equal, leaving NaN-scored hits in insertion order).
      if (!Number.isFinite(hit.rrfScore)) continue;
      // Gate: weak-relevance pages get no bonus, regardless of tier.
      if (hit.rrfScore < threshold) continue;
      // Coerce non-finite / non-number returns to 0 (no contribution) so a
      // misbehaving callback can't poison rrfScore into NaN.
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      hit.rrfScore += raw;
    }
    // Drop all non-finite-scored pages (codex T3 / sort-safety from gbrain
    // PR #1129's outside-voice review):
    //
    //   - `-Infinity`: explicit hidden sentinel from `userOverride: 'hidden'`.
    //   - `NaN`: corruption (e.g. caller-supplied `rrfK: NaN` makes every
    //     `1 / (rrfK + rank)` NaN). The naive `b - a` comparator returns
    //     `NaN` for any NaN side, which JS sort treats as 0 (equal) — leaving
    //     NaN-scored hits in insertion order, where they can land in top-k.
    //   - `+Infinity`: unusual but possible if `rrfK + rank === 0` divides
    //     by zero. Would sort to the top of every query.
    //
    // Filtering them out unconditionally is the safe move — the sort then
    // operates only on finite scores and produces a deterministic ranking.
    // Finite negative scores (legitimate downweights) are preserved; they
    // reorder, they don't remove.
    entries = entries.filter((h) => Number.isFinite(h.rrfScore));
  } else {
    // Even without `tierWeight`, defensively drop non-finite raw RRF scores
    // (caller might have passed `rrfK: NaN` or otherwise corrupted state).
    // Pure-RRF callers got this behavior for free pre-bonus-loop because
    // RRF contributions are always finite — but a malformed `rrfK` could
    // still poison results, and dropping is cheaper than letting NaN ride
    // through to the comparator. No-op on normal input.
    entries = entries.filter((h) => Number.isFinite(h.rrfScore));
  }

  return entries.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, k);
}
