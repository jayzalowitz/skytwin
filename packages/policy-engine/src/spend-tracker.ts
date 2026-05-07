import type { AutonomySettings, PerAppOverride } from '@skytwin/shared-types';

/**
 * Apply interpreted_caps as a clamp-down on top of user-global settings.
 *
 * interpreted_caps (derived from the user's free-form risk profile, #190) may
 * only NARROW autonomy below the user-global value. Fields that would widen
 * autonomy beyond the global cap are silently discarded.
 *
 * Hard rails (e.g. requireApprovalForIrreversible=true globally) are never
 * relaxed by interpreted_caps — this function OR-combines boolean flags.
 *
 * @internal Used by resolveEffectiveCaps. Not exported separately.
 */
function applyInterpretedCaps(
  settings: AutonomySettings,
  interpretedCaps: Partial<AutonomySettings>,
): AutonomySettings {
  return {
    ...settings,
    maxSpendPerActionCents: clampDown(
      settings.maxSpendPerActionCents,
      interpretedCaps.maxSpendPerActionCents,
    ),
    maxDailySpendCents: clampDown(
      settings.maxDailySpendCents,
      interpretedCaps.maxDailySpendCents,
    ),
    // requireApprovalForIrreversible is OR-ed: interpreted_caps can only tighten.
    requireApprovalForIrreversible:
      settings.requireApprovalForIrreversible ||
      interpretedCaps.requireApprovalForIrreversible === true,
  };
}

/**
 * Resolves the effective caps for a given action, given the user's
 * AutonomySettings, an optional per-app override (Capability
 * Acquisition Loop, #173), and an optional interpreted_caps projection
 * from the user's risk profile (#190).
 *
 * Resolution order (each layer may only narrow, never widen):
 *   1. user-global AutonomySettings (upper bound / hard ceiling)
 *   2. interpretedCaps — LLM-interpreted risk profile projection (#190)
 *   3. per-app override — further narrows for a specific app
 *
 * Any cap that tries to widen beyond the user-global ceiling is silently
 * clamped. Hard rails are not subject to this: a global
 * requireApprovalForIrreversible=true cannot be relaxed by any layer.
 */
export function resolveEffectiveCaps(
  settings: AutonomySettings,
  appRegistryId?: string,
  interpretedCaps?: Partial<AutonomySettings>,
): {
  maxSpendPerActionCents: number;
  maxDailySpendCents: number;
  requireApprovalForIrreversible: boolean;
  override?: PerAppOverride;
} {
  // Layer 2: apply interpreted_caps on top of global settings (narrows only).
  const baseSettings = interpretedCaps
    ? applyInterpretedCaps(settings, interpretedCaps)
    : settings;

  // Layer 3: apply per-app override on top of the (possibly narrowed) base.
  const override = appRegistryId ? baseSettings.perAppOverrides?.[appRegistryId] : undefined;
  const maxPerAction = clampDown(
    baseSettings.maxSpendPerActionCents,
    override?.maxSpendPerActionCents,
  );
  const maxDaily = clampDown(
    baseSettings.maxDailySpendCents,
    override?.maxDailySpendCents,
  );
  // Require-approval is OR-ed: either the global flag or a stricter override turns it on.
  const requireApproval =
    baseSettings.requireApprovalForIrreversible ||
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
   * @param interpretedCaps Optional structured projection of the user's risk profile (#190).
   *   When supplied, this narrows the effective caps below the user-global value before
   *   per-app overrides are applied. May only narrow — never widen.
   */
  async checkDailyLimit(
    userId: string,
    proposedCostCents: number,
    settings: AutonomySettings,
    windowHours: number = 24,
    appRegistryId?: string,
    interpretedCaps?: Partial<AutonomySettings>,
  ): Promise<SpendCheckResult> {
    const effectiveDaily = resolveEffectiveCaps(settings, appRegistryId, interpretedCaps).maxDailySpendCents;

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
