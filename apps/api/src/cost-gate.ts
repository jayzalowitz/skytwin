/**
 * DB-backed CostGatePort for the draft-email feature (#299).
 *
 * Combines two complementary checks:
 *
 *   1. Per-user per-day call cap from `twin_profiles.drafts_daily_call_cap`
 *      via `draft_email_calls`. Coarse safety net independent of cost:
 *      caps the absolute number of LLM invocations regardless of how
 *      cheap each individual call is.
 *
 *   2. Per-user per-day spend cap from `AutonomySettings.maxDailySpendCents`
 *      via `SpendTracker.checkDailyLimit`. The spend cap is the real
 *      economic guard — embedded provider calls cost 0, so the call
 *      cap alone isn't enough to stop a cloud-provider spend spiral.
 *
 * Both must pass for the gate to allow the call. Either-side over-cap
 * returns `{ allowed: false }` with the reason set to which gate
 * failed — useful for the cost dashboard and structured logs.
 *
 * The `record()` side updates the call ledger ONLY. Spend records are
 * the responsibility of the existing decision/action pipeline (which
 * already inserts to `spend_records` via `spendRepository.create`); we
 * deliberately don't double-write to avoid the "draft generation
 * recorded twice" footgun.
 */

import { createLogger } from '@skytwin/core';
import {
  twinRepository,
  draftEmailCallsRepository,
  userRepository,
  type UserRow,
} from '@skytwin/db';
import { SpendTracker, type SpendRepositoryPort } from '@skytwin/policy-engine';
import type { CostGatePort, CostGateDecision } from '@skytwin/decision-engine';
import type { AutonomySettings } from '@skytwin/shared-types';

const log = createLogger('api:cost-gate');

/**
 * Default fallback AutonomySettings when a user row exists but
 * autonomy_settings is empty / malformed. Conservative — when in
 * doubt, the gate refuses calls rather than letting unbounded spend
 * through. 0 cents means "every cost-bearing call gets rejected" —
 * embedded (0-cost) calls still pass the spend check.
 */
const FALLBACK_AUTONOMY: AutonomySettings = {
  maxSpendPerActionCents: 0,
  maxDailySpendCents: 0,
  allowedDomains: [],
  blockedDomains: [],
  requireApprovalForIrreversible: true,
};

function readAutonomy(user: UserRow | null): AutonomySettings {
  const raw = user?.autonomy_settings;
  if (!raw || typeof raw !== 'object') return FALLBACK_AUTONOMY;
  const r = raw as Record<string, unknown>;
  const maxPerAction = typeof r['maxSpendPerActionCents'] === 'number'
    ? (r['maxSpendPerActionCents'] as number)
    : FALLBACK_AUTONOMY.maxSpendPerActionCents;
  const maxDaily = typeof r['maxDailySpendCents'] === 'number'
    ? (r['maxDailySpendCents'] as number)
    : FALLBACK_AUTONOMY.maxDailySpendCents;
  const requireApproval =
    typeof r['requireApprovalForIrreversible'] === 'boolean'
      ? (r['requireApprovalForIrreversible'] as boolean)
      : FALLBACK_AUTONOMY.requireApprovalForIrreversible;
  const allowedDomains = Array.isArray(r['allowedDomains'])
    ? (r['allowedDomains'] as string[])
    : FALLBACK_AUTONOMY.allowedDomains;
  const blockedDomains = Array.isArray(r['blockedDomains'])
    ? (r['blockedDomains'] as string[])
    : FALLBACK_AUTONOMY.blockedDomains;
  return {
    maxSpendPerActionCents: maxPerAction,
    maxDailySpendCents: maxDaily,
    allowedDomains,
    blockedDomains,
    requireApprovalForIrreversible: requireApproval,
    perAppOverrides:
      r['perAppOverrides'] && typeof r['perAppOverrides'] === 'object'
        ? (r['perAppOverrides'] as AutonomySettings['perAppOverrides'])
        : undefined,
  };
}

/**
 * Minimal spend-repo adapter so the gate can call SpendTracker without
 * coupling to the full spendRepository surface (which includes write
 * paths the gate doesn't need).
 */
function spendRepoAdapter(): SpendRepositoryPort {
  return {
    getDailyTotal: async (userId, windowHours) => {
      const { spendRepository } = await import('@skytwin/db');
      return spendRepository.getDailyTotal(userId, windowHours);
    },
    getMonthlyTotal: async (userId, appRegistryId) => {
      const { spendRepository } = await import('@skytwin/db');
      return spendRepository.getMonthlyTotal(userId, appRegistryId);
    },
    reconcile: async (actionId, actualCostCents) => {
      const { spendRepository } = await import('@skytwin/db');
      return spendRepository.reconcile(actionId, actualCostCents);
    },
  };
}

export class DbCostGate implements CostGatePort {
  private readonly spendTracker: SpendTracker;

  constructor(spendTracker?: SpendTracker) {
    this.spendTracker = spendTracker ?? new SpendTracker(spendRepoAdapter());
  }

  async check(input: {
    userId: string;
    decisionId: string;
    estimatedCostCents: number;
  }): Promise<CostGateDecision> {
    // Per-day call cap — cheap COUNT(*) on an indexed range. Run this
    // first so a noisy paid-provider configuration can't bypass the
    // call cap by being fast.
    const cap = await twinRepository.getDraftsDailyCallCap(input.userId);
    const used = await draftEmailCallsRepository.countInWindow(input.userId, 24);
    if (used >= cap) {
      const reason = `Daily draft-email call cap reached (${used}/${cap} in 24h).`;
      log.info('cost-gate refused: per-day call cap reached', {
        userId: input.userId,
        decisionId: input.decisionId,
        used,
        cap,
      });
      return { allowed: false, reason };
    }

    // Per-day spend cap. Zero-cost calls always pass this check
    // (SpendTracker special-cases proposedCostCents === 0). Cloud-
    // provider calls trigger the real spend ceiling.
    const user = await userRepository.findById(input.userId);
    const autonomy = readAutonomy(user);
    const spendCheck = await this.spendTracker.checkDailyLimit(
      input.userId,
      input.estimatedCostCents,
      autonomy,
    );
    if (!spendCheck.allowed) {
      log.info('cost-gate refused: per-day spend cap reached', {
        userId: input.userId,
        decisionId: input.decisionId,
        currentSpend: spendCheck.currentDailySpendCents,
        proposed: input.estimatedCostCents,
        limit: spendCheck.dailyLimitCents,
      });
      return { allowed: false, reason: spendCheck.reason };
    }

    return { allowed: true, reason: 'Within per-day call cap and spend cap.' };
  }

  async record(input: {
    userId: string;
    decisionId: string;
    estimatedCostCents: number;
    provider: string;
    succeeded: boolean;
  }): Promise<void> {
    try {
      await draftEmailCallsRepository.record({
        userId: input.userId,
        decisionId: input.decisionId,
        estimatedCostCents: input.estimatedCostCents,
        provider: input.provider,
        succeeded: input.succeeded,
      });
    } catch (err) {
      // A ledger-insert failure must not propagate to the caller —
      // the LLM call already happened. Log so we know the counter
      // is now stale, but don't fail the candidate.
      log.warn('Failed to record draft-email call on ledger', {
        userId: input.userId,
        decisionId: input.decisionId,
        provider: input.provider,
        succeeded: input.succeeded,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
