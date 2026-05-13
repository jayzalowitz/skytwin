/**
 * Authoring-tier retrieval bonuses (#251 Layer 2 — additive rewrite).
 *
 * The gbrain RRF fold applies these *additively* to a page's rrfScore
 * post-fold so user-authored pages get a tie-breaker edge on equal-text
 * queries without leapfrogging legitimately-stronger primary hits.
 *
 * **Why additive, not multiplicative.** The first cut of this module used
 * a multiplier (`score *= weight`), which produced a structural regression
 * on `received_content` queries — see PR #260's eval and PR #272's
 * real-embedding follow-up. With multipliers, a 1.5× boost on authored
 * vs 0.8× demote on automated produces a 1.875× swing: an authored page
 * within 53% of the top raw score (very common in any non-trivial
 * candidate pool) leapfrogs a strong-but-demoted primary hit.
 *
 * Additive bonuses fix this. RRF scores live in the 0.005–0.033 range at
 * default `rrfK=60`; bonuses of ±0.005 are large enough to flip close
 * calls (rank-1 vs rank-2 raw, diff ~0.0003) but small enough that a
 * truly-strong primary (rank 1 in both lists, score ~0.033) keeps its
 * lead over any weak-overlap authored noise (rank 10+, score < 0.015).
 *
 * The three calibration bands now scale the bonus *magnitude*, not the
 * multiplier value:
 *
 *   - sparse  (<100 user_sent_* pages in 90d): smaller bonuses so a
 *     thin sent corpus doesn't dominate retrieval.
 *   - normal:  the default band.
 *   - dense   (>1000 user_sent_* pages in 90d): larger spread so a
 *     heavy writer's authored signal can punch through more aggressive
 *     received noise.
 *
 * `metadata.userOverride` composes:
 *   - 'pinned'  → adds a fixed boost on TOP of the tier bonus.
 *   - 'hidden'  → returns a special sentinel that drops the page entirely.
 *   - missing  → no override contribution.
 */

import type { TierCalibration } from './types.js';

export type AuthoringTier =
  | 'user_sent_originated'
  | 'user_sent_reply'
  | 'inbox_personal'
  | 'inbox_broadcast'
  | 'inbox_newsletter'
  | 'inbox_automated';

export type UserOverride = 'pinned' | 'hidden';

interface TierBonusTable {
  readonly user_sent_originated: number;
  readonly user_sent_reply: number;
  readonly inbox_personal: number;
  readonly inbox_broadcast: number;
  readonly inbox_newsletter: number;
  readonly inbox_automated: number;
}

// Calibration tables. Numbers chosen so the spread between the strongest
// promote (authored_originated) and zero is roughly the gap between
// adjacent ranks in the RRF curve at `rrfK=60`:
//
//   rank 1 →  0.0164
//   rank 2 →  0.0161  (diff ~0.0003)
//   rank 3 →  0.0159  (diff ~0.0002)
//   rank 10 → 0.0143  (diff ~0.0002)
//
// A bonus of +0.005 lifts a page roughly 30 ranks — enough to win a
// close call between rank-2-authored and rank-1-newsletter, but never
// enough to leapfrog a page that's an order of magnitude stronger on
// raw relevance (combined with the 0.85 floor-ratio gate in the RRF
// fold which prevents weak-overlap candidates from being eligible at
// all).
//
// **Why all received bonuses are 0.** The real-embedding ablation
// (PR #272 + Phase 1.1 re-run) showed that ANY negative bonus on
// received_content tiers — even soft demotes — pushes legitimate
// primary hits below distractors on queries that don't have an
// authored alternative. The product intent of Layer 2 is "prefer
// authored on close calls," not "suppress received." We get the
// preference by lifting authored alone; received stays at its raw
// rank.
const BONUSES_SPARSE: TierBonusTable = {
  user_sent_originated: 0.002,
  user_sent_reply: 0.001,
  inbox_personal: 0,
  inbox_broadcast: 0,
  inbox_newsletter: 0,
  inbox_automated: 0,
};

const BONUSES_NORMAL: TierBonusTable = {
  user_sent_originated: 0.005,
  user_sent_reply: 0.003,
  inbox_personal: 0,
  inbox_broadcast: 0,
  inbox_newsletter: 0,
  inbox_automated: 0,
};

const BONUSES_DENSE: TierBonusTable = {
  user_sent_originated: 0.008,
  user_sent_reply: 0.005,
  inbox_personal: 0,
  inbox_broadcast: 0,
  inbox_newsletter: 0,
  inbox_automated: 0,
};

const TABLES: Record<TierCalibration, TierBonusTable> = {
  sparse: BONUSES_SPARSE,
  normal: BONUSES_NORMAL,
  dense: BONUSES_DENSE,
};

/**
 * Pinned override boost. Added on top of the tier bonus; sized to put
 * a pinned page in front of unpinned authored content at the same raw
 * score. Roughly 2× the magnitude of the normal-band authored bonus.
 */
export const PINNED_BOOST = 0.012;

/**
 * Brief-reply downweighting threshold. An `authored_*` page whose body
 * is shorter than this many characters gets the `inbox_personal` bonus
 * (zero) instead of the full authored bonus — a one-line "k" reply
 * shouldn't tie-break above a 500-word strategy email just because
 * they're both `SENT`.
 */
export const BRIEF_BODY_THRESHOLD = 50;

/**
 * Sentinel returned by `tierBonus` when `userOverride === 'hidden'`.
 * The RRF fold checks for this exact value and drops the page entirely
 * (matching the previous multiplicative-zero semantics).
 */
export const HIDDEN_SENTINEL = Number.NEGATIVE_INFINITY;

/**
 * Compute the additive bonus for a single page from its metadata.
 *
 * Returns 0 (no contribution) when:
 *   - metadata is missing or not an object
 *   - `authoringTier` is missing, non-string, or unrecognized AND there
 *     is no userOverride to apply
 *
 * Returns `HIDDEN_SENTINEL` when `userOverride === 'hidden'`.
 */
export function tierBonus(metadata: unknown, calibration: TierCalibration): number {
  if (!metadata || typeof metadata !== 'object') return 0;
  const m = metadata as Record<string, unknown>;

  // userOverride: hidden short-circuits everything.
  const override = m['userOverride'];
  if (override === 'hidden') return HIDDEN_SENTINEL;
  const pinnedBoost = override === 'pinned' ? PINNED_BOOST : 0;

  const tier = m['authoringTier'];
  if (typeof tier !== 'string') return pinnedBoost;

  const table = TABLES[calibration];
  let base = (table as unknown as Record<string, number>)[tier];
  if (typeof base !== 'number') return pinnedBoost;

  // Brief-reply downweight: short authored body gets inbox_personal
  // bonus (zero) instead of full authored. Cheap heuristic — no need to
  // look at recipient tier or edit time yet.
  if (tier === 'user_sent_originated' || tier === 'user_sent_reply') {
    const bodyLen = m['bodyLen'];
    if (typeof bodyLen === 'number' && bodyLen < BRIEF_BODY_THRESHOLD) {
      base = table.inbox_personal;
    }
  }

  return base + pinnedBoost;
}

/**
 * Convenience builder for a tier-bonus callback closing over the
 * calibration band. The RRF fold accepts `(metadata) => number`; the
 * caller adds the returned value to the raw rrfScore (and special-cases
 * `HIDDEN_SENTINEL`).
 */
export function buildTierBonusFn(
  calibration: TierCalibration,
): (metadata: unknown) => number {
  return (metadata) => tierBonus(metadata, calibration);
}

// ── Back-compat aliases ─────────────────────────────────────────────────
//
// The pre-additive API names (`tierMultiplier`, `buildTierWeightFn`) are
// kept as deprecated re-exports so internal callers and external code
// importing the module don't break in the same PR that lands the
// rewrite. They forward to the additive implementation; downstream code
// will be migrated in a follow-up cleanup.
//
// New code should use `tierBonus` / `buildTierBonusFn`.

/** @deprecated Use `tierBonus` instead. */
export const tierMultiplier = tierBonus;

/** @deprecated Use `buildTierBonusFn` instead. */
export const buildTierWeightFn = buildTierBonusFn;

/**
 * Calibration thresholds. Inputs come from a count of
 * `metadata.authoringTier IN ('user_sent_*')` rows in last 90 days.
 */
export function calibrationFromSentVolume(sentVolume90d: number): TierCalibration {
  if (sentVolume90d < 100) return 'sparse';
  if (sentVolume90d > 1000) return 'dense';
  return 'normal';
}
