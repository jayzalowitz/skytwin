import type { AutonomySettings } from '@skytwin/shared-types';

/**
 * Port interface for spend record persistence.
 */
export interface SpendRepositoryPort {
  getDailyTotal(userId: string, windowHours?: number): Promise<number>;
  reconcile(actionId: string, actualCostCents: number): Promise<unknown>;
  /**
   * Atomically check limit and record spend in one transaction.
   * Optional: if not provided, falls back to non-atomic check.
   */
  checkAndRecordSpend?(
    input: { userId: string; actionId: string; decisionId: string; estimatedCostCents: number },
    dailyLimitCents: number,
    windowHours?: number,
  ): Promise<{ allowed: boolean; currentTotal: number; record: unknown | null }>;
}

/**
 * Result of a daily spend limit check.
 */
export interface SpendCheckResult {
  allowed: boolean;
  currentDailySpendCents: number;
  proposedActionCents: number;
  dailyLimitCents: number;
  remainingCents: number;
  reason: string;
}

/**
 * Result of spend reconciliation.
 */
export interface ReconciliationResult {
  actionId: string;
  estimatedCents: number;
  actualCents: number;
  varianceCents: number;
  variancePercent: number;
  overEstimated: boolean;
}

/**
 * Spend tracking engine for daily spend limit enforcement.
 *
 * Checks whether a proposed action's cost, combined with existing
 * daily spend, would exceed the user's daily limit. Also handles
 * reconciliation of estimated vs actual costs.
 */
export class SpendTracker {
  constructor(private readonly repository: SpendRepositoryPort) {}

  /**
   * Check if a proposed spend amount is within the user's daily limit.
   */
  async checkDailyLimit(
    userId: string,
    proposedCostCents: number,
    settings: AutonomySettings,
    windowHours: number = 24,
  ): Promise<SpendCheckResult> {
    // Reject negative costs — these could bypass spend tracking
    if (proposedCostCents < 0) {
      return {
        allowed: false,
        currentDailySpendCents: 0,
        proposedActionCents: proposedCostCents,
        dailyLimitCents: settings.maxDailySpendCents,
        remainingCents: 0,
        reason: `Invalid negative cost (${proposedCostCents} cents). Actions cannot have negative costs.`,
      };
    }

    // Zero-cost actions always pass
    if (proposedCostCents === 0) {
      return {
        allowed: true,
        currentDailySpendCents: 0,
        proposedActionCents: 0,
        dailyLimitCents: settings.maxDailySpendCents,
        remainingCents: settings.maxDailySpendCents,
        reason: 'Zero-cost action. No spend limit check needed.',
      };
    }

    const currentSpend = await this.repository.getDailyTotal(userId, windowHours);
    const totalAfterAction = currentSpend + proposedCostCents;
    const remaining = settings.maxDailySpendCents - currentSpend;

    if (totalAfterAction > settings.maxDailySpendCents) {
      return {
        allowed: false,
        currentDailySpendCents: currentSpend,
        proposedActionCents: proposedCostCents,
        dailyLimitCents: settings.maxDailySpendCents,
        remainingCents: Math.max(0, remaining),
        reason:
          `Daily spend limit exceeded. Current daily spend: ${currentSpend} cents + ` +
          `proposed: ${proposedCostCents} cents = ${totalAfterAction} cents, ` +
          `which exceeds the ${settings.maxDailySpendCents} cent daily limit. ` +
          `Remaining budget: ${Math.max(0, remaining)} cents.`,
      };
    }

    return {
      allowed: true,
      currentDailySpendCents: currentSpend,
      proposedActionCents: proposedCostCents,
      dailyLimitCents: settings.maxDailySpendCents,
      remainingCents: remaining - proposedCostCents,
      reason:
        `Within daily limit. ${totalAfterAction} of ${settings.maxDailySpendCents} cents used after this action.`,
    };
  }

  /**
   * Reconcile an action's estimated cost with the actual cost.
   * Returns variance information.
   */
  async reconcile(
    actionId: string,
    estimatedCents: number,
    actualCents: number,
  ): Promise<ReconciliationResult> {
    await this.repository.reconcile(actionId, actualCents);

    const varianceCents = actualCents - estimatedCents;
    const variancePercent = estimatedCents > 0
      ? (varianceCents / estimatedCents) * 100
      : 0;

    return {
      actionId,
      estimatedCents,
      actualCents,
      varianceCents,
      variancePercent,
      overEstimated: varianceCents < 0,
    };
  }
}
