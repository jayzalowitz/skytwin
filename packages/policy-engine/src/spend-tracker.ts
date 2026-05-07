import type { AutonomySettings, PerAppOverride } from '@skytwin/shared-types';

/**
 * Resolves the effective caps for a given action, given the user's
 * AutonomySettings and an optional per-app override (Capability
 * Acquisition Loop, #173).
 *
 * Per-app overrides may only narrow autonomy. The user-global cap is
 * always the upper bound; an override that requests a higher cap is
 * silently clamped down to the global value.
 */
export function resolveEffectiveCaps(
  settings: AutonomySettings,
  appRegistryId?: string,
): {
  maxSpendPerActionCents: number;
  maxDailySpendCents: number;
  requireApprovalForIrreversible: boolean;
  override?: PerAppOverride;
} {
  const override = appRegistryId ? settings.perAppOverrides?.[appRegistryId] : undefined;
  const maxPerAction = clampDown(
    settings.maxSpendPerActionCents,
    override?.maxSpendPerActionCents,
  );
  const maxDaily = clampDown(
    settings.maxDailySpendCents,
    override?.maxDailySpendCents,
  );
  // Require-approval is OR-ed: either the global flag or a stricter override turns it on.
  const requireApproval =
    settings.requireApprovalForIrreversible ||
    override?.requireApprovalForIrreversible === true;

  return {
    maxSpendPerActionCents: maxPerAction,
    maxDailySpendCents: maxDaily,
    requireApprovalForIrreversible: requireApproval,
    override,
  };
}

function clampDown(globalCap: number, overrideCap: number | undefined): number {
  if (overrideCap === undefined) return globalCap;
  // Override may only narrow — never widen.
  return Math.min(globalCap, overrideCap);
}

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
   *
   * @param appRegistryId Optional registry id (e.g. "@modelcontextprotocol/server-notion").
   *   When supplied, per-app overrides from `settings.perAppOverrides` are
   *   applied, narrowing the effective daily cap if the override is tighter.
   *   Per-app caps may never widen autonomy beyond the user-global cap.
   */
  async checkDailyLimit(
    userId: string,
    proposedCostCents: number,
    settings: AutonomySettings,
    windowHours: number = 24,
    appRegistryId?: string,
  ): Promise<SpendCheckResult> {
    const effectiveDaily = resolveEffectiveCaps(settings, appRegistryId).maxDailySpendCents;

    // Reject negative costs — these could bypass spend tracking
    if (proposedCostCents < 0) {
      return {
        allowed: false,
        currentDailySpendCents: 0,
        proposedActionCents: proposedCostCents,
        dailyLimitCents: effectiveDaily,
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
        dailyLimitCents: effectiveDaily,
        remainingCents: effectiveDaily,
        reason: 'Zero-cost action. No spend limit check needed.',
      };
    }

    const currentSpend = await this.repository.getDailyTotal(userId, windowHours);
    const totalAfterAction = currentSpend + proposedCostCents;
    const remaining = effectiveDaily - currentSpend;
    const appNote = appRegistryId ? ` (per-app cap for ${appRegistryId})` : '';

    if (totalAfterAction > effectiveDaily) {
      return {
        allowed: false,
        currentDailySpendCents: currentSpend,
        proposedActionCents: proposedCostCents,
        dailyLimitCents: effectiveDaily,
        remainingCents: Math.max(0, remaining),
        reason:
          `Daily spend limit exceeded${appNote}. Current daily spend: ${currentSpend} cents + ` +
          `proposed: ${proposedCostCents} cents = ${totalAfterAction} cents, ` +
          `which exceeds the ${effectiveDaily} cent daily limit. ` +
          `Remaining budget: ${Math.max(0, remaining)} cents.`,
      };
    }

    return {
      allowed: true,
      currentDailySpendCents: currentSpend,
      proposedActionCents: proposedCostCents,
      dailyLimitCents: effectiveDaily,
      remainingCents: remaining - proposedCostCents,
      reason:
        `Within daily limit${appNote}. ${totalAfterAction} of ${effectiveDaily} cents used after this action.`,
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
