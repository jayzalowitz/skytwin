import { TrustTier, PROMOTION_THRESHOLDS } from '@skytwin/shared-types';
import type { ApprovalStats, TierEvaluation } from '@skytwin/shared-types';
import type { LlmClient } from '@skytwin/llm-client';
import { runPrompt } from '@skytwin/policy-prompts';

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

function nextTier(current: TrustTier): TrustTier | undefined {
  const idx = tierIndex(current);
  return TIER_ORDER[idx + 1];
}

/** Result of the adaptive promotion judgment */
interface PromotionJudgment {
  shouldPromote: boolean;
  toTier?: TrustTier;
  reasoning: string;
  confidence: number;
}

/** Shape of the LLM-returned JSON for tier-promotion-judgment prompt */
interface TierPromotionLlmOutput {
  recommend_promote: boolean;
  confidence: number;
  reasoning: string;
}

/**
 * Deterministic fallback: check PROMOTION_THRESHOLDS directly.
 * This is the original v1 logic, kept verbatim so the system degrades
 * gracefully when no LLM client is configured.
 */
function deterministicPromotion(
  currentTier: TrustTier,
  stats: ApprovalStats,
): PromotionJudgment {
  if (currentTier === TrustTier.HIGH_AUTONOMY) {
    return {
      shouldPromote: false,
      reasoning: 'Already at highest trust tier.',
      confidence: 1,
    };
  }
  if (currentTier === TrustTier.MODERATE_AUTONOMY) {
    return {
      shouldPromote: false,
      reasoning:
        'Promotion to HIGH_AUTONOMY requires explicit user opt-in. ' +
        'Auto-promotion is not supported for this tier transition.',
      confidence: 1,
    };
  }

  const threshold = PROMOTION_THRESHOLDS[currentTier];
  if (!threshold) {
    return {
      shouldPromote: false,
      reasoning: `No promotion path defined for tier "${currentTier}".`,
      confidence: 1,
    };
  }

  if (stats.consecutiveApprovals < threshold.consecutiveApprovals) {
    return {
      shouldPromote: false,
      reasoning:
        `Need ${threshold.consecutiveApprovals} consecutive approvals for promotion, ` +
        `have ${stats.consecutiveApprovals}.`,
      confidence: 1,
    };
  }

  if (stats.approvalRatio < threshold.minApprovalRatio) {
    return {
      shouldPromote: false,
      reasoning:
        `Approval ratio ${(stats.approvalRatio * 100).toFixed(1)}% is below ` +
        `the ${(threshold.minApprovalRatio * 100).toFixed(1)}% threshold for promotion.`,
      confidence: 1,
    };
  }

  // Temporal floor (#373) — "consistent feedback over time." Twenty
  // approvals in twenty minutes is not the same evidence as twenty
  // approvals in two weeks; the count alone never demonstrated
  // calibration. `hoursInCurrentTier` comes from the latest
  // `trust_tier_audit` row (or user creation time when no audit row
  // exists). Callers that omit the field (older code paths, tests
  // without the audit table) skip the floor for backward compatibility
  // — production callers should always populate it.
  // Use Number.isFinite so a malformed trust_tier_audit row (clock
  // skew, mis-parsed timestamp yielding NaN/Infinity) cannot bypass
  // the floor — `typeof NaN === 'number'` would have let the check
  // through, and the reasoning string would have shown literal "NaN".
  // Clamp negatives to zero so the reasoning never shows a negative
  // hours-remaining if a caller passes a slightly-future timestamp.
  if (
    Number.isFinite(stats.hoursInCurrentTier) &&
    (stats.hoursInCurrentTier as number) < threshold.minDurationInTierHours
  ) {
    const hours = Math.max(0, stats.hoursInCurrentTier as number);
    const hoursRemaining = Math.ceil(threshold.minDurationInTierHours - hours);
    return {
      shouldPromote: false,
      reasoning:
        `Time-in-tier floor not met: have ${hours.toFixed(1)}h at ` +
        `${currentTier}, need ${threshold.minDurationInTierHours}h before promotion ` +
        `(roughly ${hoursRemaining}h to go).`,
      confidence: 1,
    };
  }

  return {
    shouldPromote: true,
    toTier: threshold.nextTier,
    reasoning:
      `Eligible for promotion: ${stats.consecutiveApprovals} consecutive approvals ` +
      `(threshold: ${threshold.consecutiveApprovals}) and ` +
      `${(stats.approvalRatio * 100).toFixed(1)}% approval ratio ` +
      `(threshold: ${(threshold.minApprovalRatio * 100).toFixed(1)}%)` +
      (Number.isFinite(stats.hoursInCurrentTier)
        ? ` after ${Math.max(0, stats.hoursInCurrentTier as number).toFixed(1)}h at ${currentTier} ` +
          `(time-in-tier floor: ${threshold.minDurationInTierHours}h).`
        : '.'),
    confidence: 1,
  };
}

/**
 * Adaptive promotion judgment using the tier-promotion-judgment prompt.
 * Falls back to deterministic logic on any failure or when no LLM client
 * is provided.
 *
 * Hard rails preserved:
 * - MODERATE_AUTONOMY → HIGH_AUTONOMY still requires explicit opt-in; the
 *   LLM path is disabled for that transition so the adaptive layer can never
 *   override it.
 * - toTier is always the next legal tier from PROMOTION_THRESHOLDS, never an
 *   arbitrary tier chosen by the model.
 */
async function judgePromotion(opts: {
  userId: string;
  serverId?: string;
  currentTier: TrustTier;
  approvalStats: ApprovalStats;
  riskProfileText?: string;
  llmClient?: LlmClient;
}): Promise<PromotionJudgment> {
  // Hard rail: MODERATE → HIGH always requires explicit opt-in.
  if (opts.currentTier === TrustTier.MODERATE_AUTONOMY || opts.currentTier === TrustTier.HIGH_AUTONOMY) {
    return deterministicPromotion(opts.currentTier, opts.approvalStats);
  }

  if (!opts.llmClient) {
    return deterministicPromotion(opts.currentTier, opts.approvalStats);
  }

  // Map our internal camelCase fields to the snake_case keys the prompt
  // template expects ({{current_tier}}, {{target_tier}}, {{risk_profile}},
  // {{feedback_history}}, {{decision_summary}}). Without this mapping the
  // template renders literal `{{current_tier}}` placeholders, the LLM
  // returns garbage, schema validation fails, and we silently fall back
  // to deterministic — meaning the adaptive judgment never actually ran.
  const next = nextTier(opts.currentTier);
  const stats = opts.approvalStats;
  const totalDecisions = stats.totalApprovals + stats.totalRejections;
  const decisionSummary =
    `${totalDecisions} total decisions, ${stats.approvalRatio.toFixed(2)} approval ratio, ` +
    `${stats.consecutiveApprovals} consecutive approvals`;
  const feedbackHistory =
    `recent rejections: ${stats.recentRejections}; ` +
    `total undos: ${stats.totalUndos}; ` +
    `critical undo present: ${stats.hasCriticalUndo}`;
  try {
    const result = await runPrompt<TierPromotionLlmOutput>({
      promptName: 'tier-promotion-judgment',
      inputs: {
        current_tier: opts.currentTier,
        target_tier: next ?? opts.currentTier,
        risk_profile: opts.riskProfileText ?? '',
        feedback_history: feedbackHistory,
        decision_summary: decisionSummary,
      },
      user: { userId: opts.userId },
      llmClient: opts.llmClient,
    });

    if (result.fellBackToDeterministic) {
      return deterministicPromotion(opts.currentTier, opts.approvalStats);
    }

    const output = result.output;

    return {
      shouldPromote: output.recommend_promote,
      toTier: output.recommend_promote ? next : undefined,
      reasoning: output.reasoning,
      confidence: output.confidence,
    };
  } catch {
    return deterministicPromotion(opts.currentTier, opts.approvalStats);
  }
}

/**
 * Pure logic engine for trust tier progression and regression.
 *
 * The engine evaluates approval statistics and returns a recommendation.
 * It does not perform any side effects (no DB writes, no tier updates).
 * The caller is responsible for applying the recommendation and recording
 * the audit trail.
 *
 * When `llmClient` is provided, promotion judgment goes through the
 * tier-promotion-judgment prompt (adaptive layer). Regression is always
 * deterministic — safety triggers must not be probabilistic.
 */
export class TrustTierEngine {
  private readonly llmClient?: LlmClient;

  constructor(opts: { llmClient?: LlmClient } = {}) {
    this.llmClient = opts.llmClient;
  }

  /**
   * Evaluate whether a user is eligible for tier promotion.
   *
   * HIGH_AUTONOMY is never reached by auto-promotion. Users must
   * explicitly opt in via the settings API.
   *
   * This method is synchronous for the deterministic path and async for
   * the adaptive path. All callers already handle TierEvaluation.
   */
  evaluateProgression(
    currentTier: TrustTier,
    stats: ApprovalStats,
  ): TierEvaluation {
    // Delegate to deterministic logic (synchronous callers use this directly)
    const judgment = deterministicPromotion(currentTier, stats);
    return this._judgmentToEvaluation(currentTier, judgment, stats);
  }

  /**
   * Async version of evaluateProgression that uses the adaptive LLM path
   * when an llmClient is configured.
   */
  async evaluateProgressionAsync(
    currentTier: TrustTier,
    stats: ApprovalStats,
    userId: string,
    riskProfileText?: string,
  ): Promise<TierEvaluation> {
    const judgment = await judgePromotion({
      userId,
      currentTier,
      approvalStats: stats,
      riskProfileText,
      llmClient: this.llmClient,
    });
    return this._judgmentToEvaluation(currentTier, judgment, stats);
  }

  private _judgmentToEvaluation(
    currentTier: TrustTier,
    judgment: PromotionJudgment,
    stats: ApprovalStats,
  ): TierEvaluation {
    if (!judgment.shouldPromote) {
      return {
        shouldChange: false,
        currentTier,
        reason: judgment.reasoning,
      };
    }

    const threshold = PROMOTION_THRESHOLDS[currentTier];
    const recommendedTier = judgment.toTier ?? threshold?.nextTier;

    return {
      shouldChange: true,
      currentTier,
      recommendedTier,
      direction: 'promotion',
      reason:
        judgment.reasoning ||
        `Eligible for promotion: ${stats.consecutiveApprovals} consecutive approvals ` +
        `and ${(stats.approvalRatio * 100).toFixed(1)}% approval ratio.`,
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
   * Regression is always deterministic — safety triggers must not be
   * probabilistic.
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

    // Trigger 1: Critical undo — drop to OBSERVER (maximum safety)
    if (stats.hasCriticalUndo) {
      return {
        shouldChange: true,
        currentTier,
        recommendedTier: TrustTier.OBSERVER,
        direction: 'regression',
        reason:
          'Critical undo detected. Demoting to OBSERVER as a safety measure. ' +
          'Trust must be rebuilt from the ground up after a critical incident.',
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

  /**
   * Async version of evaluate that uses the adaptive LLM path for promotion.
   * Regression is always deterministic.
   */
  async evaluateAsync(
    currentTier: TrustTier,
    stats: ApprovalStats,
    userId: string,
    riskProfileText?: string,
  ): Promise<TierEvaluation> {
    // Check regression first — safety takes priority and is always deterministic
    const regression = this.evaluateRegression(currentTier, stats);
    if (regression.shouldChange) {
      return regression;
    }

    // Then check progression (adaptive path when llmClient is set)
    return this.evaluateProgressionAsync(currentTier, stats, userId, riskProfileText);
  }
}
