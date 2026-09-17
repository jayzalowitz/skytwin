import { randomUUID } from 'node:crypto';
import {
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  RiskDimension,
  RiskTier,
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  validateJoinedDecisionReceiptContent,
  verifyJoinedDecisionReceiptChain,
  type JoinedDecisionReceiptContentV1,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type {
  ApprovalRequestRow,
  CandidateActionRow,
  DecisionOutcomeRow,
  DecisionReceiptRevisionRow,
  DecisionReceiptRow,
  DecisionRow,
  ExplanationRecordRow,
  FeedbackEventRow,
  SignalRow,
} from '../types.js';
import {
  decisionReceiptApprovalRefV1,
  decisionReceiptBarrierRefV1,
  decisionReceiptRowArtifactRefV1,
} from './decision-receipt-artifacts.js';
import { decisionReceiptLifecycleRepository } from './decision-receipt-lifecycle.js';
import { normalizeDecisionReceiptRevisionRow } from './decision-receipt-repository.js';
import {
  buildGmailArchiveProposalReceiptContents,
  GMAIL_ARCHIVE_PROPOSAL_REASON,
} from './gmail-archive-proposal-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RespondGmailArchiveApprovalInput {
  approvalId: string;
  userId: string;
  action: 'approve' | 'reject';
  reason?: string;
}

export interface GmailArchiveApprovalResponseBundle {
  approval: ApprovalRequestRow;
  feedback: FeedbackEventRow;
  proposalBarrier: PreEffectBarrierRow;
  reservedBarrier: PreEffectBarrierRow | null;
  receipt: DecisionReceiptRow;
  revisions: DecisionReceiptRevisionRow[];
}

export type RespondGmailArchiveApprovalResult =
  | { ok: true; created: boolean; response: GmailArchiveApprovalResponseBundle }
  | { ok: false; error: 'invalid_input' | 'not_found' | 'not_pending_or_expired' | 'idempotency_conflict' };

export interface GmailArchiveApprovalResponseStableIds {
  barrier: string;
  feedback: string;
  revision: string;
}

export type GmailArchiveApprovalResponseTransition = (
  client: PoolClient,
  input: RespondGmailArchiveApprovalInput,
  ids: Readonly<GmailArchiveApprovalResponseStableIds>,
) => Promise<RespondGmailArchiveApprovalResult>;

export interface GmailArchiveApprovalCanonicalState {
  approval: ApprovalRequestRow;
  decision: DecisionRow;
  candidate: CandidateActionRow;
  outcome: DecisionOutcomeRow;
  explanation: ExplanationRecordRow;
  signal: SignalRow;
  proposalBarrier: PreEffectBarrierRow;
  receipt: DecisionReceiptRow;
  revisions: DecisionReceiptRevisionRow[];
  unexpired: boolean;
}

export interface LoadCanonicalGmailArchiveApprovalStateOptions {
  allowExecutionPlan?: boolean;
}

interface LockedApprovalRow extends ApprovalRequestRow {
  unexpired: boolean;
}

class RollbackResult extends Error {
  constructor(readonly result: RespondGmailArchiveApprovalResult) {
    super('Gmail archive approval response rolled back');
  }
}

function ownDataSnapshot(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (requiredKeys.some((key) => !names.includes(key)) ||
        names.some((key) => !allowed.has(key))) return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of names) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotInput(value: unknown): Readonly<RespondGmailArchiveApprovalInput> | null {
  const record = ownDataSnapshot(value, ['approvalId', 'userId', 'action'], ['reason']);
  if (!record || typeof record['approvalId'] !== 'string' || !UUID.test(record['approvalId']) ||
      typeof record['userId'] !== 'string' || !UUID.test(record['userId']) ||
      (record['action'] !== 'approve' && record['action'] !== 'reject') ||
      (record['reason'] !== undefined &&
       (typeof record['reason'] !== 'string' || record['reason'].length > 2_000))) return null;
  return Object.freeze({
    approvalId: record['approvalId'],
    userId: record['userId'],
    action: record['action'],
    ...(record['reason'] === undefined ? {} : { reason: record['reason'] }),
  });
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return ownDataSnapshot(value, keys) !== null;
}

function exactRisk(value: unknown, candidateId: string): boolean {
  if (!exactKeys(value, ['actionId', 'overallTier', 'dimensions', 'reasoning', 'assessedAt'])) return false;
  if (value['actionId'] !== candidateId ||
      !Object.values(RiskTier).includes(value['overallTier'] as RiskTier) ||
      typeof value['reasoning'] !== 'string' || value['reasoning'].trim().length === 0 ||
      typeof value['assessedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(value['assessedAt']))) return false;
  if (!exactKeys(value['dimensions'], Object.values(RiskDimension))) return false;
  const dimensions = value['dimensions'];
  return Object.values(RiskDimension).every((dimension) => {
    const assessment = dimensions[dimension];
    return exactKeys(assessment, ['tier', 'score', 'reasoning']) &&
      Object.values(RiskTier).includes(assessment['tier'] as RiskTier) &&
      typeof assessment['score'] === 'number' && Number.isFinite(assessment['score']) &&
      assessment['score'] >= 0 && assessment['score'] <= 1 &&
      typeof assessment['reasoning'] === 'string' && assessment['reasoning'].trim().length > 0;
  });
}

/** Exact stable candidate/message identity shared with post-effect lifecycles. */
export function canonicalGmailArchiveCandidateMessageRef(
  approval: ApprovalRequestRow,
  candidate: CandidateActionRow,
): string | null {
  const stored = approval.candidate_action;
  if (!exactKeys(stored, [
    'id', 'decisionId', 'actionType', 'description', 'domain', 'parameters',
    'estimatedCostCents', 'costZeroIntent', 'reversible', 'confidence', 'reasoning', 'provenance',
  ]) || stored['id'] !== candidate.id || stored['decisionId'] !== candidate.decision_id ||
      stored['actionType'] !== 'archive_email' || stored['description'] !== candidate.description ||
      stored['domain'] !== 'email' || stored['estimatedCostCents'] !== 0 ||
      stored['costZeroIntent'] !== 'verified_zero' || stored['reversible'] !== true ||
      stored['confidence'] !== candidate.predicted_user_preference ||
      stored['provenance'] !== 'untrusted_external' ||
      typeof stored['reasoning'] !== 'string' || stored['reasoning'].trim().length === 0 ||
      candidate.action_type !== 'archive_email' || candidate.reversible !== true ||
      candidate.estimated_cost !== null || !exactRisk(candidate.risk_assessment, candidate.id)) return null;
  const approvalParameters = stored['parameters'];
  const candidateParameters = candidate.parameters;
  if (!exactKeys(approvalParameters, ['schema', 'messageRefId', 'operation']) ||
      !exactKeys(candidateParameters, [
        'schema', 'messageRefId', 'operation', 'domain', 'costZeroIntent', 'provenance',
      ]) || approvalParameters['schema'] !== GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA ||
      approvalParameters['operation'] !== 'archive' ||
      typeof approvalParameters['messageRefId'] !== 'string' ||
      !UUID.test(approvalParameters['messageRefId']) ||
      candidateParameters['schema'] !== approvalParameters['schema'] ||
      candidateParameters['messageRefId'] !== approvalParameters['messageRefId'] ||
      candidateParameters['operation'] !== 'archive' || candidateParameters['domain'] !== 'email' ||
      candidateParameters['costZeroIntent'] !== 'verified_zero' ||
      candidateParameters['provenance'] !== 'untrusted_external') return null;
  return approvalParameters['messageRefId'];
}

function sameResponse(
  approval: ApprovalRequestRow,
  input: RespondGmailArchiveApprovalInput,
): boolean {
  const response = approval.response;
  return exactKeys(response, ['action', 'reason']) &&
    response['action'] === input.action &&
    response['reason'] === (input.reason ?? null);
}

function exactApprovalFeedback(
  feedback: FeedbackEventRow,
  approval: ApprovalRequestRow,
  input: RespondGmailArchiveApprovalInput,
  responseTimestampMatches: boolean,
): boolean {
  return UUID.test(feedback.id) &&
    feedback.user_id === input.userId &&
    feedback.decision_id === approval.decision_id &&
    feedback.approval_request_id === approval.id &&
    feedback.type === input.action &&
    exactKeys(feedback.data, ['reason']) &&
    feedback.data['reason'] === (input.reason ?? null) &&
    feedback.created_at instanceof Date &&
    Number.isFinite(feedback.created_at.getTime()) &&
    approval.responded_at instanceof Date &&
    responseTimestampMatches;
}

interface LoadedApprovalFeedback {
  feedback: FeedbackEventRow;
  responseTimestampMatches: boolean;
}

async function loadApprovalFeedback(
  client: PoolClient,
  approvalId: string,
): Promise<LoadedApprovalFeedback[]> {
  const rows = (await client.query<FeedbackEventRow & { response_timestamp_matches: boolean }>(
    `SELECT feedback.*,
            feedback.created_at = approval.responded_at AS response_timestamp_matches
       FROM feedback_events feedback
       JOIN approval_requests approval
         ON approval.id = feedback.approval_request_id
      WHERE feedback.approval_request_id = $1
      ORDER BY feedback.id
      LIMIT 2`,
    [approvalId],
  )).rows;
  return rows.map((row) => {
    const { response_timestamp_matches: responseTimestampMatches, ...feedback } = row;
    return { feedback, responseTimestampMatches };
  });
}

export function canonicalGmailArchiveApprovalContent(
  state: GmailArchiveApprovalCanonicalState,
  disposition: 'requires_approval' | 'approved' | 'rejected',
): JoinedDecisionReceiptContentV1 | null {
  const expectedLength = disposition === 'requires_approval' ? 3 : 4;
  if (state.revisions.length !== expectedLength ||
      state.revisions.some((revision) => revision.trusted !== true)) return null;
  if (!verifyJoinedDecisionReceiptChain({
    receiptId: state.receipt.id,
    decisionId: state.decision.id,
    userId: state.approval.user_id,
    revisions: state.revisions,
  })) return null;
  const pendingApproval: ApprovalRequestRow = {
    ...state.approval,
    status: 'pending',
    responded_at: null,
  };
  const expectedPrefix = buildGmailArchiveProposalReceiptContents({
    decision: state.decision,
    candidate: state.candidate,
    explanation: state.explanation,
    barrier: state.proposalBarrier,
    approval: pendingApproval,
    signal: state.signal,
  });
  const expectedEventKeys = [
    buildDecisionReceiptEventKey('decision_created', state.decision.id),
    buildDecisionReceiptEventKey('policy_evaluated', state.proposalBarrier.id),
    buildDecisionReceiptEventKey('approval_created', state.approval.id),
  ];
  if (state.revisions.slice(0, 3).some((revision, index) =>
    revision.event_key !== expectedEventKeys[index] ||
    revision.content_digest !== joinedDecisionReceiptContentDigest(expectedPrefix[index]!)
  )) return null;
  if (disposition !== 'requires_approval' &&
      state.revisions[3]?.event_key !==
        buildDecisionReceiptEventKey('approval_responded', state.approval.id)) return null;
  const content = state.revisions.at(-1)?.content;
  if (!content) return null;
  try {
    validateJoinedDecisionReceiptContent(content);
  } catch {
    return null;
  }
  if (content.version !== 1 || content.stage !== 'approval_recorded' ||
      content.disposition !== disposition ||
      content.decision.id !== state.decision.id ||
      content.decision.canonicalHash !==
        decisionReceiptRowArtifactRefV1('decision', { ...state.decision }).canonicalHash ||
      content.candidateAction?.id !== state.candidate.id ||
      content.candidateAction.canonicalHash !==
        decisionReceiptRowArtifactRefV1('candidate_action', { ...state.candidate }).canonicalHash ||
      content.risk?.candidateActionId !== state.candidate.id ||
      content.risk.canonicalHash !==
        joinedDecisionReceiptArtifactDigest('risk', state.candidate.risk_assessment) ||
      content.barrier?.id !== state.proposalBarrier.id ||
      content.barrier.canonicalHash !==
        decisionReceiptBarrierRefV1(state.proposalBarrier).canonicalHash ||
      content.approvalRequest?.id !== state.approval.id ||
      content.approvalRequest.canonicalHash !==
        decisionReceiptApprovalRefV1(state.approval).canonicalHash ||
      content.policyEvaluations.at(-1)?.phase !== 'pre_effect' ||
      content.policyEvaluations.at(-1)?.disposition !== 'requires_approval') return null;
  return content;
}

async function loadCanonicalGmailArchiveApprovalStateWithLockMode(
  client: PoolClient,
  input: RespondGmailArchiveApprovalInput,
  options: LoadCanonicalGmailArchiveApprovalStateOptions = {},
  lockRows = true,
): Promise<GmailArchiveApprovalCanonicalState | null> {
  const lock = lockRows ? ' FOR UPDATE' : '';
  const lockedApproval = (await client.query<LockedApprovalRow>(
    `SELECT approval.*, approval.expires_at > now() AS unexpired
       FROM approval_requests AS approval
      WHERE approval.id = $1 AND approval.user_id = $2
      ${lock}`,
    [input.approvalId, input.userId],
  )).rows[0];
  const approval: ApprovalRequestRow | undefined = lockedApproval;
  if (!approval || approval.confirmation_level !== 'single' ||
      approval.reason !== GMAIL_ARCHIVE_PROPOSAL_REASON || approval.batch_id !== null ||
      approval.first_confirmed_at !== null || approval.confirmation_token !== null) return null;
  if (approval.status === 'pending' &&
      (approval.responded_at !== null || approval.response !== null)) return null;
  const decision = (await client.query<DecisionRow>(
    `SELECT * FROM decisions WHERE id = $1 AND user_id = $2
       AND situation_type = 'email_triage' AND domain = 'email'
       AND metadata = '{"proposalOnly":true}'::JSONB`,
    [approval.decision_id, input.userId],
  )).rows[0];
  if (!decision) return null;
  const candidateId = approval.candidate_action['id'];
  if (typeof candidateId !== 'string' || !UUID.test(candidateId)) return null;
  const candidate = (await client.query<CandidateActionRow>(
    'SELECT * FROM candidate_actions WHERE id = $1 AND decision_id = $2',
    [candidateId, decision.id],
  )).rows[0];
  if (!candidate) return null;
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(approval, candidate);
  const rawEvent = decision.raw_event;
  if (!messageRefId ||
      !exactKeys(rawEvent, ['source', 'type', 'signalId', 'messageRefId', 'authoringTier']) ||
      rawEvent['source'] !== 'gmail' || rawEvent['signalId'] !== decision.signal_id ||
      rawEvent['messageRefId'] !== messageRefId) return null;
  const evidence = await client.query<SignalRow>(
    `SELECT signal.*
       FROM signals AS signal
       JOIN gmail_message_refs AS ref
         ON ref.id = signal.resource_ref_id
        AND ref.id = $3
        AND ref.user_id = signal.user_id
        AND ref.connector_account_id = signal.connector_account_id
        AND ref.source_signal_id = signal.source_signal_id
      WHERE signal.id::STRING = $2 AND signal.user_id = $1
        AND signal.source = 'gmail' AND ref.provider = 'google'
        AND ref.authoring_tier = $4 AND signal.type = $5
      LIMIT 2`,
    [input.userId, decision.signal_id, messageRefId, rawEvent['authoringTier'], rawEvent['type']],
  );
  if (evidence.rows.length !== 1) return null;
  const signal = evidence.rows[0]!;
  const outcomes = await client.query<DecisionOutcomeRow>(
    `SELECT * FROM decision_outcomes
      WHERE decision_id = $1 AND selected_action_id = $2
        AND auto_executed = false AND requires_approval = true`,
    [decision.id, candidate.id],
  );
  if (outcomes.rows.length !== 1) return null;
  const outcome = outcomes.rows[0]!;
  if (options.allowExecutionPlan !== true && outcome.execution_plan_id !== null) return null;
  const barriers = await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND decision_id = $2 AND action_id = $3
        AND effect_type = 'event_execution' AND idempotency_key = $2::STRING
        AND status = 'blocked' AND failure_reason = 'proposal_only_boundary'
      ${lock}`,
    [input.userId, decision.id, candidate.id],
  );
  if (barriers.rows.length !== 1) return null;
  const proposalBarrier = barriers.rows[0]!;
  if (!exactKeys(proposalBarrier.effect_result, ['proposalOnly', 'dispatched']) ||
      proposalBarrier.effect_result['proposalOnly'] !== true ||
      proposalBarrier.effect_result['dispatched'] !== false ||
      proposalBarrier.explanation_id === null) return null;
  const explanation = (await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
    [proposalBarrier.explanation_id, decision.id],
  )).rows[0];
  if (!explanation ||
      explanation.action_rationale !== approval.candidate_action['reasoning']) return null;
  const receipt = (await client.query<DecisionReceiptRow>(
    'SELECT * FROM decision_receipts WHERE user_id = $1 AND decision_id = $2',
    [input.userId, decision.id],
  )).rows[0];
  if (!receipt) return null;
  const rawRevisions = (await client.query<DecisionReceiptRevisionRow>(
    'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
    [receipt.id],
  )).rows;
  const normalizedRevisions = rawRevisions.map(normalizeDecisionReceiptRevisionRow);
  if (normalizedRevisions.some((revision) => revision === null)) return null;
  const revisions = normalizedRevisions as DecisionReceiptRevisionRow[];
  return {
    approval,
    decision,
    candidate,
    outcome,
    explanation,
    signal,
    proposalBarrier,
    receipt,
    revisions,
    unexpired: lockedApproval!.unexpired,
  };
}

export async function loadCanonicalGmailArchiveApprovalState(
  client: PoolClient,
  input: RespondGmailArchiveApprovalInput,
  options: LoadCanonicalGmailArchiveApprovalStateOptions = {},
): Promise<GmailArchiveApprovalCanonicalState | null> {
  return loadCanonicalGmailArchiveApprovalStateWithLockMode(client, input, options, true);
}

/** DB-internal SELECT-only canonical graph load for the unwired status reader. */
export async function loadCanonicalGmailArchiveApprovalStateReadOnly(
  client: PoolClient,
  input: RespondGmailArchiveApprovalInput,
  options: LoadCanonicalGmailArchiveApprovalStateOptions = {},
): Promise<GmailArchiveApprovalCanonicalState | null> {
  return loadCanonicalGmailArchiveApprovalStateWithLockMode(client, input, options, false);
}

function exactReservedBarrier(
  barrier: PreEffectBarrierRow,
  input: RespondGmailArchiveApprovalInput,
): boolean {
  return barrier.user_id === input.userId &&
    barrier.effect_type === 'event_execution' &&
    barrier.idempotency_key === input.approvalId &&
    barrier.status === 'reserved' &&
    barrier.decision_id === null &&
    barrier.action_id === null &&
    barrier.explanation_id === null &&
    exactKeys(barrier.policy_snapshot, []) &&
    exactKeys(barrier.effect_result, []) &&
    barrier.failure_reason === null;
}

function fail(result: RespondGmailArchiveApprovalResult): never {
  throw new RollbackResult(result);
}

async function transition(
  client: PoolClient,
  input: RespondGmailArchiveApprovalInput,
  ids: GmailArchiveApprovalResponseStableIds,
): Promise<RespondGmailArchiveApprovalResult> {
  const state = await loadCanonicalGmailArchiveApprovalState(client, input);
  if (!state) return { ok: false, error: 'not_found' };

  if (state.approval.status !== 'pending') {
    if (state.approval.status !== 'approved' && state.approval.status !== 'rejected') {
      return { ok: false, error: 'not_pending_or_expired' };
    }
    if (!sameResponse(state.approval, input) ||
        !canonicalGmailArchiveApprovalContent(state, input.action === 'approve' ? 'approved' : 'rejected')) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    const reserved = (await client.query<PreEffectBarrierRow>(
      `SELECT * FROM pre_effect_barriers
        WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2`,
      [input.userId, input.approvalId],
    )).rows;
    if ((input.action === 'approve' &&
         (reserved.length !== 1 || !exactReservedBarrier(reserved[0]!, input))) ||
        (input.action === 'reject' && reserved.length !== 0)) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    const feedbackRows = await loadApprovalFeedback(client, input.approvalId);
    if (feedbackRows.length !== 1 ||
        !exactApprovalFeedback(
          feedbackRows[0]!.feedback,
          state.approval,
          input,
          feedbackRows[0]!.responseTimestampMatches,
        )) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    return {
      ok: true,
      created: false,
      response: {
        approval: state.approval,
        feedback: feedbackRows[0]!.feedback,
        proposalBarrier: state.proposalBarrier,
        reservedBarrier: reserved[0] ?? null,
        receipt: state.receipt,
        revisions: state.revisions,
      },
    };
  }

  if (!state.unexpired) return { ok: false, error: 'not_pending_or_expired' };
  const pendingContent = canonicalGmailArchiveApprovalContent(state, 'requires_approval');
  if (!pendingContent) return { ok: false, error: 'idempotency_conflict' };
  const priorReservation = await client.query<{ id: string }>(
    `SELECT id FROM pre_effect_barriers
      WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2`,
    [input.userId, input.approvalId],
  );
  if (priorReservation.rows.length !== 0) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  if ((await loadApprovalFeedback(client, input.approvalId)).length !== 0) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const updatedApproval = (await client.query<ApprovalRequestRow>(
    `UPDATE approval_requests
        SET status = $1, responded_at = now(), response = $2, confirmation_token = NULL
      WHERE id = $3 AND user_id = $4 AND status = 'pending' AND expires_at > now()
      RETURNING *`,
    [
      input.action === 'approve' ? 'approved' : 'rejected',
      JSON.stringify({ action: input.action, reason: input.reason ?? null }),
      input.approvalId,
      input.userId,
    ],
  )).rows[0];
  if (!updatedApproval) return { ok: false, error: 'not_pending_or_expired' };
  const insertedFeedback = (await client.query<FeedbackEventRow>(
    `INSERT INTO feedback_events (
       id, user_id, decision_id, approval_request_id, type, data
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      ids.feedback,
      input.userId,
      updatedApproval.decision_id,
      updatedApproval.id,
      input.action,
      JSON.stringify({ reason: input.reason ?? null }),
    ],
  )).rows[0];
  const feedbackRows = await loadApprovalFeedback(client, input.approvalId);
  const feedback = feedbackRows[0]?.feedback;
  if (!insertedFeedback || insertedFeedback.id !== ids.feedback || feedbackRows.length !== 1 ||
      !feedback || feedback.id !== insertedFeedback.id ||
      !exactApprovalFeedback(
        feedback,
        updatedApproval,
        input,
        feedbackRows[0]!.responseTimestampMatches,
      )) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  const responseContent: JoinedDecisionReceiptContentV1 = {
    ...pendingContent,
    stage: 'approval_recorded',
    disposition: input.action === 'approve' ? 'approved' : 'rejected',
    approvalRequest: decisionReceiptApprovalRefV1(updatedApproval),
  };
  const appended = await decisionReceiptLifecycleRepository.appendForUser(client, input.userId, {
    eventKind: 'approval_responded',
    eventId: updatedApproval.id,
    expectedPreviousDigest: state.revisions.at(-1)!.revision_digest,
    content: responseContent,
    revisionId: ids.revision,
  });
  if (!appended.success) fail({ ok: false, error: 'idempotency_conflict' });

  let reservedBarrier: PreEffectBarrierRow | null = null;
  if (input.action === 'approve') {
    reservedBarrier = (await client.query<PreEffectBarrierRow>(
      `INSERT INTO pre_effect_barriers (id, user_id, effect_type, idempotency_key, status)
       VALUES ($1, $2, 'event_execution', $3, 'reserved')
       ON CONFLICT (user_id, effect_type, idempotency_key) DO NOTHING
       RETURNING *`,
      [ids.barrier, input.userId, updatedApproval.id],
    )).rows[0] ?? null;
    if (!reservedBarrier || !exactReservedBarrier(reservedBarrier, input)) {
      fail({ ok: false, error: 'idempotency_conflict' });
    }
  }
  return {
    ok: true,
    created: true,
    response: {
      approval: updatedApproval,
      feedback,
      proposalBarrier: state.proposalBarrier,
      reservedBarrier,
      receipt: appended.receipt,
      revisions: [...state.revisions, appended.revision],
    },
  };
}

export const gmailArchiveApprovalResponseRepository = {
  async respond(
    input: RespondGmailArchiveApprovalInput,
  ): Promise<RespondGmailArchiveApprovalResult> {
    return respondWithTransition(input, transition);
  },
};

async function respondWithTransition(
  input: RespondGmailArchiveApprovalInput,
  runTransition: GmailArchiveApprovalResponseTransition,
): Promise<RespondGmailArchiveApprovalResult> {
  const snapshot = snapshotInput(input);
  if (!snapshot) return { ok: false, error: 'invalid_input' };
  const ids: GmailArchiveApprovalResponseStableIds = {
    barrier: randomUUID(),
    feedback: randomUUID(),
    revision: randomUUID(),
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction((client) => runTransition(client, snapshot, ids));
    } catch (error) {
      if (error instanceof RollbackResult) return error.result;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

export const gmailArchiveApprovalResponseTestHooks = Object.freeze({
  respondWithTransition,
  transition,
});
