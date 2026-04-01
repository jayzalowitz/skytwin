import { TrustTier } from '@skytwin/shared-types';
import type { ApprovalStats, TierEvaluation } from '@skytwin/shared-types';

/**
 * Thresholds for tier promotion. Each tier requires a minimum number of
 * consecutive approvals and a minimum approval ratio to be eligible for
 * promotion to the next tier.
 */
const PROMOTION_THRESHOLDS: Record<
  string,
  { consecutiveApprovals: number; minApprovalRatio: number; nextTier: TrustTier }
> = {
  [TrustTier.OBSERVER]: {
    consecutiveApprovals: 10,
    minApprovalRatio: 0.8,
    nextTier: TrustTier.SUGGEST,
  },
  [TrustTier.SUGGEST]: {
    consecutiveApprovals: 20,
    minApprovalRatio: 0.85,
    nextTier: TrustTier.LOW_AUTONOMY,
  },
  [TrustTier.LOW_AUTONOMY]: {
    consecutiveApprovals: 50,
    minApprovalRatio: 0.9,
    nextTier: TrustTier.MODERATE_AUTONOMY,
  },
  // MODERATE_AUTONOMY → HIGH_AUTONOMY requires explicit opt-in.
  // There is no automatic promotion to HIGH_AUTONOMY.
};

/**
 * Regression triggers. If any condition is met, the user drops one tier.
 */
const REGRESSION_CONFIG = {
  /** Number of rejections in the rolling window that triggers regression */
  recentRejectionThreshold: 3,
  /** If rejection rate exceeds this in the rolling window, trigger regression */
  rejectionRatioThreshold: 0.3,
  /** Minimum total feedback events before ratio-based regression kicks in */
  minEventsForRatioCheck: 10,
};

/**
 * Ordered tiers from lowest to highest autonomy.
 */
const TIER_ORDER: TrustTier[] = [
  TrustTier.OBSERVER,
  TrustTier.SUGGEST,
  TrustTier.LOW_AUTONOMY,
  TrustTier.MODERATE_AUTONOMY,
  TrustTier.HIGH_AUTONOMY,
];

function tierIndex(tier: TrustTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * Pure logic engine for trust tier progression and regression.
 *
 * The engine evaluates approval statistics and returns a recommendation.
 * It does not perform any side effects (no DB writes, no tier updates).
 * The caller is responsible for applying the recommendation and recording
 * the audit trail.
 */
export class TrustTierEngine {
  /**
   * Evaluate whether a user is eligible for tier promotion.
   *
   * HIGH_AUTONOMY is never reached by auto-promotion. Users must
   * explicitly opt in via the settings API.
   */
  evaluateProgression(
    currentTier: TrustTier,
    stats: ApprovalStats,
  ): TierEvaluation {
    // HIGH_AUTONOMY users can't be promoted further
    if (currentTier === TrustTier.HIGH_AUTONOMY) {
      return {
        shouldChange: false,
        currentTier,
        reason: 'Already at highest trust tier.',
      };
    }

    // MODERATE_AUTONOMY → HIGH_AUTONOMY requires explicit opt-in
    if (currentTier === TrustTier.MODERATE_AUTONOMY) {
      return {
        shouldChange: false,
        currentTier,
        reason:
          'Promotion to HIGH_AUTONOMY requires explicit user opt-in. ' +
          'Auto-promotion is not supported for this tier transition.',
      };
    }

    const threshold = PROMOTION_THRESHOLDS[currentTier];
    if (!threshold) {
      return {
        shouldChange: false,
        currentTier,
        reason: `No promotion path defined for tier "${currentTier}".`,
      };
    }

    // Check consecutive approvals
    if (stats.consecutiveApprovals < threshold.consecutiveApprovals) {
      return {
        shouldChange: false,
        currentTier,
        reason:
          `Need ${threshold.consecutiveApprovals} consecutive approvals for promotion, ` +
          `have ${stats.consecutiveApprovals}.`,
      };
    }

    // Check approval ratio
    if (stats.approvalRatio < threshold.minApprovalRatio) {
      return {
        shouldChange: false,
        currentTier,
        reason:
          `Approval ratio ${(stats.approvalRatio * 100).toFixed(1)}% is below ` +
          `the ${(threshold.minApprovalRatio * 100).toFixed(1)}% threshold for promotion.`,
      };
    }

    return {
      shouldChange: true,
      currentTier,
      recommendedTier: threshold.nextTier,
      direction: 'promotion',
      reason:
        `Eligible for promotion: ${stats.consecutiveApprovals} consecutive approvals ` +
        `(threshold: ${threshold.consecutiveApprovals}) and ` +
        `${(stats.approvalRatio * 100).toFixed(1)}% approval ratio ` +
        `(threshold: ${(threshold.minApprovalRatio * 100).toFixed(1)}%).`,
    };
  }

  /**
   * Evaluate whether a user should be demoted one tier.
   *
   * Regression triggers:
   * 1. 3+ rejections in rolling 7-day window
   * 2. Any undo with severity 'critical'
   * 3. Rejection ratio > 30% with 10+ total events
   *
   * OBSERVER is the floor. Users cannot be demoted below it.
   */
  evaluateRegression(
    currentTier: TrustTier,
    stats: ApprovalStats,
  ): TierEvaluation {
    // Can't regress below OBSERVER
    if (currentTier === TrustTier.OBSERVER) {
      return {
        shouldChange: false,
        currentTier,
        reason: 'Already at lowest trust tier (OBSERVER). Cannot regress further.',
      };
    }

    const currentIndex = tierIndex(currentTier);
    const lowerTier = TIER_ORDER[currentIndex - 1]!;

    // Trigger 1: Critical undo
    if (stats.hasCriticalUndo) {
      return {
        shouldChange: true,
        currentTier,
        recommendedTier: lowerTier,
        direction: 'regression',
        reason:
          'Critical undo detected. Demoting one tier as a safety measure.',
      };
    }

    // Trigger 2: Recent rejection spike
    if (stats.recentRejections >= REGRESSION_CONFIG.recentRejectionThreshold) {
      return {
        shouldChange: true,
        currentTier,
        recommendedTier: lowerTier,
        direction: 'regression',
        reason:
          `${stats.recentRejections} rejections in rolling window ` +
          `(threshold: ${REGRESSION_CONFIG.recentRejectionThreshold}). Demoting one tier.`,
      };
    }

    // Trigger 3: High rejection ratio (only if enough data)
    const totalEvents = stats.totalApprovals + stats.totalRejections;
    if (totalEvents >= REGRESSION_CONFIG.minEventsForRatioCheck) {
      const rejectionRatio = 1 - stats.approvalRatio;
      if (rejectionRatio > REGRESSION_CONFIG.rejectionRatioThreshold) {
        return {
          shouldChange: true,
          currentTier,
          recommendedTier: lowerTier,
          direction: 'regression',
          reason:
            `Rejection ratio ${(rejectionRatio * 100).toFixed(1)}% exceeds ` +
            `${(REGRESSION_CONFIG.rejectionRatioThreshold * 100).toFixed(1)}% threshold ` +
            `with ${totalEvents} total events. Demoting one tier.`,
        };
      }
    }

    return {
      shouldChange: false,
      currentTier,
      reason: 'No regression triggers met. Tier is stable.',
    };
  }

  /**
   * Run both progression and regression checks. Regression takes priority
   * over progression (safety first).
   */
  evaluate(
    currentTier: TrustTier,
    stats: ApprovalStats,
  ): TierEvaluation {
    // Check regression first — safety takes priority
    const regression = this.evaluateRegression(currentTier, stats);
    if (regression.shouldChange) {
      return regression;
    }

    // Then check progression
    return this.evaluateProgression(currentTier, stats);
  }
}
