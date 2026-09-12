import { randomUUID } from 'node:crypto';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  verifyJoinedDecisionReceiptChain,
  type GmailArchiveAttemptPhase,
  type GmailArchiveReconciliationCommand,
  type GmailArchiveReconciliationEvidence,
  type JoinedDecisionReceiptContentV1,
  type ReconcileAbandonedGmailArchiveInput,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../connection.js';
import type {
  DecisionReceiptRevisionRow,
  ExecutionPlanRow,
  ExecutionResultRow,
  ExplanationRecordRow,
} from '../types.js';
import {
  decisionReceiptRowArtifactRefV1,
} from './decision-receipt-artifacts.js';
import { decisionReceiptLifecycleRepository } from './decision-receipt-lifecycle.js';
import { canonicalGmailArchiveCandidateMessageRef } from './gmail-archive-approval-response-repository.js';
import { snapshotGmailArchiveAttemptState } from './gmail-archive-attempt-state.js';
import { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from './gmail-archive-recovery-policy.js';
import {
  exactGmailArchiveApprovedPrefix,
  exactGmailArchiveInProgressBaseline,
  buildGmailArchiveTerminalContent,
  loadGmailArchivePolicyExplanation,
  loadGmailArchiveStableState,
  validateStoredGmailArchiveTerminal,
  type GmailArchiveTerminalizationBundle,
  type GmailArchiveTerminalStableState,
} from './gmail-archive-terminalization-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECONCILIATION_SCHEMA = 'gmail_archive_reconciliation_terminal_v1';
const PRE_DISPATCH_FAILURE = 'recovery_interrupted_before_dispatch';
const CAUSAL_OUTCOME_UNKNOWN = 'recovery_causal_outcome_unknown';
const OBSERVATION_UNAVAILABLE_CODES = [
  'not_observable',
  'authority_unavailable',
  'credentials_unavailable',
  'observation_rejected',
  'observation_unavailable',
] as const;

type ReconciliationDisposition = 'failed' | 'unknown';
type ObservationUnavailableCode = (typeof OBSERVATION_UNAVAILABLE_CODES)[number];

export interface GmailArchiveReconciliationTerminalEnvelope {
  schema: typeof RECONCILIATION_SCHEMA;
  attemptPhase: GmailArchiveAttemptPhase;
  phaseChangedAt: string;
  outcome: ReconciliationDisposition;
  code: typeof PRE_DISPATCH_FAILURE | typeof CAUSAL_OUTCOME_UNKNOWN;
  compensationAvailable: false;
  evidence: Readonly<GmailArchiveReconciliationEvidence>;
}

export interface GmailArchiveReconciliationBundle {
  status: ReconciliationDisposition;
  barrier: PreEffectBarrierRow;
  plan: ExecutionPlanRow;
  executionResult: ExecutionResultRow | null;
  executionExplanation: ExplanationRecordRow;
  revision: DecisionReceiptRevisionRow;
}

export type ReconcileAbandonedGmailArchiveResult =
  | { ok: true; created: boolean; reconciliation: GmailArchiveReconciliationBundle }
  | { ok: false; error: 'invalid_input' | 'not_found' | 'not_ready' | 'idempotency_conflict' };

export interface GmailArchiveReconciliationStableValues {
  explanationId: string;
  resultId: string;
  revisionId: string;
  persistedAt: string;
}

export type GmailArchiveReconciliationTransition = (
  client: PoolClient,
  input: Readonly<ReconcileAbandonedGmailArchiveInput>,
  stable: Readonly<GmailArchiveReconciliationStableValues>,
) => Promise<ReconcileAbandonedGmailArchiveResult>;

interface TerminalAuthority {
  userId: string;
  approvalId: string;
}

export interface GmailArchiveReconciliationExplanationSemantics {
  whatHappened: string;
  confidenceReasoning: string;
  escalationRationale: string | null;
  correctionGuidance: string;
}

class RollbackResult extends Error {
  constructor(readonly result: ReconcileAbandonedGmailArchiveResult) {
    super('Gmail archive reconciliation rolled back');
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
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      return null;
    }
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

function canonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function snapshotCommand(value: unknown): Readonly<GmailArchiveReconciliationCommand> | null {
  const command = ownData(value, ['admissionId', 'messageRefId', 'operation', 'userId']);
  if (!command || typeof command['userId'] !== 'string' || !UUID.test(command['userId']) ||
      typeof command['admissionId'] !== 'string' || !UUID.test(command['admissionId']) ||
      typeof command['messageRefId'] !== 'string' || !UUID.test(command['messageRefId']) ||
      command['operation'] !== 'reconcile_archive') return null;
  return Object.freeze({
    userId: command['userId'],
    admissionId: command['admissionId'],
    messageRefId: command['messageRefId'],
    operation: 'reconcile_archive',
  });
}

function snapshotEvidence(value: unknown): Readonly<GmailArchiveReconciliationEvidence> | null {
  const interrupted = ownData(value, ['kind']);
  if (interrupted?.['kind'] === 'interrupted_before_dispatch') {
    return Object.freeze({ kind: 'interrupted_before_dispatch' });
  }
  const observed = ownData(value, ['binding', 'inbox', 'kind', 'observedAt']);
  const observedBinding = observed
    ? ownData(observed['binding'], ['admissionId', 'messageRefId', 'userId'])
    : null;
  if (observed?.['kind'] === 'mailbox_observed' && typeof observed['inbox'] === 'boolean' &&
      typeof observedBinding?.['userId'] === 'string' && UUID.test(observedBinding['userId']) &&
      typeof observedBinding['admissionId'] === 'string' && UUID.test(observedBinding['admissionId']) &&
      typeof observedBinding['messageRefId'] === 'string' && UUID.test(observedBinding['messageRefId']) &&
      canonicalIsoInstant(observed['observedAt'])) {
    return Object.freeze({
      kind: 'mailbox_observed',
      binding: Object.freeze({
        userId: observedBinding['userId'],
        admissionId: observedBinding['admissionId'],
        messageRefId: observedBinding['messageRefId'],
      }),
      inbox: observed['inbox'],
      observedAt: observed['observedAt'],
    });
  }
  const unavailable = ownData(value, ['binding', 'code', 'kind']);
  const unavailableBinding = unavailable
    ? ownData(unavailable['binding'], ['admissionId', 'messageRefId', 'userId'])
    : null;
  if (unavailable?.['kind'] === 'mailbox_observation_unavailable' &&
      typeof unavailableBinding?.['userId'] === 'string' && UUID.test(unavailableBinding['userId']) &&
      typeof unavailableBinding['admissionId'] === 'string' && UUID.test(unavailableBinding['admissionId']) &&
      typeof unavailableBinding['messageRefId'] === 'string' && UUID.test(unavailableBinding['messageRefId']) &&
      OBSERVATION_UNAVAILABLE_CODES.includes(unavailable['code'] as ObservationUnavailableCode)) {
    return Object.freeze({
      kind: 'mailbox_observation_unavailable',
      binding: Object.freeze({
        userId: unavailableBinding['userId'],
        admissionId: unavailableBinding['admissionId'],
        messageRefId: unavailableBinding['messageRefId'],
      }),
      code: unavailable['code'] as ObservationUnavailableCode,
    });
  }
  return null;
}

function snapshotInput(value: unknown): Readonly<ReconcileAbandonedGmailArchiveInput> | null {
  const input = ownData(value, ['command', 'evidence', 'phase', 'phaseChangedAt']);
  if (!input || (input['phase'] !== 'pre_dispatch' &&
      input['phase'] !== 'dispatch_may_have_started') ||
      !canonicalIsoInstant(input['phaseChangedAt'])) return null;
  const command = snapshotCommand(input['command']);
  const evidence = snapshotEvidence(input['evidence']);
  if (!command || !evidence || !gmailArchiveReconciliationEvidenceAllowedForPhase(
    evidence,
    input['phase'],
  ) || (evidence.kind !== 'interrupted_before_dispatch' &&
      (evidence.binding.userId !== command.userId ||
        evidence.binding.admissionId !== command.admissionId ||
        evidence.binding.messageRefId !== command.messageRefId))) return null;
  return Object.freeze({
    command,
    phase: input['phase'],
    phaseChangedAt: input['phaseChangedAt'],
    evidence,
  });
}

export function gmailArchiveReconciliationEvidenceAllowedForPhase(
  evidence: GmailArchiveReconciliationEvidence,
  phase: GmailArchiveAttemptPhase,
): boolean {
  return phase === 'pre_dispatch'
    ? evidence.kind === 'interrupted_before_dispatch'
    : evidence.kind === 'mailbox_observed' || evidence.kind === 'mailbox_observation_unavailable';
}

function reconciliationDisposition(phase: GmailArchiveAttemptPhase): ReconciliationDisposition {
  return phase === 'pre_dispatch' ? 'failed' : 'unknown';
}

function reconciliationCode(phase: GmailArchiveAttemptPhase):
  typeof PRE_DISPATCH_FAILURE | typeof CAUSAL_OUTCOME_UNKNOWN {
  return phase === 'pre_dispatch' ? PRE_DISPATCH_FAILURE : CAUSAL_OUTCOME_UNKNOWN;
}

export function buildGmailArchiveReconciliationTerminalEnvelope(
  input: Pick<ReconcileAbandonedGmailArchiveInput, 'evidence' | 'phase' | 'phaseChangedAt'>,
): GmailArchiveReconciliationTerminalEnvelope {
  return {
    schema: RECONCILIATION_SCHEMA,
    attemptPhase: input.phase,
    phaseChangedAt: input.phaseChangedAt,
    outcome: reconciliationDisposition(input.phase),
    code: reconciliationCode(input.phase),
    compensationAvailable: false,
    evidence: input.evidence,
  };
}

export function parseGmailArchiveReconciliationTerminalEnvelope(
  value: unknown,
): Readonly<GmailArchiveReconciliationTerminalEnvelope> | null {
  const envelope = ownData(value, [
    'attemptPhase', 'code', 'compensationAvailable', 'evidence', 'outcome',
    'phaseChangedAt', 'schema',
  ]);
  if (!envelope || envelope['schema'] !== RECONCILIATION_SCHEMA ||
      (envelope['attemptPhase'] !== 'pre_dispatch' &&
        envelope['attemptPhase'] !== 'dispatch_may_have_started') ||
      !canonicalIsoInstant(envelope['phaseChangedAt']) || envelope['compensationAvailable'] !== false) {
    return null;
  }
  const evidence = snapshotEvidence(envelope['evidence']);
  if (!evidence || !gmailArchiveReconciliationEvidenceAllowedForPhase(
    evidence,
    envelope['attemptPhase'],
  ) || envelope['outcome'] !== reconciliationDisposition(envelope['attemptPhase']) ||
      envelope['code'] !== reconciliationCode(envelope['attemptPhase'])) return null;
  const attemptPhase = envelope['attemptPhase'];
  const outcome = reconciliationDisposition(attemptPhase);
  const code = reconciliationCode(attemptPhase);
  return Object.freeze({
    schema: RECONCILIATION_SCHEMA,
    attemptPhase,
    phaseChangedAt: envelope['phaseChangedAt'],
    outcome,
    code,
    compensationAvailable: false,
    evidence,
  });
}

export function parseGmailArchiveReconciliationExplanationEvidence(
  value: unknown,
): Readonly<GmailArchiveReconciliationTerminalEnvelope> | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length !== 1 || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.keys(value).length !== 1 || Object.keys(value)[0] !== '0') return null;
    const item = Object.getOwnPropertyDescriptor(value, '0');
    if (!item || !Object.prototype.hasOwnProperty.call(item, 'value') || !item.enumerable) return null;
    return parseGmailArchiveReconciliationTerminalEnvelope(item.value);
  } catch {
    return null;
  }
}

export function gmailArchiveReconciliationExplanationSemantics(
  envelope: GmailArchiveReconciliationTerminalEnvelope,
): GmailArchiveReconciliationExplanationSemantics {
  if (envelope.outcome === 'failed') {
    return {
      whatHappened: 'The approved Gmail Inbox archive attempt ended before any Gmail mutation request began.',
      confidenceReasoning: 'The durable attempt marker was still pre-dispatch when the abandoned attempt was reconciled.',
      escalationRationale: null,
      correctionGuidance: 'Review the requested archive and approve a new attempt if it is still wanted.',
    };
  }
  if (envelope.evidence.kind === 'mailbox_observed') {
    const currentState = envelope.evidence.inbox ? 'in Inbox' : 'outside Inbox';
    return {
      whatHappened: `The approved Gmail Inbox archive attempt has an unknown outcome. A later mailbox observation found the message ${currentState}, but does not establish what caused that state.`,
      confidenceReasoning: 'The durable dispatch boundary may have been crossed, and a later mailbox read can establish current state but not causal execution outcome.',
      escalationRationale: 'The prior request must not be replayed because it may already have reached Gmail.',
      correctionGuidance: 'Review the current mailbox state before deciding whether to take a new action.',
    };
  }
  const unavailableCode = envelope.evidence.kind === 'mailbox_observation_unavailable'
    ? envelope.evidence.code
    : 'observation_unavailable';
  return {
    whatHappened: 'The approved Gmail Inbox archive attempt has an unknown outcome, and a later mailbox state could not be accepted.',
    confidenceReasoning: `The durable dispatch boundary may have been crossed; mailbox observation was unavailable (${unavailableCode}).`,
    escalationRationale: 'The prior request must not be replayed because it may already have reached Gmail.',
    correctionGuidance: 'Review the message in Gmail before deciding whether to take a new action.',
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return joinedDecisionReceiptArtifactDigest('policy', left) ===
    joinedDecisionReceiptArtifactDigest('policy', right);
}

function reconciliationExplanation(input: {
  id: string;
  createdAt: string;
  state: GmailArchiveTerminalStableState;
  barrier: PreEffectBarrierRow;
  envelope: GmailArchiveReconciliationTerminalEnvelope;
}): ExplanationRecordRow {
  const semantics = gmailArchiveReconciliationExplanationSemantics(input.envelope);
  const policyIds = Array.isArray(input.barrier.policy_snapshot['policyIds'])
    ? input.barrier.policy_snapshot['policyIds'].filter((id): id is string => typeof id === 'string')
    : [];
  return {
    id: input.id,
    decision_id: input.state.decision.id,
    what_happened: semantics.whatHappened,
    evidence_used: [input.envelope],
    preferences_invoked: [...policyIds].sort(),
    confidence_reasoning: semantics.confidenceReasoning,
    action_rationale: `Close the abandoned explicitly approved Gmail Inbox archive attempt without replaying it. Preserved policy rationale: ${input.state.approval.candidate_action['reasoning'] as string}. Policy snapshot: ${joinedDecisionReceiptArtifactDigest('policy', input.barrier.policy_snapshot)}.`,
    escalation_rationale: semantics.escalationRationale,
    correction_guidance: semantics.correctionGuidance,
    capability_provenance_node_id: null,
    created_at: new Date(input.createdAt),
  };
}

function exactExecutionResult(
  row: ExecutionResultRow,
  envelope: GmailArchiveReconciliationTerminalEnvelope,
  plan: ExecutionPlanRow,
  terminalAt: Date,
): boolean {
  return envelope.outcome === 'failed' && row.plan_id === plan.id && row.success === false &&
    row.error === PRE_DISPATCH_FAILURE && row.rollback_available === false &&
    row.completed_at.getTime() === terminalAt.getTime() && sameCanonical(row.outputs, envelope);
}

async function exactTerminalReplay(
  client: PoolClient,
  authority: TerminalAuthority,
  expected: GmailArchiveReconciliationTerminalEnvelope | null,
  state: GmailArchiveTerminalStableState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
): Promise<GmailArchiveReconciliationBundle | null> {
  const retained = parseGmailArchiveReconciliationTerminalEnvelope(barrier.effect_result);
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (!retained || (expected && !sameCanonical(retained, expected)) ||
      !messageRefId || barrier.status !== retained.outcome || barrier.failure_reason !== retained.code ||
      (retained.evidence.kind !== 'interrupted_before_dispatch' &&
        (retained.evidence.binding.userId !== authority.userId ||
          retained.evidence.binding.admissionId !== barrier.id ||
          retained.evidence.binding.messageRefId !== messageRefId))) return null;
  const plans = (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC FOR UPDATE',
    [state.decision.id],
  )).rows;
  if (plans.length !== 1 || plans[0]!.status !== 'failed' ||
      plans[0]!.id !== state.outcome.execution_plan_id ||
      plans[0]!.action_id !== state.candidate.id) return null;
  const plan = plans[0]!;
  const results = (await client.query<ExecutionResultRow>(
    'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY id ASC FOR UPDATE',
    [plan.id],
  )).rows;
  const events = await client.query<{ count: string }>(
    'SELECT count(*)::STRING AS count FROM execution_events WHERE plan_id = $1',
    [plan.id],
  );
  if (events.rows[0]?.count !== '0' ||
      (retained.outcome === 'unknown' ? results.length !== 0 : results.length !== 1)) return null;
  const policyExplanation = await loadGmailArchivePolicyExplanation(
    client,
    barrier,
    state.decision.id,
  );
  if (!policyExplanation || !await exactGmailArchiveInProgressBaseline(
    client,
    authority,
    state,
    barrier,
    plan,
    policyExplanation,
    approved,
    true,
  )) return null;
  const r7 = state.revisions[6];
  const explanationId = r7?.content.version === 2 ? r7.content.executionExplanation.id : null;
  if (!r7 || !explanationId || explanationId === barrier.explanation_id) return null;
  const explanation = (await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
    [explanationId, state.decision.id],
  )).rows[0];
  const terminalAt = r7.created_at;
  const executionResult = results[0] ?? null;
  const explanationEvidence = parseGmailArchiveReconciliationExplanationEvidence(
    explanation?.evidence_used,
  );
  if (!explanation || !explanationEvidence || !sameCanonical(explanationEvidence, retained) ||
      barrier.updated_at.getTime() !== terminalAt.getTime() ||
      plan.updated_at.getTime() !== terminalAt.getTime() ||
      explanation.created_at.getTime() !== terminalAt.getTime() ||
      Date.parse(retained.phaseChangedAt) + GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS * 1_000 >
        terminalAt.getTime() ||
      (retained.evidence.kind === 'mailbox_observed' &&
        Date.parse(retained.evidence.observedAt) > terminalAt.getTime()) ||
      (executionResult && !exactExecutionResult(executionResult, retained, plan, terminalAt))) return null;
  const expectedExplanation = reconciliationExplanation({
    id: explanation.id,
    createdAt: terminalAt.toISOString(),
    state,
    barrier,
    envelope: retained,
  });
  if (decisionReceiptRowArtifactRefV1('explanation', { ...explanation }).canonicalHash !==
      decisionReceiptRowArtifactRefV1('explanation', { ...expectedExplanation }).canonicalHash) return null;
  const expectedContent = buildGmailArchiveTerminalContent({
    admitted: state.revisions[5]!.content as JoinedDecisionReceiptContentV1,
    barrier,
    plan,
    executionResult,
    executionExplanation: explanation,
    disposition: retained.outcome,
  });
  const eventKey = buildDecisionReceiptEventKey('execution_recorded', plan.id);
  if (state.revisions.length < 7 ||
      state.revisions.filter((revision) => revision.stage === 'execution_recorded').length !== 1 ||
      state.revisions.some((revision) => revision.trusted !== true) ||
      !verifyJoinedDecisionReceiptChain({
        receiptId: state.receipt.id,
        decisionId: state.decision.id,
        userId: authority.userId,
        revisions: state.revisions,
      }) || r7.event_key !== eventKey || r7.stage !== 'execution_recorded' ||
      r7.disposition !== retained.outcome ||
      r7.content_digest !== joinedDecisionReceiptContentDigest(expectedContent) ||
      r7.candidate_action_id !== state.candidate.id || r7.barrier_id !== barrier.id ||
      r7.explanation_id !== barrier.explanation_id ||
      r7.approval_request_id !== state.approval.id || r7.execution_plan_id !== plan.id ||
      r7.execution_result_id !== (executionResult?.id ?? null) ||
      r7.execution_disposition !== retained.outcome || r7.correction_of_revision_id !== null) {
    return null;
  }
  return {
    status: retained.outcome,
    barrier,
    plan,
    executionResult,
    executionExplanation: explanation,
    revision: r7,
  };
}

/** Validate an exact reconciliation r7 terminal graph and trusted continuation. */
export async function validateStoredGmailArchiveReconciliationTerminal(
  client: PoolClient,
  authority: TerminalAuthority,
  state: GmailArchiveTerminalStableState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
  expected?: GmailArchiveReconciliationTerminalEnvelope,
): Promise<GmailArchiveReconciliationBundle | null> {
  return exactTerminalReplay(client, authority, expected ?? null, state, barrier, approved);
}

/** Validate either supported, immutable Gmail archive terminal graph. */
export async function validateStoredGmailArchiveTerminalGraph(
  client: PoolClient,
  authority: TerminalAuthority,
  state: GmailArchiveTerminalStableState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
): Promise<GmailArchiveTerminalizationBundle | GmailArchiveReconciliationBundle | null> {
  const mutationTerminal = await validateStoredGmailArchiveTerminal(
    client,
    authority,
    state,
    barrier,
    approved,
  );
  return mutationTerminal ?? validateStoredGmailArchiveReconciliationTerminal(
    client,
    authority,
    state,
    barrier,
    approved,
  );
}

function fail(result: ReconcileAbandonedGmailArchiveResult): never {
  throw new RollbackResult(result);
}

async function transition(
  client: PoolClient,
  input: Readonly<ReconcileAbandonedGmailArchiveInput>,
  stable: Readonly<GmailArchiveReconciliationStableValues>,
): Promise<ReconcileAbandonedGmailArchiveResult> {
  const barriers = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
      FOR UPDATE`,
    [input.command.admissionId, input.command.userId],
  )).rows;
  if (barriers.length !== 1 || !UUID.test(barriers[0]!.idempotency_key)) {
    return { ok: false, error: 'not_found' };
  }
  const barrier = barriers[0]!;
  const authority = Object.freeze({
    userId: input.command.userId,
    approvalId: barrier.idempotency_key,
  });
  const state = await loadGmailArchiveStableState(client, authority);
  if (!state) return { ok: false, error: 'not_found' };
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (!messageRefId || input.command.messageRefId !== messageRefId ||
      input.command.operation !== 'reconcile_archive' || barrier.decision_id !== state.decision.id ||
      barrier.action_id !== state.candidate.id || barrier.explanation_id === null) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const approved = exactGmailArchiveApprovedPrefix(state);
  if (!approved) return { ok: false, error: 'idempotency_conflict' };
  const envelope = buildGmailArchiveReconciliationTerminalEnvelope(input);
  if (barrier.status === 'succeeded' || barrier.status === 'failed' || barrier.status === 'unknown') {
    const reconciliation = await validateStoredGmailArchiveReconciliationTerminal(
      client,
      authority,
      state,
      barrier,
      approved,
      envelope,
    );
    return reconciliation
      ? { ok: true, created: false, reconciliation }
      : { ok: false, error: 'idempotency_conflict' };
  }
  if (barrier.status !== 'in_progress') return { ok: false, error: 'not_ready' };
  const attempt = snapshotGmailArchiveAttemptState(barrier.effect_result);
  if (!attempt || attempt.phase !== input.phase ||
      barrier.updated_at.toISOString() !== input.phaseChangedAt ||
      !gmailArchiveReconciliationEvidenceAllowedForPhase(input.evidence, input.phase)) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const due = (await client.query<{ due: boolean }>(
    `SELECT $1::TIMESTAMPTZ + ($2::INT * INTERVAL '1 second') <= now() AS due`,
    [input.phaseChangedAt, GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS],
  )).rows[0]?.due;
  if (due !== true) return { ok: false, error: 'not_ready' };
  const plans = (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC FOR UPDATE',
    [state.decision.id],
  )).rows;
  if (plans.length !== 1 || plans[0]!.status !== 'in_progress' ||
      plans[0]!.id !== state.outcome.execution_plan_id ||
      plans[0]!.action_id !== state.candidate.id) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const plan = plans[0]!;
  const counts = await client.query<{ results: string; events: string }>(
    `SELECT
       (SELECT count(*) FROM execution_results WHERE plan_id = $1) AS results,
       (SELECT count(*) FROM execution_events WHERE plan_id = $1) AS events`,
    [plan.id],
  );
  if (counts.rows[0]?.results !== '0' || counts.rows[0]?.events !== '0' ||
      state.revisions.length !== 6) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const policyExplanation = await loadGmailArchivePolicyExplanation(
    client,
    barrier,
    state.decision.id,
  );
  if (!policyExplanation || !await exactGmailArchiveInProgressBaseline(
    client,
    authority,
    state,
    barrier,
    plan,
    policyExplanation,
    approved,
    false,
  )) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const explanation = reconciliationExplanation({
    id: stable.explanationId,
    createdAt: stable.persistedAt,
    state,
    barrier,
    envelope,
  });
  const insertedExplanation = (await client.query<ExplanationRecordRow>(
    `INSERT INTO explanation_records (
       id, decision_id, what_happened, evidence_used, preferences_invoked,
       confidence_reasoning, action_rationale, escalation_rationale,
       correction_guidance, capability_provenance_node_id, created_at
     ) VALUES ($1, $2, $3, $4::JSONB, $5::STRING[], $6, $7, $8, $9, NULL, $10::TIMESTAMPTZ)
     RETURNING *`,
    [
      explanation.id,
      explanation.decision_id,
      explanation.what_happened,
      JSON.stringify(explanation.evidence_used),
      explanation.preferences_invoked,
      explanation.confidence_reasoning,
      explanation.action_rationale,
      explanation.escalation_rationale,
      explanation.correction_guidance,
      stable.persistedAt,
    ],
  )).rows[0];
  if (!insertedExplanation) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  const terminalBarrier = (await client.query<PreEffectBarrierRow>(
    `UPDATE pre_effect_barriers
        SET status = $4, effect_result = $5::JSONB, failure_reason = $6,
            updated_at = $7::TIMESTAMPTZ
      WHERE id = $1 AND user_id = $2 AND idempotency_key = $3
        AND effect_type = 'event_execution' AND status = 'in_progress'
        AND decision_id = $8 AND action_id = $9 AND explanation_id = $10
        AND policy_snapshot = $11::JSONB AND effect_result = $12::JSONB
        AND failure_reason IS NULL AND updated_at = $13::TIMESTAMPTZ
      RETURNING *`,
    [
      barrier.id,
      authority.userId,
      authority.approvalId,
      envelope.outcome,
      JSON.stringify(envelope),
      envelope.code,
      stable.persistedAt,
      state.decision.id,
      state.candidate.id,
      barrier.explanation_id,
      JSON.stringify(barrier.policy_snapshot),
      JSON.stringify(attempt),
      input.phaseChangedAt,
    ],
  )).rows[0];
  if (!terminalBarrier) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  const terminalPlan = (await client.query<ExecutionPlanRow>(
    `UPDATE execution_plans
        SET status = 'failed', updated_at = $4::TIMESTAMPTZ
      WHERE id = $1 AND decision_id = $2 AND action_id = $3 AND status = 'in_progress'
        AND steps = $5::JSONB
        AND NOT EXISTS (SELECT 1 FROM execution_results WHERE plan_id = $1)
        AND NOT EXISTS (SELECT 1 FROM execution_events WHERE plan_id = $1)
      RETURNING *`,
    [plan.id, state.decision.id, state.candidate.id, stable.persistedAt,
      JSON.stringify(plan.steps)],
  )).rows[0];
  if (!terminalPlan) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  let executionResult: ExecutionResultRow | null = null;
  if (envelope.outcome === 'failed') {
    executionResult = (await client.query<ExecutionResultRow>(
      `INSERT INTO execution_results (
         id, plan_id, success, outputs, error, rollback_available, completed_at
       ) VALUES ($1, $2, false, $3::JSONB, $4, false, $5::TIMESTAMPTZ)
       RETURNING *`,
      [stable.resultId, plan.id, JSON.stringify(envelope), envelope.code, stable.persistedAt],
    )).rows[0] ?? null;
    if (!executionResult || !exactExecutionResult(
      executionResult,
      envelope,
      terminalPlan,
      new Date(stable.persistedAt),
    )) {
      fail({ ok: false, error: 'idempotency_conflict' });
    }
  }
  const content = buildGmailArchiveTerminalContent({
    admitted: state.revisions[5]!.content as JoinedDecisionReceiptContentV1,
    barrier: terminalBarrier,
    plan: terminalPlan,
    executionResult,
    executionExplanation: insertedExplanation,
    disposition: envelope.outcome,
  });
  const appended = await decisionReceiptLifecycleRepository.appendForUser(
    client,
    authority.userId,
    {
      eventId: plan.id,
      eventKind: 'execution_recorded',
      expectedPreviousDigest: state.revisions[5]!.revision_digest,
      content,
      receiptId: state.receipt.id,
      revisionId: stable.revisionId,
      createdAt: stable.persistedAt,
    },
  );
  if (!appended.success || !appended.created) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  return {
    ok: true,
    created: true,
    reconciliation: {
      status: envelope.outcome,
      barrier: terminalBarrier,
      plan: terminalPlan,
      executionResult,
      executionExplanation: insertedExplanation,
      revision: appended.revision,
    },
  };
}

function allocateStableValues(persistedAt: string): GmailArchiveReconciliationStableValues {
  return Object.freeze({
    explanationId: randomUUID(),
    resultId: randomUUID(),
    revisionId: randomUUID(),
    persistedAt,
  });
}

async function loadDatabasePersistedAt(): Promise<string> {
  const value = (await query<{ persisted_at: Date | string }>(
    'SELECT now() AS persisted_at',
  )).rows[0]?.persisted_at;
  const persistedAt = value instanceof Date ? value.toISOString() : value;
  if (!canonicalIsoInstant(persistedAt)) {
    throw new Error('Database did not return a canonical reconciliation timestamp');
  }
  return persistedAt;
}

function snapshotStableValues(
  value: unknown,
): Readonly<GmailArchiveReconciliationStableValues> | null {
  const stable = ownData(value, ['explanationId', 'persistedAt', 'resultId', 'revisionId']);
  if (!stable || typeof stable['explanationId'] !== 'string' ||
      !UUID.test(stable['explanationId']) || typeof stable['resultId'] !== 'string' ||
      !UUID.test(stable['resultId']) || typeof stable['revisionId'] !== 'string' ||
      !UUID.test(stable['revisionId']) ||
      new Set([stable['explanationId'], stable['resultId'], stable['revisionId']]).size !== 3 ||
      !canonicalIsoInstant(stable['persistedAt'])) return null;
  return Object.freeze({
    explanationId: stable['explanationId'],
    resultId: stable['resultId'],
    revisionId: stable['revisionId'],
    persistedAt: stable['persistedAt'],
  });
}

async function reconcileWithTransition(
  submitted: ReconcileAbandonedGmailArchiveInput,
  transitionFn: GmailArchiveReconciliationTransition,
  stableFactory: (persistedAt: string) => GmailArchiveReconciliationStableValues = allocateStableValues,
  persistedAtFactory: () => Promise<string> = loadDatabasePersistedAt,
): Promise<ReconcileAbandonedGmailArchiveResult> {
  const input = snapshotInput(submitted);
  if (!input) return { ok: false, error: 'invalid_input' };
  const persistedAt = await persistedAtFactory();
  const stable = snapshotStableValues(stableFactory(persistedAt));
  if (!stable || Date.parse(input.phaseChangedAt) > Date.parse(stable.persistedAt) ||
      (input.evidence.kind === 'mailbox_observed' &&
        Date.parse(input.evidence.observedAt) > Date.parse(stable.persistedAt))) {
    return { ok: false, error: 'invalid_input' };
  }
  if (Date.parse(input.phaseChangedAt) + GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS * 1_000 >
      Date.parse(stable.persistedAt)) return { ok: false, error: 'not_ready' };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction((client) => transitionFn(client, input, stable));
    } catch (error) {
      if (error instanceof RollbackResult) return error.result;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

/** Narrow seams for validation, rollback, and Cockroach retry tests. */
export const gmailArchiveReconciliationTestHooks = {
  reconcileWithTransition,
  transition,
};

/**
 * DB-only recovery terminalizer. It performs no Gmail, credential, observation,
 * policy-gate, router, API, or worker calls and never replays the prior request.
 */
export const gmailArchiveReconciliationRepository = {
  async reconcile(
    input: ReconcileAbandonedGmailArchiveInput,
  ): Promise<ReconcileAbandonedGmailArchiveResult> {
    return reconcileWithTransition(input, transition);
  },
};
