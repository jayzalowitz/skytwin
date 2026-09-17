import {
  PolicyEvaluator,
  type PolicyDecision,
} from '@skytwin/policy-engine';
import {
  TrustTier,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  parseAutonomySettings,
  type CandidateAction,
  type GmailInboxMutationCommand,
  type JoinedDecisionReceiptContentV1,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type {
  ActionPolicyRow,
  ExecutionPlanRow,
  ExplanationRecordRow,
  UserRow,
} from '../types.js';
import {
  canonicalGmailArchiveApprovalContent,
  loadCanonicalGmailArchiveApprovalState,
  type GmailArchiveApprovalCanonicalState,
} from './gmail-archive-approval-response-repository.js';
import { gmailArchiveAttemptState, snapshotGmailArchiveAttemptState } from './gmail-archive-attempt-state.js';
import {
  buildGmailArchivePostApprovalPolicySnapshot,
  canonicalGmailArchiveCandidate,
  canonicalGmailArchivePlanSteps,
  canonicalStoredGmailArchiveRisk,
  createGmailArchiveTransactionPolicyPort,
  loadGmailArchivePreparationReplay,
} from './gmail-archive-preparation-repository.js';
import {
  exactClaimedGmailArchiveReceipt,
  exactGmailArchiveBarrierIdentity,
} from './gmail-archive-claim-integrity.js';
import { validateStoredGmailArchiveTerminalGraph } from './gmail-archive-reconciliation-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export interface ClaimPreparedGmailArchiveInput {
  userId: string;
  approvalId: string;
}

export type ClaimPreparedGmailArchiveResult =
  | {
      ok: true;
      claimed: true;
      command: Readonly<GmailInboxMutationCommand>;
    }
  | {
      ok: true;
      claimed: false;
      state: 'not_ready' | 'in_progress' | 'terminal';
      command: null;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'not_found' | 'policy_stale' | 'idempotency_conflict';
    };

export type GmailArchiveClaimTransition = (
  client: PoolClient,
  input: Readonly<ClaimPreparedGmailArchiveInput>,
) => Promise<ClaimPreparedGmailArchiveResult>;

class RollbackResult extends Error {
  constructor(readonly result: ClaimPreparedGmailArchiveResult) {
    super('Gmail archive claim rolled back');
  }
}

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

function snapshotInput(value: unknown): Readonly<ClaimPreparedGmailArchiveInput> | null {
  const input = ownData(value, ['approvalId', 'userId']);
  if (!input || typeof input['approvalId'] !== 'string' || !UUID.test(input['approvalId']) ||
      typeof input['userId'] !== 'string' || !UUID.test(input['userId'])) return null;
  return Object.freeze({ approvalId: input['approvalId'], userId: input['userId'] });
}

function exactApprovalResponse(value: unknown): boolean {
  const response = ownData(value, ['action', 'reason']);
  return response?.['action'] === 'approve' &&
    (response['reason'] === null || typeof response['reason'] === 'string');
}

async function loadPlans(client: PoolClient, decisionId: string): Promise<ExecutionPlanRow[]> {
  return (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC FOR UPDATE',
    [decisionId],
  )).rows;
}

async function hasExecutionAttempt(client: PoolClient, planId: string): Promise<boolean> {
  const counts = await client.query<{ results: string; events: string }>(
    `SELECT
       (SELECT count(*) FROM execution_results WHERE plan_id = $1) AS results,
       (SELECT count(*) FROM execution_events WHERE plan_id = $1) AS events`,
    [planId],
  );
  return counts.rows[0]?.results !== '0' || counts.rows[0]?.events !== '0';
}

async function classifyNonPrepared(
  client: PoolClient,
  input: ClaimPreparedGmailArchiveInput,
  state: GmailArchiveApprovalCanonicalState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
): Promise<ClaimPreparedGmailArchiveResult> {
  if (barrier.status === 'reserved') {
    const plans = await loadPlans(client, state.decision.id);
    if (barrier.decision_id !== null || barrier.action_id !== null || barrier.explanation_id !== null ||
        ownData(barrier.policy_snapshot, []) === null || ownData(barrier.effect_result, []) === null ||
        barrier.failure_reason !== null || state.outcome.execution_plan_id !== null || plans.length !== 0 ||
        state.revisions.length !== 4 ||
        state.revisions[3]?.content_digest !== joinedDecisionReceiptContentDigest(approved)) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    return { ok: true, claimed: false, state: 'not_ready', command: null };
  }
  if (barrier.status === 'blocked') {
    if (!exactGmailArchiveBarrierIdentity(barrier, input, state)) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    const replay = await loadGmailArchivePreparationReplay(client, input, state, barrier, approved);
    if (!replay.ok || replay.preparation.status !== 'blocked' || replay.preparation.plan !== null) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    return { ok: true, claimed: false, state: 'terminal', command: null };
  }
  if (['succeeded', 'failed', 'unknown'].includes(barrier.status)) {
    const terminal = await validateStoredGmailArchiveTerminalGraph(
      client,
      input,
      {
        ...state,
        proposalExplanation: state.explanation,
      },
      barrier,
      approved,
    );
    return terminal
      ? { ok: true, claimed: false, state: 'terminal', command: null }
      : { ok: false, error: 'idempotency_conflict' };
  }
  if (barrier.status !== 'in_progress' || !exactGmailArchiveBarrierIdentity(barrier, input, state)) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const plans = await loadPlans(client, state.decision.id);
  const policyExplanation = barrier.explanation_id === null ? undefined :
    (await client.query<ExplanationRecordRow>(
      'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [barrier.explanation_id, state.decision.id],
    )).rows[0];
  const attempt = snapshotGmailArchiveAttemptState(barrier.effect_result);
  if (!attempt || plans.length !== 1 || state.outcome.execution_plan_id !== plans[0]!.id ||
      plans[0]!.action_id !== state.candidate.id || plans[0]!.status !== 'in_progress' ||
      !policyExplanation ||
      !exactClaimedGmailArchiveReceipt(
        input, state, { ...barrier, effect_result: {} }, plans[0]!, policyExplanation, approved,
      ) ||
      await hasExecutionAttempt(client, plans[0]!.id)) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  return { ok: true, claimed: false, state: 'in_progress', command: null };
}

async function currentPolicyDecision(
  client: PoolClient,
  input: ClaimPreparedGmailArchiveInput,
  state: GmailArchiveApprovalCanonicalState,
): Promise<{
  decision: PolicyDecision;
  snapshot: Record<string, unknown>;
} | null> {
  const candidate = canonicalGmailArchiveCandidate(state);
  const risk = canonicalStoredGmailArchiveRisk(state.candidate.risk_assessment);
  if (!candidate || !risk) return null;
  const eligible = await client.query<{ count: string }>(
    `SELECT count(*)::STRING AS count
       FROM signals AS signal
       JOIN gmail_message_refs AS ref
         ON ref.id = signal.resource_ref_id
        AND ref.user_id = signal.user_id
        AND ref.connector_account_id = signal.connector_account_id
        AND ref.source_signal_id = signal.source_signal_id
       JOIN connected_accounts AS account
         ON account.id = ref.connector_account_id
        AND account.user_id = ref.user_id
        AND account.provider = ref.provider
       JOIN oauth_tokens AS token
         ON token.connector_account_id = account.id
        AND token.user_id = account.user_id
        AND token.provider = account.provider
      WHERE signal.id = $2 AND signal.user_id = $1 AND signal.source = 'gmail'
        AND ref.id = $3 AND ref.provider = 'google' AND ref.last_observed_inbox = true
        AND account.is_active = true AND account.identity_verified = true
        AND $4::STRING = ANY(account.scopes) AND $4::STRING = ANY(token.scopes)`,
    [input.userId, state.signal.id, candidate.parameters['messageRefId'], GMAIL_MODIFY_SCOPE],
  );
  if (eligible.rows[0]?.count !== '1') return null;
  const user = (await client.query<UserRow>(
    'SELECT * FROM users WHERE id = $1 FOR UPDATE',
    [input.userId],
  )).rows[0];
  if (!user) return null;
  const policyRows = (await client.query<ActionPolicyRow>(
    'SELECT * FROM action_policies WHERE user_id = $1 ORDER BY priority DESC, id ASC FOR UPDATE',
    [input.userId],
  )).rows;
  const policyPort = createGmailArchiveTransactionPolicyPort(input.userId, policyRows);
  const evaluator = new PolicyEvaluator(policyPort);
  const decision = await evaluator.evaluate(
    candidate,
    await policyPort.getAllPolicies(input.userId),
    user.trust_tier as TrustTier,
    risk,
    parseAutonomySettings(user.autonomy_settings),
  );
  return {
    decision,
    snapshot: buildGmailArchivePostApprovalPolicySnapshot({
      state,
      candidate,
      risk,
      user,
      policyRows,
      decision,
      evaluator,
    }),
  };
}

function fail(result: ClaimPreparedGmailArchiveResult): never {
  throw new RollbackResult(result);
}

async function claimPreparedPair(
  client: PoolClient,
  input: Readonly<ClaimPreparedGmailArchiveInput>,
  state: GmailArchiveApprovalCanonicalState,
  barrier: PreEffectBarrierRow,
  plan: ExecutionPlanRow,
  candidate: CandidateAction,
  policySnapshot: Record<string, unknown>,
): Promise<{ barrier: PreEffectBarrierRow; plan: ExecutionPlanRow }> {
  if (barrier.explanation_id === null) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  const updatedBarrier = (await client.query<PreEffectBarrierRow>(
    `UPDATE pre_effect_barriers
        SET status = 'in_progress', effect_result = $8::JSONB,
            updated_at = date_trunc('milliseconds', now())
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
        AND idempotency_key = $3 AND status = 'prepared'
        AND decision_id = $4 AND action_id = $5 AND explanation_id = $6
        AND policy_snapshot = $7::JSONB AND effect_result = '{}'::JSONB
        AND failure_reason IS NULL
      RETURNING *`,
    [
      barrier.id,
      input.userId,
      input.approvalId,
      state.decision.id,
      state.candidate.id,
      barrier.explanation_id,
      JSON.stringify(policySnapshot),
      JSON.stringify(gmailArchiveAttemptState('pre_dispatch')),
    ],
  )).rows[0];
  if (!updatedBarrier) fail({ ok: false, error: 'idempotency_conflict' });

  const updatedPlan = (await client.query<ExecutionPlanRow>(
    `UPDATE execution_plans AS plan
        SET status = 'in_progress', updated_at = date_trunc('milliseconds', now())
      WHERE plan.id = $1 AND plan.decision_id = $2 AND plan.action_id = $3
        AND plan.status = 'pending' AND plan.steps = $4::JSONB
        AND NOT EXISTS (SELECT 1 FROM execution_results WHERE plan_id = plan.id)
        AND NOT EXISTS (SELECT 1 FROM execution_events WHERE plan_id = plan.id)
        AND EXISTS (
          SELECT 1 FROM decision_outcomes AS outcome
           WHERE outcome.decision_id = plan.decision_id
             AND outcome.selected_action_id = plan.action_id
             AND outcome.execution_plan_id = plan.id
             AND outcome.auto_executed = false
             AND outcome.requires_approval = true
        )
      RETURNING plan.*`,
    [
      plan.id,
      state.decision.id,
      state.candidate.id,
      JSON.stringify(canonicalGmailArchivePlanSteps(candidate)),
    ],
  )).rows[0];
  if (!updatedPlan) fail({ ok: false, error: 'idempotency_conflict' });
  return { barrier: updatedBarrier, plan: updatedPlan };
}

async function transition(
  client: PoolClient,
  input: Readonly<ClaimPreparedGmailArchiveInput>,
): Promise<ClaimPreparedGmailArchiveResult> {
  const state = await loadCanonicalGmailArchiveApprovalState(client, {
    ...input,
    action: 'approve',
  }, { allowExecutionPlan: true });
  if (!state || state.approval.status !== 'approved' || state.approval.responded_at === null ||
      state.approval.responded_at.getTime() > state.approval.expires_at.getTime() ||
      !exactApprovalResponse(state.approval.response)) return { ok: false, error: 'not_found' };
  const approved = canonicalGmailArchiveApprovalContent(
    { ...state, revisions: state.revisions.slice(0, 4) },
    'approved',
  );
  if (!approved) return { ok: false, error: 'idempotency_conflict' };

  const barriers = await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2
      FOR UPDATE`,
    [input.userId, input.approvalId],
  );
  if (barriers.rows.length !== 1) {
    return { ok: true, claimed: false, state: 'not_ready', command: null };
  }
  const barrier = barriers.rows[0]!;
  if (barrier.status !== 'prepared') {
    return classifyNonPrepared(client, input, state, barrier, approved);
  }
  if (!exactGmailArchiveBarrierIdentity(barrier, input, state)) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const replay = await loadGmailArchivePreparationReplay(client, input, state, barrier, approved);
  if (!replay.ok || replay.preparation.status !== 'prepared' || !replay.preparation.plan) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const plan = replay.preparation.plan;
  const candidate = canonicalGmailArchiveCandidate(state);
  const messageRefId = candidate?.parameters['messageRefId'];
  if (!candidate || typeof messageRefId !== 'string' || !UUID.test(messageRefId)) {
    return { ok: false, error: 'idempotency_conflict' };
  }

  const policy = await currentPolicyDecision(client, input, state);
  if (!policy) return { ok: true, claimed: false, state: 'not_ready', command: null };
  if (!policy.decision.allowed || !policy.decision.requiresApproval ||
      policy.decision.confirmationLevel !== 'single' ||
      joinedDecisionReceiptArtifactDigest('policy', policy.snapshot) !==
        joinedDecisionReceiptArtifactDigest('policy', barrier.policy_snapshot)) {
    return { ok: false, error: 'policy_stale' };
  }

  if (await hasExecutionAttempt(client, plan.id)) {
    return { ok: false, error: 'idempotency_conflict' };
  }

  const claimed = await claimPreparedPair(client, input, state, barrier, plan, candidate, policy.snapshot);

  return {
    ok: true,
    claimed: true,
    command: Object.freeze({
      userId: input.userId,
      admissionId: claimed.barrier.id,
      messageRefId,
      operation: 'archive',
    }),
  };
}

async function claimWithTransition(
  input: ClaimPreparedGmailArchiveInput,
  transitionFn: GmailArchiveClaimTransition,
): Promise<ClaimPreparedGmailArchiveResult> {
  const snapshot = snapshotInput(input);
  if (!snapshot) return { ok: false, error: 'invalid_input' };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction((client) => transitionFn(client, snapshot));
    } catch (error) {
      if (error instanceof RollbackResult) return error.result;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

/** Narrow non-root-exported seam for transaction retry tests. */
export const gmailArchiveClaimTestHooks = { claimWithTransition, claimPreparedPair };

export const gmailArchiveClaimRepository = {
  async claim(input: ClaimPreparedGmailArchiveInput): Promise<ClaimPreparedGmailArchiveResult> {
    return claimWithTransition(input, transition);
  },
};
