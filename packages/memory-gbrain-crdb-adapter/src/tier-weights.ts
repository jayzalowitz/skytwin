/**
 * Authoring-tier retrieval multipliers (#251 Layer 2).
 *
 * The gbrain RRF fold applies these multiplicatively to a page's rrfScore
 * post-fold so that user-authored pages outrank received noise on
 * equal-text queries. Three calibration bands (sparse / normal / dense)
 * keep the multiplier honest for users at different writing volumes:
 *
 *   - sparse  (<100 user_sent_* pages in 90d): cap the spread; don't
 *     amplify a signal that isn't there.
 *   - normal:  the default band.
 *   - dense   (>1000 user_sent_* pages in 90d): use the wide spread so
 *     SNR difference compounds.
 *
 * Weights are placeholders until the labeled-relevant-doc eval in
 * `packages/memory-gbrain/src/__tests__/realistic-retrieval.test.ts`
 * confirms recall@5 improves. Layer 2 ships behind `brain_settings.
 * tier_weighting` (default false); do not enable in production until
 * the eval gate passes.
 *
 * `metadata.userOverride` composes orthogonally:
 *   - 'pinned'  → 2.0× multiplier (user explicitly told us this matters).
 *   - 'hidden'  → 0.0× (drop from results; user disclaimed it).
 *   - missing  → identity.
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

interface TierWeightTable {
  readonly user_sent_originated: number;
  readonly user_sent_reply: number;
  readonly inbox_personal: number;
  readonly inbox_broadcast: number;
  readonly inbox_newsletter: number;
  readonly inbox_automated: number;
}

const WEIGHTS_SPARSE: TierWeightTable = {
  user_sent_originated: 1.2,
  user_sent_reply: 1.1,
  inbox_personal: 1.0,
  inbox_broadcast: 0.9,
  inbox_newsletter: 0.5,
  inbox_automated: 0.5,
};

const WEIGHTS_NORMAL: TierWeightTable = {
  user_sent_originated: 1.5,
  user_sent_reply: 1.2,
  inbox_personal: 1.0,
  inbox_broadcast: 0.8,
  inbox_newsletter: 0.4,
  inbox_automated: 0.2,
};

const WEIGHTS_DENSE: TierWeightTable = {
  user_sent_originated: 2.0,
  user_sent_reply: 1.5,
  inbox_personal: 1.0,
  inbox_broadcast: 0.7,
  inbox_newsletter: 0.3,
  inbox_automated: 0.1,
};

const TABLES: Record<TierCalibration, TierWeightTable> = {
  sparse: WEIGHTS_SPARSE,
  normal: WEIGHTS_NORMAL,
  dense: WEIGHTS_DENSE,
};

/**
 * Brief-reply downweighting threshold. An `authored_*` page whose body is
 * shorter than this many characters gets the `inbox_personal` weight
 * instead of the full authored weight — a one-line "k" reply shouldn't
 * outrank a 500-word strategy email just because they're both `SENT`.
 */
export const BRIEF_BODY_THRESHOLD = 50;

/**
 * Compute the multiplier for a single page from its metadata.
 *
 * Returns 1.0 (identity) when:
 *   - metadata is missing or not an object
 *   - `authoringTier` is missing, non-string, or unrecognized
 *
 * Composes orthogonally with `userOverride` (pinned / hidden). The
 * caller is expected to multiply this into the existing rrfScore.
 */
export function tierMultiplier(
  metadata: unknown,
  calibration: TierCalibration,
): number {
  if (!metadata || typeof metadata !== 'object') return 1.0;
  const m = metadata as Record<string, unknown>;

  // userOverride wins if present — it's an explicit user signal.
  const override = m['userOverride'];
  if (override === 'hidden') return 0.0;
  const pinnedBoost = override === 'pinned' ? 2.0 : 1.0;

  const tier = m['authoringTier'];
  if (typeof tier !== 'string') return pinnedBoost;

  const table = TABLES[calibration];
  let base = (table as unknown as Record<string, number>)[tier];
  if (typeof base !== 'number') return pinnedBoost;

  // Brief-reply downweight: short authored body gets inbox_personal weight
  // instead of full authored. Cheap heuristic — no need to look at recipient
  // tier or edit time yet.
  if (tier === 'user_sent_originated' || tier === 'user_sent_reply') {
    const bodyLen = m['bodyLen'];
    if (typeof bodyLen === 'number' && bodyLen < BRIEF_BODY_THRESHOLD) {
      base = table.inbox_personal;
    }
  }

  return base * pinnedBoost;
}

/**
 * Convenience builder for a tier-weight callback closing over the
 * calibration band. The RRF fold accepts `(page) => number`.
 */
export function buildTierWeightFn(
  calibration: TierCalibration,
): (metadata: unknown) => number {
  return (metadata) => tierMultiplier(metadata, calibration);
}

/**
 * Calibration thresholds. Inputs come from a count of
 * `metadata.authoringTier IN ('user_sent_*')` rows in last 90 days.
 */
export function calibrationFromSentVolume(sentVolume90d: number): TierCalibration {
  if (sentVolume90d < 100) return 'sparse';
  if (sentVolume90d > 1000) return 'dense';
  return 'normal';
}
