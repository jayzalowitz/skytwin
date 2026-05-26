/**
 * Lock the PROMOTION_THRESHOLDS shape so the settings-page copy (#396)
 * can't drift from the policy-engine's source of truth.
 *
 * The frontend mirrors these values in
 * `apps/web/public/js/pages/settings.js` as `PROMOTION_TIER_INFO`. If a
 * refactor changes the consecutiveApprovals / minApprovalRatio /
 * minDurationInTierHours values for any tier, the settings UI will be
 * lying to users about what they need to do. This test fires on any
 * such drift.
 *
 * To update: change the table, change the constant in settings.js, and
 * update the expectations here in the same PR.
 */
import { describe, it, expect } from 'vitest';
import { PROMOTION_THRESHOLDS, TrustTier } from '@skytwin/shared-types';

describe('PROMOTION_THRESHOLDS — shape lock (#396)', () => {
  it('observer → suggest: 10 approvals, ≥0.8 ratio, ≥24h', () => {
    const t = PROMOTION_THRESHOLDS[TrustTier.OBSERVER];
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.consecutiveApprovals).toBe(10);
    expect(t.minApprovalRatio).toBe(0.8);
    expect(t.minDurationInTierHours).toBe(24);
    expect(t.nextTier).toBe(TrustTier.SUGGEST);
  });

  it('suggest → low_autonomy: 20 approvals, ≥0.85 ratio, ≥72h', () => {
    const t = PROMOTION_THRESHOLDS[TrustTier.SUGGEST];
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.consecutiveApprovals).toBe(20);
    expect(t.minApprovalRatio).toBe(0.85);
    expect(t.minDurationInTierHours).toBe(72);
    expect(t.nextTier).toBe(TrustTier.LOW_AUTONOMY);
  });

  it('low_autonomy → moderate_autonomy: 50 approvals, ≥0.9 ratio, ≥168h', () => {
    const t = PROMOTION_THRESHOLDS[TrustTier.LOW_AUTONOMY];
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.consecutiveApprovals).toBe(50);
    expect(t.minApprovalRatio).toBe(0.9);
    expect(t.minDurationInTierHours).toBe(168);
    expect(t.nextTier).toBe(TrustTier.MODERATE_AUTONOMY);
  });

  it('moderate_autonomy and high_autonomy have no automatic promotion entry', () => {
    expect(PROMOTION_THRESHOLDS[TrustTier.MODERATE_AUTONOMY]).toBeUndefined();
    expect(PROMOTION_THRESHOLDS[TrustTier.HIGH_AUTONOMY]).toBeUndefined();
  });
});
