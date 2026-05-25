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
  maxMonthlySpendCents: number | undefined;
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
  // Monthly cap: per-app override only (no user-global monthly cap in AutonomySettings).
  // Clamp-down-only semantics: if the override narrows below a hypothetical global,
  // the per-app value wins (per spec). Currently no global monthly cap, so we
  // simply surface the override value if present.
  const maxMonthlyCents = override?.maxMonthlySpendCents;
  // Require-approval is OR-ed: either the global flag or a stricter override turns it on.
  const requireApproval =
    baseSettings.requireApprovalForIrreversible ||
    override?.requireApprovalForIrreversible === true;

  return {
    maxSpendPerActionCents: maxPerAction,
    maxDailySpendCents: maxDaily,
    maxMonthlySpendCents: maxMonthlyCents,
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
  /**
   * Return total spend for a given user and optional app registry id over the
   * current calendar month (UTC). Used by checkMonthlyLimit.
   */
  getMonthlyTotal(userId: string, appRegistryId?: string): Promise<number>;
  reconcile(actionId: string, actualCostCents: number): Promise<unknown>;
  /**
   * Atomically check limit and record spend in one transaction.
   * Optional: if not provided, falls back to non-atomic check.
   */
  checkAndRecordSpend?(
    input: {
      userId: string;
      actionId: string;
      decisionId: string;
      estimatedCostCents: number;
      /**
       * Optional registry source attribution (#323). Passed through to
       * `spend_records.registry_id` so per-app monthly totals can
       * attribute the spend. Omit when the call has no known registry
       * source (e.g. raw LLM cost not tied to an MCP server).
       */
      registryId?: string;
    },
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
 * Result of a monthly spend limit check.
 */
export interface MonthlySpendCheckResult {
  allowed: boolean;
  currentMonthlySpendCents: number;
  proposedActionCents: number;
  monthlyLimitCents: number;
  remainingCents: number;
  reason: string;
}

/**
 * Summary of monthly spend vs cap for UI display.
 */
export interface MonthlySpendSummary {
  spentCents: number;
  /** null when no per-app monthly cap is configured. */
  capCents: number | null;
  /** 0–100 percentage, or null when no cap is configured. */
  percentUsed: number | null;
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

    // Zero-cost actions always pass — *provided the caller actually
    // knows the cost is zero*. SpendTracker doesn't see the originating
    // CandidateAction.costZeroIntent flag, so the gating for LLM-
    // generated zero ("the LLM said it costs nothing, but we never
    // verified") happens upstream in `PolicyEvaluator` — the
    // `costZeroIntent === 'unknown'` branch escalates to approval before
    // either `checkSpendLimit` or this `checkDailyLimit` runs (#372).
    // By the time a zero reaches `checkDailyLimit`, it is either a
    // verified-zero rule-based action or it was already escalated
    // upstream. Direct callers of `checkDailyLimit` must gate on
    // costZeroIntent themselves before invoking it.
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
   * Check if a proposed spend amount is within the per-app monthly limit.
   *
   * When appRegistryId is provided, the per-app monthly cap from
   * AutonomySettings.perAppOverrides is consulted.
   * If no monthly cap is configured for this app, the check always passes.
   *
   * Clamp-down semantics: the per-app cap may only be more restrictive
   * than the user-global cap (which currently does not include a monthly
   * field, so per-app is the sole source of monthly ceilings).
   */
  async checkMonthlyLimit(
    userId: string,
    proposedCostCents: number,
    settings: AutonomySettings,
    appRegistryId?: string,
  ): Promise<MonthlySpendCheckResult> {
    const caps = resolveEffectiveCaps(settings, appRegistryId);
    const monthlyLimitCents = caps.maxMonthlySpendCents;

    // No per-app monthly cap configured — always pass.
    if (monthlyLimitCents === undefined) {
      return {
        allowed: true,
        currentMonthlySpendCents: 0,
        proposedActionCents: proposedCostCents,
        monthlyLimitCents: 0,
        remainingCents: 0,
        reason: 'No monthly cap configured for this app.',
      };
    }

    if (proposedCostCents < 0) {
      return {
        allowed: false,
        currentMonthlySpendCents: 0,
        proposedActionCents: proposedCostCents,
        monthlyLimitCents,
        remainingCents: 0,
        reason: `Invalid negative cost (${proposedCostCents} cents). Actions cannot have negative costs.`,
      };
    }

    const currentSpend = await this.repository.getMonthlyTotal(userId, appRegistryId);
    const totalAfterAction = currentSpend + proposedCostCents;
    const remaining = monthlyLimitCents - currentSpend;
    const appNote = appRegistryId ? ` for ${appRegistryId}` : '';

    if (totalAfterAction > monthlyLimitCents) {
      return {
        allowed: false,
        currentMonthlySpendCents: currentSpend,
        proposedActionCents: proposedCostCents,
        monthlyLimitCents,
        remainingCents: Math.max(0, remaining),
        reason:
          `Monthly spend limit exceeded${appNote}. Current: ${currentSpend} cents + ` +
          `proposed: ${proposedCostCents} cents = ${totalAfterAction} cents, ` +
          `which exceeds the ${monthlyLimitCents} cent monthly limit. ` +
          `Remaining budget: ${Math.max(0, remaining)} cents.`,
      };
    }

    return {
      allowed: true,
      currentMonthlySpendCents: currentSpend,
      proposedActionCents: proposedCostCents,
      monthlyLimitCents,
      remainingCents: remaining - proposedCostCents,
      reason:
        `Within monthly limit${appNote}. ${totalAfterAction} of ${monthlyLimitCents} cents used after this action.`,
    };
  }

  /**
   * Return a monthly spend summary for the UI cost meter.
   *
   * When no per-app monthly cap is configured, capCents and percentUsed
   * are null — the UI should display "No monthly cap configured".
   */
  async getMonthlySpendForApp(
    userId: string,
    settings: AutonomySettings,
    appRegistryId: string,
  ): Promise<MonthlySpendSummary> {
    const caps = resolveEffectiveCaps(settings, appRegistryId);
    const capCents = caps.maxMonthlySpendCents ?? null;
    const spentCents = await this.repository.getMonthlyTotal(userId, appRegistryId);

    return {
      spentCents,
      capCents,
      percentUsed: capCents !== null && capCents > 0
        ? Math.min(100, Math.round((spentCents / capCents) * 100))
        : null,
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
