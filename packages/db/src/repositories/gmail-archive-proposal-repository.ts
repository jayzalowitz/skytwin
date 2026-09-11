import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ConfidenceLevel,
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  RiskDimension,
  RiskTier,
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  verifyJoinedDecisionReceiptChain,
  type CandidateAction,
  type DimensionAssessment,
  type JoinedDecisionReceiptContentV1,
  type RiskAssessment,
} from '@skytwin/shared-types';
import { withTransaction } from '../connection.js';
import type {
  ApprovalRequestRow,
  CandidateActionRow,
  DecisionOutcomeRow,
  DecisionReceiptRevisionRow,
  DecisionReceiptRow,
  DecisionRow,
  ExplanationRecordRow,
  SignalRow,
} from '../types.js';
import {
  buildDecisionRecordedReceiptContentV1,
  decisionReceiptLifecycleRepository,
} from './decision-receipt-lifecycle.js';
import {
  decisionReceiptApprovalRefV1,
  decisionReceiptBarrierRefV1,
  decisionReceiptRowArtifactRefV1,
  decisionReceiptRowEvidenceRefV1,
} from './decision-receipt-artifacts.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PROPOSAL_REASON = 'Review is required. This build records the proposal without enabling execution.';
const CANDIDATE_DESCRIPTION = 'Archive this Inbox message';
const CANDIDATE_REASONING = 'The owned Inbox signal is eligible for a reversible archive proposal.';

interface BoundGmailSignalRow extends SignalRow {
  authoring_tier: string;
}

export interface PersistGmailArchiveProposalInput {
  userId: string;
  connectorAccountId: string;
  messageRefId: string;
  /** UUID primary key of the already-persisted signals row. */
  signalId: string;
  /** Reviewed assessment output; persistence only binds its generated action ID. */
  riskAssessment: GmailArchiveProposalRiskInput;
}

export interface GmailArchiveProposalRiskInput {
  overallTier: RiskTier;
  dimensions: Record<RiskDimension, DimensionAssessment>;
  reasoning: string;
  assessedAt: Date;
}

export interface GmailArchiveProposalBundle {
  decision: DecisionRow;
  candidate: CandidateActionRow;
  outcome: DecisionOutcomeRow;
  explanation: ExplanationRecordRow;
  barrier: PreEffectBarrierRow;
  approval: ApprovalRequestRow;
  receipt: DecisionReceiptRow;
  revisions: [DecisionReceiptRevisionRow, DecisionReceiptRevisionRow, DecisionReceiptRevisionRow];
}

export type PersistGmailArchiveProposalResult =
  | { ok: true; created: boolean; proposal: GmailArchiveProposalBundle }
  | { ok: false; error: 'invalid_input' | 'evidence_not_found' | 'idempotency_conflict' };

export class GmailArchiveProposalReceiptError extends Error {
  constructor(readonly code: string) {
    super(`Gmail archive proposal receipt append failed: ${code}`);
  }
}

interface PreallocatedIds {
  decision: string;
  candidate: string;
  outcome: string;
  explanation: string;
  barrier: string;
  approval: string;
  receipt: string;
  revisions: [string, string, string];
}

function preallocateIds(): PreallocatedIds {
  return {
    decision: randomUUID(),
    candidate: randomUUID(),
    outcome: randomUUID(),
    explanation: randomUUID(),
    barrier: randomUUID(),
    approval: randomUUID(),
    receipt: randomUUID(),
    revisions: [randomUUID(), randomUUID(), randomUUID()],
  };
}

function candidateParameters(messageRefId: string): Record<string, unknown> {
  return {
    schema: GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
    messageRefId,
    operation: 'archive',
    domain: 'email',
    costZeroIntent: 'verified_zero',
    provenance: 'untrusted_external',
  };
}

export function buildGmailArchiveProposalCandidate(
  decisionId: string,
  candidateId: string,
  messageRefId: string,
): CandidateAction {
  return {
    id: candidateId,
    decisionId,
    actionType: 'archive_email',
    description: CANDIDATE_DESCRIPTION,
    domain: 'email',
    parameters: candidateParameters(messageRefId),
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: ConfidenceLevel.MODERATE,
    reasoning: CANDIDATE_REASONING,
    provenance: 'untrusted_external',
  };
}

function completeRisk(
  candidate: CandidateAction,
  input: GmailArchiveProposalRiskInput,
): Record<string, unknown> {
  const normalized: RiskAssessment = {
    actionId: candidate.id,
    overallTier: input.overallTier,
    dimensions: input.dimensions,
    reasoning: input.reasoning,
    assessedAt: input.assessedAt,
  };
  return {
    actionId: normalized.actionId,
    overallTier: normalized.overallTier,
    dimensions: normalized.dimensions,
    reasoning: normalized.reasoning,
    assessedAt: normalized.assessedAt.toISOString(),
  };
}

function snapshotRisk(value: unknown): GmailArchiveProposalRiskInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'assessedAt,dimensions,overallTier,reasoning' ||
      !Object.values(RiskTier).includes(record['overallTier'] as RiskTier) ||
      typeof record['reasoning'] !== 'string' || record['reasoning'].length === 0 ||
      !(record['assessedAt'] instanceof Date) || !Number.isFinite(record['assessedAt'].getTime()) ||
      !record['dimensions'] || typeof record['dimensions'] !== 'object' ||
      Array.isArray(record['dimensions'])) return null;
  const dimensions = record['dimensions'] as Record<string, unknown>;
  if (Object.keys(dimensions).sort().join(',') !== Object.values(RiskDimension).sort().join(',')) return null;
  const copied = {} as Record<RiskDimension, DimensionAssessment>;
  for (const dimension of Object.values(RiskDimension)) {
    const raw = dimensions[dimension];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'reasoning,score,tier' ||
        !Object.values(RiskTier).includes(item['tier'] as RiskTier) ||
        typeof item['score'] !== 'number' || !Number.isFinite(item['score']) ||
        item['score'] < 0 || item['score'] > 1 ||
        typeof item['reasoning'] !== 'string' || item['reasoning'].length === 0) return null;
    copied[dimension] = {
      tier: item['tier'] as RiskTier,
      score: item['score'],
      reasoning: item['reasoning'],
    };
  }
  return Object.freeze({
    overallTier: record['overallTier'] as RiskTier,
    dimensions: Object.freeze(copied),
    reasoning: record['reasoning'],
    assessedAt: new Date(record['assessedAt'].getTime()),
  });
}

function confidenceForRisk(value: unknown): number {
  const map: Record<RiskTier, number> = {
    [RiskTier.NEGLIGIBLE]: 1,
    [RiskTier.LOW]: 0.8,
    [RiskTier.MODERATE]: 0.6,
    [RiskTier.HIGH]: 0.4,
    [RiskTier.CRITICAL]: 0.2,
  };
  return map[value as RiskTier] ?? 0.2;
}

function approvalCandidate(candidate: CandidateAction): Record<string, unknown> {
  return {
    id: candidate.id,
    decisionId: candidate.decisionId,
    actionType: candidate.actionType,
    description: candidate.description,
    domain: candidate.domain,
    parameters: candidate.parameters,
    estimatedCostCents: candidate.estimatedCostCents,
    costZeroIntent: candidate.costZeroIntent,
    reversible: candidate.reversible,
    confidence: candidate.confidence,
    reasoning: candidate.reasoning,
    provenance: candidate.provenance,
  };
}

function policySnapshot(candidateId: string, risk: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    mode: 'proposal_only',
    allowed: true,
    requiresApproval: true,
    reason: PROPOSAL_REASON,
    policyIds: [],
    candidateActionId: candidateId,
    riskAssessment: risk,
  };
}

function policyAndApprovalContents(rows: {
  decision: DecisionRow;
  candidate: CandidateActionRow;
  explanation: ExplanationRecordRow;
  barrier: PreEffectBarrierRow;
  approval: ApprovalRequestRow;
  signal: SignalRow;
}): [JoinedDecisionReceiptContentV1, JoinedDecisionReceiptContentV1, JoinedDecisionReceiptContentV1] {
  const decisionRecorded = buildDecisionRecordedReceiptContentV1(rows.decision);
  const candidateAction = decisionReceiptRowArtifactRefV1('candidate_action', { ...rows.candidate });
  const risk = {
    candidateActionId: rows.candidate.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('risk', rows.candidate.risk_assessment),
  };
  const explanation = decisionReceiptRowArtifactRefV1('explanation', { ...rows.explanation });
  const barrier = decisionReceiptBarrierRefV1(rows.barrier);
  const policy = {
    barrierId: rows.barrier.id,
    policyIds: [] as string[],
    canonicalHash: joinedDecisionReceiptArtifactDigest('policy', rows.barrier.policy_snapshot),
  };
  const evidence = [decisionReceiptRowEvidenceRefV1('signal', { ...rows.signal })];
  const evaluation = {
    version: 1 as const,
    phase: 'pre_effect' as const,
    disposition: 'requires_approval' as const,
    candidateAction,
    risk,
    policy,
    barrier,
    explanation,
    evidence,
  };
  const policyEvaluated: JoinedDecisionReceiptContentV1 = {
    ...decisionRecorded,
    stage: 'policy_evaluated',
    disposition: 'requires_approval',
    policyEvaluations: [evaluation],
    evidence,
    candidateAction,
    risk,
    policy,
    barrier,
    explanation,
  };
  const approvalRecorded: JoinedDecisionReceiptContentV1 = {
    ...policyEvaluated,
    stage: 'approval_recorded',
    approvalRequest: decisionReceiptApprovalRefV1(rows.approval),
  };
  return [decisionRecorded, policyEvaluated, approvalRecorded];
}

async function loadBoundSignal(
  client: PoolClient,
  input: PersistGmailArchiveProposalInput,
): Promise<BoundGmailSignalRow | null> {
  const result = await client.query<BoundGmailSignalRow>(
    `SELECT signal.*, ref.authoring_tier
       FROM signals AS signal
       JOIN gmail_message_refs AS ref
         ON ref.id = signal.resource_ref_id
        AND ref.id = $3
        AND ref.user_id = signal.user_id
        AND ref.connector_account_id = signal.connector_account_id
        AND ref.source_signal_id = signal.source_signal_id
       JOIN connected_accounts AS account
         ON account.id = ref.connector_account_id
        AND account.user_id = ref.user_id
        AND account.provider = ref.provider
      WHERE signal.id = $4 AND signal.user_id = $1
        AND signal.source = 'gmail'
        AND signal.connector_account_id = $2
        AND ref.provider = 'google'
        AND ref.last_observed_inbox = true
        AND account.is_active = true
        AND account.identity_verified = true
      LIMIT 2`,
    [input.userId, input.connectorAccountId, input.messageRefId, input.signalId],
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}

function exactCandidateMatches(
  row: CandidateActionRow,
  expected: CandidateAction,
  risk: Record<string, unknown>,
): boolean {
  const expectedRow = {
    id: row.id,
    decision_id: row.decision_id,
    action_type: expected.actionType,
    description: expected.description,
    parameters: expected.parameters,
    predicted_user_preference: expected.confidence,
    risk_assessment: risk,
    reversible: true,
    estimated_cost: null,
  };
  return decisionReceiptRowArtifactRefV1('candidate_action', { ...row }).canonicalHash ===
    decisionReceiptRowArtifactRefV1('candidate_action', expectedRow).canonicalHash;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return joinedDecisionReceiptArtifactDigest('policy', left) ===
    joinedDecisionReceiptArtifactDigest('policy', right);
}

function exactDecisionMatches(row: DecisionRow, signal: BoundGmailSignalRow, messageRefId: string): boolean {
  const expected = {
    id: row.id,
    user_id: row.user_id,
    situation_type: 'email_triage',
    raw_event: {
      source: 'gmail',
      type: signal.type,
      signalId: signal.source_signal_id,
      messageRefId,
      authoringTier: signal.authoring_tier,
    },
    interpreted_situation: { summary: 'An Inbox message may be archived.' },
    domain: 'email',
    urgency: 'normal',
    metadata: { proposalOnly: true },
    signal_id: signal.source_signal_id,
  };
  return decisionReceiptRowArtifactRefV1('decision', { ...row }).canonicalHash ===
    decisionReceiptRowArtifactRefV1('decision', expected).canonicalHash;
}

async function loadExistingBundle(
  client: PoolClient,
  input: PersistGmailArchiveProposalInput,
  decision: DecisionRow,
  signal: BoundGmailSignalRow,
): Promise<GmailArchiveProposalBundle | null> {
  // A pg PoolClient is single-flight; keep replay reads serial inside the
  // caller-owned transaction (pg 9 removes overlapping client.query calls).
  const candidateResult = await client.query<CandidateActionRow>(
    'SELECT * FROM candidate_actions WHERE decision_id = $1 ORDER BY created_at, id',
    [decision.id],
  );
  const outcomeResult = await client.query<DecisionOutcomeRow>(
    'SELECT * FROM decision_outcomes WHERE decision_id = $1',
    [decision.id],
  );
  const explanationResult = await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE decision_id = $1 ORDER BY created_at, id',
    [decision.id],
  );
  const barrierResult = await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2`,
    [input.userId, decision.id],
  );
  const approvalResult = await client.query<ApprovalRequestRow>(
    'SELECT * FROM approval_requests WHERE user_id = $1 AND decision_id = $2',
    [input.userId, decision.id],
  );
  const receiptResult = await client.query<DecisionReceiptRow>(
    'SELECT * FROM decision_receipts WHERE user_id = $1 AND decision_id = $2',
    [input.userId, decision.id],
  );
  if ([candidateResult, outcomeResult, explanationResult, barrierResult, approvalResult, receiptResult]
    .some((result) => result.rows.length !== 1)) return null;

  const candidate = candidateResult.rows[0]!;
  const outcome = outcomeResult.rows[0]!;
  const explanation = explanationResult.rows[0]!;
  const barrier = barrierResult.rows[0]!;
  const approval = approvalResult.rows[0]!;
  const receipt = receiptResult.rows[0]!;
  const expectedCandidate = buildGmailArchiveProposalCandidate(decision.id, candidate.id, input.messageRefId);
  const expectedRisk = completeRisk(expectedCandidate, input.riskAssessment);
  const expectedEvidence = [{
    evidenceId: signal.id,
    source: 'gmail',
    summary: 'Owned Inbox signal',
    relevance: 'The owned signal directly produced this proposal.',
  }];
  const expectedPolicy = policySnapshot(candidate.id, expectedRisk);
  const revisionsResult = await client.query<DecisionReceiptRevisionRow>(
    'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
    [receipt.id],
  );
  if (revisionsResult.rows.length !== 3 ||
      !exactDecisionMatches(decision, signal, input.messageRefId) ||
      !exactCandidateMatches(candidate, expectedCandidate, expectedRisk) ||
      outcome.selected_action_id !== candidate.id || outcome.auto_executed || !outcome.requires_approval ||
      outcome.execution_plan_id !== null || outcome.escalation_reason !== PROPOSAL_REASON ||
      outcome.explanation !== PROPOSAL_REASON || outcome.confidence !== confidenceForRisk(expectedRisk['overallTier']) ||
      explanation.decision_id !== decision.id ||
      explanation.what_happened !== 'Prepared a review-only Inbox archive proposal; no external action was attempted.' ||
      !sameCanonical(explanation.evidence_used, expectedEvidence) ||
      !sameCanonical(explanation.preferences_invoked, []) ||
      explanation.confidence_reasoning !== String(expectedRisk['reasoning']) ||
      explanation.action_rationale !== CANDIDATE_REASONING ||
      explanation.escalation_rationale !== PROPOSAL_REASON ||
      explanation.correction_guidance !== 'Review the proposal. This build does not turn approval into execution.' ||
      explanation.capability_provenance_node_id !== null ||
      barrier.status !== 'blocked' || barrier.decision_id !== decision.id || barrier.action_id !== candidate.id ||
      barrier.explanation_id !== explanation.id || barrier.idempotency_key !== decision.id ||
      !sameCanonical(barrier.policy_snapshot, expectedPolicy) ||
      !sameCanonical(barrier.effect_result, { proposalOnly: true, dispatched: false }) ||
      barrier.failure_reason !== 'proposal_only_boundary' ||
      approval.status !== 'pending' || approval.decision_id !== decision.id ||
      !sameCanonical(approval.candidate_action, approvalCandidate(expectedCandidate)) ||
      approval.reason !== PROPOSAL_REASON || approval.urgency !== 'normal' ||
      approval.confirmation_level !== 'single' || approval.responded_at !== null) return null;
  if (approval.response !== null || approval.batch_id !== null || approval.first_confirmed_at !== null ||
      approval.confirmation_token !== null ||
      approval.expires_at.getTime() - approval.requested_at.getTime() !== APPROVAL_WINDOW_MS) return null;

  const contents = policyAndApprovalContents({
    decision, candidate, explanation, barrier, approval, signal,
  });
  const revisions = revisionsResult.rows;
  const expectedKeys = [
    buildDecisionReceiptEventKey('decision_created', decision.id),
    buildDecisionReceiptEventKey('policy_evaluated', barrier.id),
    buildDecisionReceiptEventKey('approval_created', approval.id),
  ];
  if (revisions.some((revision, index) =>
    revision.event_key !== expectedKeys[index] ||
    revision.content_digest !== joinedDecisionReceiptContentDigest(contents[index]!) ||
    revision.trusted !== true
  ) || !verifyJoinedDecisionReceiptChain({
    receiptId: receipt.id,
    decisionId: decision.id,
    userId: input.userId,
    revisions,
  })) return null;

  return {
    decision,
    candidate,
    outcome,
    explanation,
    barrier,
    approval,
    receipt,
    revisions: revisions as GmailArchiveProposalBundle['revisions'],
  };
}

async function insertFreshBundle(
  client: PoolClient,
  input: PersistGmailArchiveProposalInput,
  signal: BoundGmailSignalRow,
  ids: PreallocatedIds,
): Promise<GmailArchiveProposalBundle | null> {
  const decisionResult = await client.query<DecisionRow>(
    `INSERT INTO decisions (
       id, user_id, situation_type, raw_event, interpreted_situation,
       domain, urgency, metadata, signal_id
     ) VALUES ($1, $2, 'email_triage', $3, $4, 'email', 'normal', $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      ids.decision,
      input.userId,
      JSON.stringify({
        source: 'gmail',
        type: signal.type,
        signalId: signal.source_signal_id,
        messageRefId: input.messageRefId,
        authoringTier: signal.authoring_tier,
      }),
      JSON.stringify({ summary: 'An Inbox message may be archived.' }),
      JSON.stringify({ proposalOnly: true }),
      signal.source_signal_id,
    ],
  );
  if (!decisionResult.rows[0]) {
    const existing = await client.query<DecisionRow>(
      'SELECT * FROM decisions WHERE user_id = $1 AND signal_id = $2',
      [input.userId, signal.source_signal_id],
    );
    if (existing.rows.length !== 1) return null;
    return loadExistingBundle(client, input, existing.rows[0]!, signal);
  }
  const decision = decisionResult.rows[0];
  const candidate = buildGmailArchiveProposalCandidate(decision.id, ids.candidate, input.messageRefId);
  const risk = completeRisk(candidate, input.riskAssessment);
  const candidateResult = await client.query<CandidateActionRow>(
    `INSERT INTO candidate_actions (
       id, decision_id, action_type, description, parameters,
       predicted_user_preference, risk_assessment, reversible, estimated_cost
     ) VALUES ($1, $2, 'archive_email', $3, $4, $5, $6, true, NULL)
     RETURNING *`,
    [
      ids.candidate,
      decision.id,
      candidate.description,
      JSON.stringify(candidate.parameters),
      candidate.confidence,
      JSON.stringify(risk),
    ],
  );
  const candidateRow = candidateResult.rows[0]!;
  const outcomeResult = await client.query<DecisionOutcomeRow>(
    `INSERT INTO decision_outcomes (
       id, decision_id, selected_action_id, auto_executed, requires_approval,
       escalation_reason, explanation, confidence
     ) VALUES ($1, $2, $3, false, true, $4, $4, $5)
     RETURNING *`,
    [ids.outcome, decision.id, candidateRow.id, PROPOSAL_REASON, confidenceForRisk(risk['overallTier'])],
  );
  const explanationResult = await client.query<ExplanationRecordRow>(
    `INSERT INTO explanation_records (
       id, decision_id, what_happened, evidence_used, preferences_invoked,
       confidence_reasoning, action_rationale, escalation_rationale,
       correction_guidance, capability_provenance_node_id
     ) VALUES ($1, $2, $3, $4, ARRAY[]::STRING[], $5, $6, $7, $8, NULL)
     RETURNING *`,
    [
      ids.explanation,
      decision.id,
      'Prepared a review-only Inbox archive proposal; no external action was attempted.',
      JSON.stringify([{
        evidenceId: signal.id,
        source: 'gmail',
        summary: 'Owned Inbox signal',
        relevance: 'The owned signal directly produced this proposal.',
      }]),
      String(risk['reasoning']),
      CANDIDATE_REASONING,
      PROPOSAL_REASON,
      'Review the proposal. This build does not turn approval into execution.',
    ],
  );
  const explanation = explanationResult.rows[0]!;
  const snapshot = policySnapshot(candidateRow.id, risk);
  const barrierResult = await client.query<PreEffectBarrierRow>(
    `INSERT INTO pre_effect_barriers (
       id, user_id, effect_type, idempotency_key, status, decision_id,
       action_id, explanation_id, policy_snapshot, effect_result, failure_reason
     ) VALUES ($1, $2, 'event_execution', $3, 'blocked', $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      ids.barrier,
      input.userId,
      decision.id,
      decision.id,
      candidateRow.id,
      explanation.id,
      JSON.stringify(snapshot),
      JSON.stringify({ proposalOnly: true, dispatched: false }),
      'proposal_only_boundary',
    ],
  );
  const barrier = barrierResult.rows[0]!;
  const approvalResult = await client.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests (
       id, user_id, decision_id, candidate_action, reason, urgency, status,
       requested_at, expires_at, confirmation_level
     ) VALUES (
       $1, $2, $3, $4, $5, 'normal', 'pending', now(),
       now() + ($6::INT8 * INTERVAL '1 millisecond'), 'single'
     )
     RETURNING *`,
    [
      ids.approval,
      input.userId,
      decision.id,
      JSON.stringify(approvalCandidate(candidate)),
      PROPOSAL_REASON,
      APPROVAL_WINDOW_MS,
    ],
  );
  const approval = approvalResult.rows[0]!;
  const contents = policyAndApprovalContents({
    decision,
    candidate: candidateRow,
    explanation,
    barrier,
    approval,
    signal,
  });
  const lifecycleInputs = [
    { eventKind: 'decision_created', eventId: decision.id, expectedPreviousDigest: null },
    { eventKind: 'policy_evaluated', eventId: barrier.id, expectedPreviousDigest: null },
    { eventKind: 'approval_created', eventId: approval.id, expectedPreviousDigest: null },
  ] as const;
  const revisions: DecisionReceiptRevisionRow[] = [];
  let receipt: DecisionReceiptRow | null = null;
  let previousDigest: string | null = null;
  for (let index = 0; index < contents.length; index += 1) {
    const append = await decisionReceiptLifecycleRepository.appendForUser(client, input.userId, {
      ...lifecycleInputs[index]!,
      expectedPreviousDigest: previousDigest,
      content: contents[index]!,
      receiptId: ids.receipt,
      revisionId: ids.revisions[index],
    });
    if (!append.success) throw new GmailArchiveProposalReceiptError(append.code);
    receipt = append.receipt;
    revisions.push(append.revision);
    previousDigest = append.revision.revision_digest;
  }
  return {
    decision,
    candidate: candidateRow,
    outcome: outcomeResult.rows[0]!,
    explanation,
    barrier,
    approval,
    receipt: receipt!,
    revisions: revisions as GmailArchiveProposalBundle['revisions'],
  };
}

async function persistInTransaction(
  client: PoolClient,
  input: PersistGmailArchiveProposalInput,
  ids: PreallocatedIds,
): Promise<PersistGmailArchiveProposalResult> {
  const signal = await loadBoundSignal(client, input);
  if (!signal || !signal.source_signal_id) return { ok: false, error: 'evidence_not_found' };
  const proposal = await insertFreshBundle(client, input, signal, ids);
  if (!proposal) return { ok: false, error: 'idempotency_conflict' };
  return { ok: true, created: proposal.decision.id === ids.decision, proposal };
}

export const gmailArchiveProposalRepository = {
  async persist(input: PersistGmailArchiveProposalInput): Promise<PersistGmailArchiveProposalResult> {
    if (![input.userId, input.connectorAccountId, input.messageRefId, input.signalId]
      .every((value) => typeof value === 'string' && UUID.test(value))) {
      return { ok: false, error: 'invalid_input' };
    }
    const riskAssessment = snapshotRisk(input.riskAssessment);
    if (!riskAssessment) return { ok: false, error: 'invalid_input' };
    const snapshot = Object.freeze({ ...input, riskAssessment });
    const ids = preallocateIds();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await withTransaction((client) => persistInTransaction(client, snapshot, ids));
      } catch (error) {
        lastError = error;
        if ((error as { code?: unknown } | null)?.code !== '40001' || attempt === 2) throw error;
      }
    }
    throw lastError;
  },
};
