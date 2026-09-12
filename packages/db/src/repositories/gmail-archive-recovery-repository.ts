import {
  type AbandonedGmailArchiveRecoveryQuery,
  type GmailInboxMutationCommand,
  type QueryAbandonedGmailArchiveInput,
  type QueryAbandonedGmailArchiveResult,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type { ExecutionPlanRow } from '../types.js';
import { canonicalGmailArchiveCandidateMessageRef } from './gmail-archive-approval-response-repository.js';
import { snapshotGmailArchiveAttemptState } from './gmail-archive-attempt-state.js';
import { validateStoredGmailArchiveTerminalGraph } from './gmail-archive-reconciliation-repository.js';
export { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from './gmail-archive-recovery-policy.js';
import { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from './gmail-archive-recovery-policy.js';
import {
  exactGmailArchiveApprovedPrefix,
  exactGmailArchiveInProgressBaseline,
  loadGmailArchivePolicyExplanation,
  loadGmailArchiveStableState,
} from './gmail-archive-terminalization-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GmailArchiveRecoveryTransition = (
  client: PoolClient,
  input: Readonly<QueryAbandonedGmailArchiveInput>,
) => Promise<QueryAbandonedGmailArchiveResult>;

type GmailArchiveRecoveryTransaction = <T>(
  callback: (client: PoolClient) => Promise<T>,
) => Promise<T>;

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length ||
        names.some((name, index) => name !== expected[index])) return null;
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function snapshotInput(value: unknown): Readonly<QueryAbandonedGmailArchiveInput> | null {
  const input = ownData(value, ['approvalId', 'userId']);
  if (!input || typeof input['approvalId'] !== 'string' || !UUID.test(input['approvalId']) ||
      typeof input['userId'] !== 'string' || !UUID.test(input['userId'])) return null;
  return Object.freeze({ approvalId: input['approvalId'], userId: input['userId'] });
}

function frozenCommand(input: Readonly<QueryAbandonedGmailArchiveInput>, admissionId: string, messageRefId: string) {
  return Object.freeze<GmailInboxMutationCommand>({
    userId: input.userId,
    admissionId,
    messageRefId,
    operation: 'archive',
  });
}

/** Internal transaction-scoped form reused by read-only recovery consumers. */
export async function queryAbandonedGmailArchiveInTransaction(
  client: PoolClient,
  input: Readonly<QueryAbandonedGmailArchiveInput>,
): Promise<QueryAbandonedGmailArchiveResult> {
  const barriers = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2`,
    [input.userId, input.approvalId],
  )).rows;
  if (barriers.length === 0) return { ok: false, error: 'not_found' };
  if (barriers.length !== 1) return { ok: false, error: 'integrity_conflict' };
  const barrier = barriers[0]!;

  const authority = Object.freeze({ userId: input.userId, approvalId: input.approvalId });
  const state = await loadGmailArchiveStableState(client, authority, false);
  if (!state) return { ok: false, error: 'integrity_conflict' };
  const approved = exactGmailArchiveApprovedPrefix(state);
  if (!approved) return { ok: false, error: 'integrity_conflict' };

  if (barrier.status === 'succeeded' || barrier.status === 'failed' || barrier.status === 'unknown') {
    const terminal = await validateStoredGmailArchiveTerminalGraph(
      client,
      authority,
      state,
      barrier,
      approved,
    );
    return terminal
      ? { ok: true, status: 'terminal', recovery: null }
      : { ok: false, error: 'integrity_conflict' };
  }
  if (barrier.status !== 'in_progress') return { ok: false, error: 'not_found' };

  const attempt = snapshotGmailArchiveAttemptState(barrier.effect_result);
  const legacyUntracked = !attempt && ownData(barrier.effect_result, []) !== null;
  if ((!attempt && !legacyUntracked) || barrier.failure_reason !== null ||
      state.revisions.length !== 6) return { ok: false, error: 'integrity_conflict' };

  const plans = (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC',
    [state.decision.id],
  )).rows;
  if (plans.length !== 1 || plans[0]!.status !== 'in_progress' ||
      plans[0]!.id !== state.outcome.execution_plan_id ||
      plans[0]!.action_id !== state.candidate.id) {
    return { ok: false, error: 'integrity_conflict' };
  }
  const plan = plans[0]!;
  const attempts = await client.query<{ results: string; events: string }>(
    `SELECT
       (SELECT count(*) FROM execution_results WHERE plan_id = $1) AS results,
       (SELECT count(*) FROM execution_events WHERE plan_id = $1) AS events`,
    [plan.id],
  );
  const policyExplanation = await loadGmailArchivePolicyExplanation(
    client,
    barrier,
    state.decision.id,
  );
  if (attempts.rows[0]?.results !== '0' || attempts.rows[0]?.events !== '0' ||
      !policyExplanation || !await exactGmailArchiveInProgressBaseline(
        client,
        authority,
        state,
        barrier,
        plan,
        policyExplanation,
        approved,
        false,
      )) return { ok: false, error: 'integrity_conflict' };

  if (!attempt) return { ok: false, error: 'legacy_untracked' };
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (!messageRefId || !UUID.test(messageRefId) || !UUID.test(barrier.id)) {
    return { ok: false, error: 'integrity_conflict' };
  }
  const phaseChangedAt = barrier.updated_at.toISOString();
  const due = (await client.query<{ due: boolean }>(
    `SELECT $1::TIMESTAMPTZ + ($2::INT * INTERVAL '1 second') <= now() AS due`,
    [phaseChangedAt, GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS],
  )).rows[0]?.due;
  if (due !== true) return { ok: true, status: 'not_due', recovery: null };

  return {
    ok: true,
    status: 'eligible',
    recovery: Object.freeze({
      command: frozenCommand(input, barrier.id, messageRefId),
      phase: attempt.phase,
      phaseChangedAt,
    }),
  };
}

async function queryWithTransition(
  submitted: QueryAbandonedGmailArchiveInput,
  transitionFn: GmailArchiveRecoveryTransition,
  transactionFn: GmailArchiveRecoveryTransaction = withTransaction,
): Promise<QueryAbandonedGmailArchiveResult> {
  const input = snapshotInput(submitted);
  if (!input) return { ok: false, error: 'invalid_input' };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transactionFn((client) => transitionFn(client, input));
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

/** Narrow seam for authority-snapshot and Cockroach retry tests. */
export const gmailArchiveRecoveryTestHooks = {
  queryWithTransition,
  transition: queryAbandonedGmailArchiveInTransaction,
};

export const gmailArchiveRecoveryRepository: AbandonedGmailArchiveRecoveryQuery = {
  async query(input): Promise<QueryAbandonedGmailArchiveResult> {
    return queryWithTransition(input, queryAbandonedGmailArchiveInTransaction);
  },
};
