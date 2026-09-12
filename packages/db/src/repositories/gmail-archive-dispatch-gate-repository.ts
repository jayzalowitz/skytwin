import {
  joinedDecisionReceiptContentDigest,
  type GmailInboxMutationCommand,
  type GmailInboxMutationDispatchGate,
  type GmailInboxMutationDispatchGateResult,
  type JoinedDecisionReceiptContentV1,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type { ExecutionPlanRow, ExplanationRecordRow } from '../types.js';
import {
  canonicalGmailArchiveApprovalContent,
  canonicalGmailArchiveCandidateMessageRef,
  loadCanonicalGmailArchiveApprovalState,
} from './gmail-archive-approval-response-repository.js';
import { gmailArchiveAttemptState, snapshotGmailArchiveAttemptState } from './gmail-archive-attempt-state.js';
import {
  exactClaimedGmailArchiveReceipt,
  exactGmailArchiveBarrierIdentity,
} from './gmail-archive-claim-integrity.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GmailArchiveDispatchGateTransition = (
  client: PoolClient,
  command: Readonly<GmailInboxMutationCommand>,
) => Promise<GmailInboxMutationDispatchGateResult>;

type GmailArchiveDispatchGateTransaction = <T>(
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
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return null;
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

function snapshotCommand(value: unknown): Readonly<GmailInboxMutationCommand> | null {
  const command = ownData(value, ['admissionId', 'messageRefId', 'operation', 'userId']);
  if (!command || typeof command['userId'] !== 'string' || !UUID.test(command['userId']) ||
      typeof command['admissionId'] !== 'string' || !UUID.test(command['admissionId']) ||
      typeof command['messageRefId'] !== 'string' || !UUID.test(command['messageRefId']) ||
      command['operation'] !== 'archive') return null;
  return Object.freeze({
    userId: command['userId'],
    admissionId: command['admissionId'],
    messageRefId: command['messageRefId'],
    operation: 'archive',
  });
}

function exactApprovalResponse(value: unknown): boolean {
  const response = ownData(value, ['action', 'reason']);
  return response?.['action'] === 'approve' &&
    (response['reason'] === null || typeof response['reason'] === 'string');
}

async function transition(
  client: PoolClient,
  command: Readonly<GmailInboxMutationCommand>,
): Promise<GmailInboxMutationDispatchGateResult> {
  const barriers = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
      FOR UPDATE`,
    [command.admissionId, command.userId],
  )).rows;
  if (barriers.length !== 1 || !UUID.test(barriers[0]!.idempotency_key)) {
    return { status: 'not_admitted' };
  }
  const barrier = barriers[0]!;
  const authority = { userId: command.userId, approvalId: barrier.idempotency_key };
  const state = await loadCanonicalGmailArchiveApprovalState(client, {
    ...authority,
    action: 'approve',
  }, { allowExecutionPlan: true });
  if (!state || state.approval.status !== 'approved' || state.approval.responded_at === null ||
      state.approval.responded_at.getTime() > state.approval.expires_at.getTime() ||
      !exactApprovalResponse(state.approval.response)) return { status: 'not_admitted' };
  const approved = canonicalGmailArchiveApprovalContent(
    { ...state, revisions: state.revisions.slice(0, 4) },
    'approved',
  );
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (!approved || !messageRefId || messageRefId !== command.messageRefId ||
      !exactGmailArchiveBarrierIdentity(barrier, authority, state)) {
    return { status: 'conflict' };
  }
  if (barrier.status !== 'in_progress') return { status: 'not_admitted' };
  const attempt = snapshotGmailArchiveAttemptState(barrier.effect_result);
  if (!attempt || barrier.failure_reason !== null) return { status: 'conflict' };

  const plans = (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC FOR UPDATE',
    [state.decision.id],
  )).rows;
  const policyExplanation = barrier.explanation_id === null ? undefined :
    (await client.query<ExplanationRecordRow>(
      'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [barrier.explanation_id, state.decision.id],
    )).rows[0];
  const counts = plans.length === 1 ? await client.query<{ results: string; events: string }>(
    `SELECT
       (SELECT count(*) FROM execution_results WHERE plan_id = $1) AS results,
       (SELECT count(*) FROM execution_events WHERE plan_id = $1) AS events`,
    [plans[0]!.id],
  ) : null;
  if (plans.length !== 1 || state.outcome.execution_plan_id !== plans[0]!.id ||
      plans[0]!.action_id !== state.candidate.id || plans[0]!.status !== 'in_progress' ||
      !policyExplanation || counts?.rows[0]?.results !== '0' || counts.rows[0]?.events !== '0' ||
      state.revisions[3]?.content_digest !== joinedDecisionReceiptContentDigest(approved) ||
      !exactClaimedGmailArchiveReceipt(
        authority,
        state,
        { ...barrier, effect_result: {} },
        plans[0]!,
        policyExplanation,
        approved as JoinedDecisionReceiptContentV1,
      )) return { status: 'conflict' };
  if (attempt.phase === 'dispatch_may_have_started') return { status: 'not_admitted' };

  const entered = (await client.query<PreEffectBarrierRow>(
    `UPDATE pre_effect_barriers
        SET effect_result = $3::JSONB, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
        AND status = 'in_progress' AND idempotency_key = $4
        AND decision_id = $5 AND action_id = $6 AND explanation_id = $7
        AND effect_result = $8::JSONB AND failure_reason IS NULL
      RETURNING *`,
    [
      barrier.id,
      command.userId,
      JSON.stringify(gmailArchiveAttemptState('dispatch_may_have_started')),
      authority.approvalId,
      state.decision.id,
      state.candidate.id,
      barrier.explanation_id,
      JSON.stringify(gmailArchiveAttemptState('pre_dispatch')),
    ],
  )).rows[0];
  return entered ? { status: 'entered' } : { status: 'not_admitted' };
}

async function enterWithTransition(
  submitted: GmailInboxMutationCommand,
  transitionFn: GmailArchiveDispatchGateTransition,
  transactionFn: GmailArchiveDispatchGateTransaction = withTransaction,
): Promise<GmailInboxMutationDispatchGateResult> {
  const command = snapshotCommand(submitted);
  if (!command) return { status: 'conflict' };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transactionFn((client) => transitionFn(client, command));
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

export const gmailArchiveDispatchGateTestHooks = { enterWithTransition, transition };

export const gmailArchiveDispatchGateRepository: GmailInboxMutationDispatchGate = {
  async enter(command): Promise<GmailInboxMutationDispatchGateResult> {
    return enterWithTransition(command, transition);
  },
};
