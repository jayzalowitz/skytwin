/**
 * DB-backed CostGatePort for the draft-email feature (#299).
 *
 * Combines two complementary checks, both atomic so they can't be
 * raced by concurrent signal ingests for the same user:
 *
 *   1. Per-user per-day call cap from `twin_profiles.drafts_daily_call_cap`
 *      via `draft_email_calls`. Coarse safety net independent of cost:
 *      caps the absolute number of LLM invocations regardless of how
 *      cheap each individual call is.
 *
 *   2. Per-user per-day spend cap from `AutonomySettings.maxDailySpendCents`
 *      via `spendRepository.checkAndRecordSpend`. CRITICAL: we
 *      atomically reserve the estimated spend in the same transaction
 *      as the limit check (CockroachDB serializable isolation makes
 *      this race-safe). Without the reservation, two concurrent draft
 *      generations for the same user could each pass the check
 *      against the same current total and collectively exceed the
 *      daily cap. Reservation is `spend_records.estimated_cost_cents`;
 *      `actual_cost_cents` is reconciled in `record()` (to 0 on LLM
 *      failure, left as-is on success).
 *
 * Both must pass for the gate to allow the call. Either-side over-cap
 * returns `{ allowed: false }` with the reason set to which gate
 * failed — useful for the cost dashboard and structured logs.
 *
 * Zero-cost calls (embedded / Ollama) skip the spend reservation
 * entirely — there's nothing to reserve, and the call-cap check
 * alone is the relevant guard.
 */

import { createLogger } from '@skytwin/core';
import {
  draftEmailCallsRepository,
  spendRepository,
  twinRepository,
  userRepository,
  type UserRow,
} from '@skytwin/db';
import type {
  CostGatePort,
  CostGateDecision,
  CostGateReservation,
} from '@skytwin/decision-engine';
import type { AutonomySettings } from '@skytwin/shared-types';

/**
 * Provider names that incur zero per-token cost. The gate uses this
 * to decide whether to reconcile a spend reservation back to 0 cents
 * when the actual provider (from `LlmResponse.provider`) turns out
 * to be local. Keep in sync with `apps/api/src/draft-email-setup.ts:
 * PROVIDER_COST_RANK` — both lists hard-code which providers are
 * effectively free in our model.
 */
const ZERO_COST_PROVIDERS = new Set(['embedded', 'ollama']);

const log = createLogger('api:cost-gate');

/**
 * Action-id encoding for the spend reservation. Uses a stable per-
 * decision string so the reconcile path in `record()` can find the
 * row by `action_id` and update `actual_cost_cents`. Includes a
 * `draft-email:` prefix so spend_records can be filtered by action
 * type later (when #306 lands a proper action-type column).
 */
function spendActionIdFor(decisionId: string): string {
  return `draft-email:${decisionId}`;
}

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

export function readAutonomy(user: UserRow | null): AutonomySettings {
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

export class DbCostGate implements CostGatePort {
  async check(input: {
    userId: string;
    decisionId: string;
    estimatedCostCents: number;
  }): Promise<CostGateDecision> {
    // Per-day call cap with atomic check+reserve. Replaces the
    // earlier COUNT-then-later-INSERT shape that Copilot caught as
    // racy: parallel ingests for the same user could each observe
    // `used < cap` and collectively overshoot. `checkAndReserveCall`
    // does COUNT and INSERT inside one CockroachDB serializable
    // transaction so concurrent ticks for the same user serialize
    // through the cap correctly.
    const cap = await twinRepository.getDraftsDailyCallCap(input.userId);
    const reserveResult = await draftEmailCallsRepository.checkAndReserveCall({
      userId: input.userId,
      decisionId: input.decisionId,
      provider: null, // filled in by `record()` once we know the actual provider
      estimatedCostCents: input.estimatedCostCents,
      cap,
    });
    if (!reserveResult.allowed) {
      const reason = `Daily draft-email call cap reached (${reserveResult.count}/${cap} in 24h).`;
      log.info('cost-gate refused: per-day call cap reached', {
        userId: input.userId,
        decisionId: input.decisionId,
        used: reserveResult.count,
        cap,
      });
      return { allowed: false, reason };
    }

    // Per-day spend cap with atomic reservation. Zero-cost calls
    // (embedded / Ollama estimate) skip the spend path entirely —
    // nothing to reserve. For cost-bearing calls, `checkAndRecordSpend`
    // atomically reads SUM(estimated_cost_cents) in the trailing
    // window, compares to the cap, and INSERTs a reservation row
    // — all inside one CockroachDB serializable transaction so
    // concurrent gate.check() calls for the same user can't both
    // pass the limit check against the same baseline.
    if (input.estimatedCostCents > 0) {
      const user = await userRepository.findById(input.userId);
      const autonomy = readAutonomy(user);
      const dailyLimit = autonomy.maxDailySpendCents;
      const result = await spendRepository.checkAndRecordSpend(
        {
          userId: input.userId,
          actionId: spendActionIdFor(input.decisionId),
          decisionId: input.decisionId,
          estimatedCostCents: input.estimatedCostCents,
        },
        dailyLimit,
      );
      if (!result.allowed) {
        log.info('cost-gate refused: per-day spend cap reached', {
          userId: input.userId,
          decisionId: input.decisionId,
          currentSpend: result.currentTotal,
          proposed: input.estimatedCostCents,
          limit: dailyLimit,
        });
        // The call-ledger reservation we made above stays in place
        // (counts against the per-day call cap). That's intentional:
        // a user repeatedly hitting their spend cap shouldn't get
        // unlimited retries before tripping the call cap too.
        return {
          allowed: false,
          reason:
            `Daily spend limit exceeded. Current daily spend: ${result.currentTotal} cents + ` +
            `proposed: ${input.estimatedCostCents} cents would exceed the ` +
            `${dailyLimit} cent daily limit.`,
        };
      }
    }

    const reservation: CostGateReservation = {
      callRecordId: reserveResult.record!.id,
    };
    return {
      allowed: true,
      reason: 'Within per-day call cap and spend cap.',
      reservation,
    };
  }

  async record(input: {
    userId: string;
    decisionId: string;
    estimatedCostCents: number;
    provider: string;
    succeeded: boolean;
    reservation?: CostGateReservation;
  }): Promise<void> {
    // 1) Update the pre-reserved call-ledger row with the ACTUAL
    //    provider and outcome. The reservation was inserted with
    //    `provider: null, succeeded: true` (optimistic); now we
    //    write what really happened.
    if (input.reservation?.callRecordId) {
      try {
        await draftEmailCallsRepository.updateOutcome({
          id: input.reservation.callRecordId,
          provider: input.provider,
          succeeded: input.succeeded,
        });
      } catch (err) {
        log.warn('Failed to update draft-email call-ledger outcome', {
          userId: input.userId,
          decisionId: input.decisionId,
          provider: input.provider,
          succeeded: input.succeeded,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Defensive fallback: if a caller invoked record() without a
      // reservation (which shouldn't happen on the wired path), still
      // insert a row so the per-day cap stays honest. Same fail-soft
      // policy as above.
      try {
        await draftEmailCallsRepository.record({
          userId: input.userId,
          decisionId: input.decisionId,
          estimatedCostCents: input.estimatedCostCents,
          provider: input.provider,
          succeeded: input.succeeded,
        });
      } catch (err) {
        log.warn('Failed to record draft-email call on ledger (no reservation)', {
          userId: input.userId,
          decisionId: input.decisionId,
          provider: input.provider,
          succeeded: input.succeeded,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2) Reconcile the spend reservation made in check().
    //    Three cases:
    //    - succeeded + local provider (embedded / ollama): reconcile
    //      to 0. The reservation was charged at the cloud-cost
    //      estimate, but the actual call was free. Without this
    //      reconcile a fallback-to-embedded path would silently
    //      consume the user's daily budget.
    //    - succeeded + cloud provider: leave the row at the estimate.
    //      The existing decision/action pipeline can refine
    //      actual_cost_cents later via a separate reconcile pass
    //      once the real provider response (tokens used, exact $)
    //      is in hand.
    //    - !succeeded: reconcile to 0. The reservation should not
    //      eat the user's daily budget when no LLM call actually
    //      completed. Without this, a flapping provider would
    //      decrement the daily budget on every retry.
    if (input.estimatedCostCents > 0) {
      const shouldReconcileToZero =
        !input.succeeded || ZERO_COST_PROVIDERS.has(input.provider);
      if (shouldReconcileToZero) {
        try {
          await spendRepository.reconcile(spendActionIdFor(input.decisionId), 0);
        } catch (err) {
          log.warn('Failed to reconcile draft-email spend reservation', {
            userId: input.userId,
            decisionId: input.decisionId,
            succeeded: input.succeeded,
            provider: input.provider,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
