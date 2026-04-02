import type { CandidateAction, RiskAssessment } from '@skytwin/shared-types';
import { RiskTier, ConfidenceLevel } from '@skytwin/shared-types';

/**
 * A configurable escalation trigger.
 */
export interface EscalationTrigger {
  id: string;
  triggerType: EscalationTriggerType;
  conditions: Record<string, unknown>;
  enabled: boolean;
}

export type EscalationTriggerType =
  | 'amount_threshold'
  | 'risk_tier_threshold'
  | 'low_confidence'
  | 'novel_situation'
  | 'consecutive_rejections';

/**
 * Result of evaluating escalation triggers for a decision.
 */
export interface EscalationResult {
  shouldEscalate: boolean;
  reasons: string[];
  triggeredBy: string[];
}

/**
 * Context needed to evaluate escalation triggers.
 */
export interface EscalationContext {
  action: CandidateAction;
  riskAssessment: RiskAssessment;
  matchingPreferenceCount: number;
  consecutiveRejections: number;
}

/**
 * Rank mapping for risk tiers and confidence levels.
 */
const RISK_RANK: Record<string, number> = {
  [RiskTier.NEGLIGIBLE]: 0,
  [RiskTier.LOW]: 1,
  [RiskTier.MODERATE]: 2,
  [RiskTier.HIGH]: 3,
  [RiskTier.CRITICAL]: 4,
};

const CONFIDENCE_RANK: Record<string, number> = {
  [ConfidenceLevel.SPECULATIVE]: 0,
  [ConfidenceLevel.LOW]: 1,
  [ConfidenceLevel.MODERATE]: 2,
  [ConfidenceLevel.HIGH]: 3,
  [ConfidenceLevel.CONFIRMED]: 4,
};

/**
 * Escalation trigger evaluation engine.
 *
 * Evaluates a set of configurable triggers against a decision context.
 * Each trigger has a type and conditions. If any enabled trigger fires,
 * the decision should be escalated for user approval.
 *
 * Built-in trigger types:
 * - amount_threshold: Escalate when estimatedCostCents >= threshold
 * - risk_tier_threshold: Escalate when risk tier >= threshold
 * - low_confidence: Escalate when action confidence is below threshold
 * - novel_situation: Escalate when no matching preferences found
 * - consecutive_rejections: Escalate after N consecutive rejections in domain
 */
export class EscalationTriggerEngine {
  /**
   * Evaluate all triggers against the decision context.
   */
  evaluate(
    triggers: EscalationTrigger[],
    context: EscalationContext,
  ): EscalationResult {
    const reasons: string[] = [];
    const triggeredBy: string[] = [];

    for (const trigger of triggers) {
      if (!trigger.enabled) continue;

      const fired = this.evaluateTrigger(trigger, context);
      if (fired) {
        reasons.push(fired);
        triggeredBy.push(trigger.id);
      }
    }

    return {
      shouldEscalate: reasons.length > 0,
      reasons,
      triggeredBy,
    };
  }

  private evaluateTrigger(
    trigger: EscalationTrigger,
    context: EscalationContext,
  ): string | null {
    switch (trigger.triggerType) {
      case 'amount_threshold':
        return this.checkAmountThreshold(trigger, context);
      case 'risk_tier_threshold':
        return this.checkRiskTierThreshold(trigger, context);
      case 'low_confidence':
        return this.checkLowConfidence(trigger, context);
      case 'novel_situation':
        return this.checkNovelSituation(context);
      case 'consecutive_rejections':
        return this.checkConsecutiveRejections(trigger, context);
      default:
        // Fail-closed: unknown trigger types escalate rather than silently pass
        return `Unknown escalation trigger type "${trigger.triggerType}". Escalating as a safety precaution.`;
    }
  }

  private checkAmountThreshold(
    trigger: EscalationTrigger,
    context: EscalationContext,
  ): string | null {
    const threshold = trigger.conditions['thresholdCents'] as number | undefined;
    if (threshold === undefined) return null;

    if (context.action.estimatedCostCents >= threshold) {
      return `Action cost (${context.action.estimatedCostCents} cents) meets or exceeds escalation threshold (${threshold} cents).`;
    }
    return null;
  }

  private checkRiskTierThreshold(
    trigger: EscalationTrigger,
    context: EscalationContext,
  ): string | null {
    const threshold = trigger.conditions['minRiskTier'] as string | undefined;
    if (!threshold) return null;

    const riskRank = RISK_RANK[context.riskAssessment.overallTier] ?? 0;
    const thresholdRank = RISK_RANK[threshold] ?? 0;

    if (riskRank >= thresholdRank) {
      return `Risk tier (${context.riskAssessment.overallTier}) meets or exceeds escalation threshold (${threshold}).`;
    }
    return null;
  }

  private checkLowConfidence(
    trigger: EscalationTrigger,
    context: EscalationContext,
  ): string | null {
    const minConfidence = trigger.conditions['minConfidence'] as string | undefined;
    if (!minConfidence) return null;

    const actionRank = CONFIDENCE_RANK[context.action.confidence] ?? 0;
    const thresholdRank = CONFIDENCE_RANK[minConfidence] ?? 0;

    if (actionRank < thresholdRank) {
      return `Action confidence (${context.action.confidence}) is below escalation threshold (${minConfidence}).`;
    }
    return null;
  }

  private checkNovelSituation(
    context: EscalationContext,
  ): string | null {
    if (context.matchingPreferenceCount === 0) {
      return 'No matching preferences found for this situation. Escalating as novel.';
    }
    return null;
  }

  private checkConsecutiveRejections(
    trigger: EscalationTrigger,
    context: EscalationContext,
  ): string | null {
    const threshold = trigger.conditions['count'] as number | undefined;
    if (threshold === undefined) return null;

    if (context.consecutiveRejections >= threshold) {
      return `${context.consecutiveRejections} consecutive rejections in this domain (threshold: ${threshold}). Escalating for review.`;
    }
    return null;
  }
}
