import { randomUUID } from 'node:crypto';
import {
  DEFAULT_POLICIES,
  PolicyEvaluator,
  type PolicyDecision,
  type PolicyRepositoryPort,
} from '@skytwin/policy-engine';
import {
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  RiskDimension,
  RiskTier,
  TrustTier,
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  parseAutonomySettings,
  verifyJoinedDecisionReceiptChain,
  type ActionPolicy,
  type CandidateAction,
  type DecisionReceiptExecutionPlanRef,
  type JoinedDecisionReceiptContentV1,
  type RiskAssessment,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type {
  ActionPolicyRow,
  DecisionReceiptRevisionRow,
  DecisionReceiptRow,
  ExecutionPlanRow,
  ExplanationRecordRow,
  UserRow,
} from '../types.js';
import { actionPolicyRowToDomain } from '../adapters/policy-repository-adapter.js';
import {
  decisionReceiptApprovalRefV1,
  decisionReceiptBarrierRefV1,
  decisionReceiptRowArtifactRefV1,
  decisionReceiptRowEvidenceRefV1,
} from './decision-receipt-artifacts.js';
import { decisionReceiptLifecycleRepository } from './decision-receipt-lifecycle.js';
import {
  canonicalGmailArchiveApprovalContent,
  loadCanonicalGmailArchiveApprovalState,
  type GmailArchiveApprovalCanonicalState,
} from './gmail-archive-approval-response-repository.js';
import {
  inspectGmailArchiveApprovalFeedbackApplication,
} from './gmail-archive-feedback-application-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLICY_BLOCKED = 'post_approval_policy_blocked';
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export interface PrepareGmailArchiveInput {
  userId: string;
  approvalId: string;
}

export interface GmailArchivePreparationBundle {
  status: 'prepared' | 'blocked';
  barrier: PreEffectBarrierRow;
  explanation: ExplanationRecordRow;
  plan: ExecutionPlanRow | null;
  receipt: DecisionReceiptRow;
  revisions: DecisionReceiptRevisionRow[];
}

export type PrepareGmailArchiveResult =
  | { ok: true; created: boolean; preparation: GmailArchivePreparationBundle }
  | { ok: false; error: 'invalid_input' | 'not_found' | 'not_ready' | 'idempotency_conflict' | 'policy_invariant' };

export interface GmailArchivePreparationStableIds {
  explanation: string;
  plan: string;
  policyRevision: string;
  admissionRevision: string;
}

export type GmailArchivePreparationTransition = (
  client: PoolClient,
  input: PrepareGmailArchiveInput,
  ids: Readonly<GmailArchivePreparationStableIds>,
) => Promise<PrepareGmailArchiveResult>;

class RollbackResult extends Error {
  constructor(readonly result: PrepareGmailArchiveResult) {
    super('Gmail archive preparation rolled back');
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

function snapshotInput(value: unknown): Readonly<PrepareGmailArchiveInput> | null {
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

export function exactReservedGmailArchiveBarrier(
  barrier: PreEffectBarrierRow,
  input: PrepareGmailArchiveInput,
): boolean {
  return barrier.user_id === input.userId && barrier.effect_type === 'event_execution' &&
    barrier.idempotency_key === input.approvalId && barrier.status === 'reserved' &&
    barrier.decision_id === null && barrier.action_id === null && barrier.explanation_id === null &&
    ownData(barrier.policy_snapshot, []) !== null && ownData(barrier.effect_result, []) !== null &&
    barrier.failure_reason === null;
}

/** DB-internal canonical projection shared with the later execution lifecycle. */
export function canonicalStoredGmailArchiveRisk(
  value: Record<string, unknown>,
): RiskAssessment | null {
  const dimensions = ownData(value['dimensions'], Object.values(RiskDimension));
  if (!dimensions || typeof value['actionId'] !== 'string' || !UUID.test(value['actionId']) ||
      !Object.values(RiskTier).includes(value['overallTier'] as RiskTier) ||
      typeof value['reasoning'] !== 'string' || typeof value['assessedAt'] !== 'string') return null;
  const assessedAt = new Date(value['assessedAt']);
  if (!Number.isFinite(assessedAt.getTime())) return null;
  const parsedDimensions = {} as RiskAssessment['dimensions'];
  for (const dimension of Object.values(RiskDimension)) {
    const item = ownData(dimensions[dimension], ['reasoning', 'score', 'tier']);
    if (!item || !Object.values(RiskTier).includes(item['tier'] as RiskTier) ||
        typeof item['score'] !== 'number' || !Number.isFinite(item['score']) ||
        typeof item['reasoning'] !== 'string') return null;
    parsedDimensions[dimension] = {
      tier: item['tier'] as RiskTier,
      score: item['score'],
      reasoning: item['reasoning'],
    };
  }
  return {
    actionId: value['actionId'],
    overallTier: value['overallTier'] as RiskTier,
    dimensions: parsedDimensions,
    reasoning: value['reasoning'],
    assessedAt,
  };
}

/** DB-internal canonical projection shared with the later execution lifecycle. */
export function canonicalGmailArchiveCandidate(
  state: Pick<GmailArchiveApprovalCanonicalState, 'approval' | 'candidate' | 'decision'>,
): CandidateAction | null {
  const stored = state.approval.candidate_action;
  const parameters = ownData(stored['parameters'], ['messageRefId', 'operation', 'schema']);
  const risk = canonicalStoredGmailArchiveRisk(state.candidate.risk_assessment);
  if (!parameters || parameters['schema'] !== GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA ||
      parameters['operation'] !== 'archive' || typeof parameters['messageRefId'] !== 'string' ||
      !risk || risk.actionId !== state.candidate.id) return null;
  return {
    id: state.candidate.id,
    decisionId: state.decision.id,
    actionType: 'archive_email',
    description: String(stored['description']),
    domain: 'email',
    parameters,
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: stored['confidence'] as CandidateAction['confidence'],
    reasoning: String(stored['reasoning']),
    provenance: 'untrusted_external',
  };
}

function policyProjection(policy: ActionPolicy): Record<string, unknown> {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    rules: policy.rules,
    priority: policy.priority,
    enabled: policy.enabled,
    builtIn: policy.builtIn,
  };
}

function candidateProjection(candidate: CandidateAction): Record<string, unknown> {
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

function riskProjection(risk: RiskAssessment): Record<string, unknown> {
  return { ...risk, assessedAt: risk.assessedAt.toISOString() };
}

/** DB-internal owner-scoped policy view shared with the claim lifecycle. */
export function createGmailArchiveTransactionPolicyPort(
  ownerId: string,
  rows: readonly ActionPolicyRow[],
): PolicyRepositoryPort {
  const all = rows.map(actionPolicyRowToDomain);
  const readAll = async () => all.map((policy) => ({ ...policy, rules: [...policy.rules] }));
  const unsupported = async (): Promise<never> => {
    throw new Error('Transaction-bound policy evaluation is read-only.');
  };
  return {
    getAllPolicies: async (userId) => userId === ownerId ? readAll() : [],
    getEnabledPolicies: async (userId) =>
      userId === ownerId ? (await readAll()).filter((policy) => policy.enabled) : [],
    getPolicy: async (policyId, userId) => {
      return userId === ownerId ? all.find((policy) => policy.id === policyId) ?? null : null;
    },
    getPoliciesByDomain: async (_domain, userId) =>
      userId === ownerId ? (await readAll()).filter((policy) => policy.enabled) : [],
    savePolicy: unsupported,
    updatePolicy: unsupported,
    deletePolicy: unsupported,
  };
}

/** Builds the byte-compared current-policy authority snapshot used across the execution lifecycle. */
export function buildGmailArchivePostApprovalPolicySnapshot(input: {
  state: GmailArchiveApprovalCanonicalState;
  candidate: CandidateAction;
  risk: RiskAssessment;
  user: UserRow;
  policyRows: ActionPolicyRow[];
  decision: PolicyDecision;
  evaluator: PolicyEvaluator;
}): Record<string, unknown> {
  const userPolicies = input.policyRows.map(actionPolicyRowToDomain);
  const evaluatedPolicies = [...DEFAULT_POLICIES, ...userPolicies]
    .filter((policy) => policy.enabled)
    .sort((left, right) => right.priority - left.priority);
  return {
    version: 1,
    phase: 'post_approval',
    approvalId: input.state.approval.id,
    decisionId: input.state.decision.id,
    candidateActionId: input.candidate.id,
    allowed: input.decision.allowed,
    requiresApproval: input.decision.requiresApproval,
    reason: input.decision.reason,
    confirmationLevel: input.decision.confirmationLevel ?? null,
    trustTier: input.user.trust_tier,
    autonomySettings: parseAutonomySettings(input.user.autonomy_settings),
    userUpdatedAt: input.user.updated_at.toISOString(),
    policyIds: userPolicies.filter((policy) => policy.enabled).map((policy) => policy.id).sort(),
    evaluatedPolicies: evaluatedPolicies.map(policyProjection),
    candidate: candidateProjection(input.candidate),
    riskAssessment: riskProjection(input.risk),
    globallyPaused: input.evaluator.isGloballyPaused(),
  };
}

function explanationEvidence(state: GmailArchiveApprovalCanonicalState): Record<string, unknown>[] {
  return [{
    evidenceId: state.signal.id,
    source: 'gmail',
    summary: 'Owned Inbox signal',
    relevance: 'The owned signal directly produced this approved archive preparation.',
  }];
}

function expectedExplanation(input: {
  state: GmailArchiveApprovalCanonicalState;
  candidate: CandidateAction;
  risk: RiskAssessment;
  allowed: boolean;
  reason: string;
  policyIds: readonly string[];
}): Omit<ExplanationRecordRow, 'id' | 'created_at'> {
  return {
    decision_id: input.state.decision.id,
    what_happened: input.allowed
      ? 'Rechecked current policy after approval and prepared the Inbox archive; no external action was attempted.'
      : 'Rechecked current policy after approval and blocked the Inbox archive; no external action was attempted.',
    evidence_used: explanationEvidence(input.state),
    preferences_invoked: [...input.policyIds],
    confidence_reasoning: input.risk.reasoning,
    action_rationale: input.candidate.reasoning,
    escalation_rationale: input.reason,
    correction_guidance: input.allowed
      ? 'The prepared archive can still be stopped before execution.'
      : 'Review current policy and autonomy settings before creating a new proposal.',
    capability_provenance_node_id: null,
  };
}

function exactExplanation(
  row: ExplanationRecordRow,
  expected: Omit<ExplanationRecordRow, 'id' | 'created_at'>,
): boolean {
  return row.decision_id === expected.decision_id && row.what_happened === expected.what_happened &&
    joinedDecisionReceiptArtifactDigest('policy', row.evidence_used) ===
      joinedDecisionReceiptArtifactDigest('policy', expected.evidence_used) &&
    joinedDecisionReceiptArtifactDigest('policy', row.preferences_invoked) ===
      joinedDecisionReceiptArtifactDigest('policy', expected.preferences_invoked) &&
    row.confidence_reasoning === expected.confidence_reasoning &&
    row.action_rationale === expected.action_rationale &&
    row.escalation_rationale === expected.escalation_rationale &&
    row.correction_guidance === expected.correction_guidance &&
    row.capability_provenance_node_id === null;
}

/** Exact persisted plan projection shared with the claim lifecycle. */
export function canonicalGmailArchivePlanSteps(candidate: CandidateAction): Record<string, unknown>[] {
  return [{
    type: 'archive_email',
    status: 'pending',
    parameters: {
      schema: GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
      messageRefId: candidate.parameters['messageRefId'],
      operation: 'archive',
      domain: 'email',
      costZeroIntent: 'verified_zero',
      provenance: 'untrusted_external',
    },
  }];
}

function executionPlanRef(row: ExecutionPlanRow): DecisionReceiptExecutionPlanRef {
  const snapshot = {
    version: 1 as const,
    status: row.status as 'pending',
    decisionId: row.decision_id,
    candidateActionId: row.action_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  return {
    id: row.id,
    snapshot,
    canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', snapshot),
  };
}

function postPolicyContent(input: {
  previous: JoinedDecisionReceiptContentV1;
  state: GmailArchiveApprovalCanonicalState;
  barrier: PreEffectBarrierRow;
  explanation: ExplanationRecordRow;
  disposition: 'allowed' | 'blocked';
}): JoinedDecisionReceiptContentV1 {
  const candidateAction = decisionReceiptRowArtifactRefV1('candidate_action', { ...input.state.candidate });
  const risk = {
    candidateActionId: input.state.candidate.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('risk', input.state.candidate.risk_assessment),
  };
  const policyIds = Array.isArray(input.barrier.policy_snapshot['policyIds'])
    ? [...input.barrier.policy_snapshot['policyIds']] as string[]
    : [];
  const policy = {
    barrierId: input.barrier.id,
    policyIds,
    canonicalHash: joinedDecisionReceiptArtifactDigest('policy', input.barrier.policy_snapshot),
  };
  const barrier = decisionReceiptBarrierRefV1(input.barrier);
  const explanation = decisionReceiptRowArtifactRefV1('explanation', { ...input.explanation });
  const evidence = [decisionReceiptRowEvidenceRefV1('signal', { ...input.state.signal })];
  const approval = decisionReceiptApprovalRefV1(input.state.approval);
  const evaluation = {
    version: 1 as const,
    phase: 'post_approval' as const,
    disposition: input.disposition,
    candidateAction,
    risk,
    policy,
    barrier,
    explanation,
    evidence,
    approvalSatisfied: approval,
  };
  return {
    ...input.previous,
    stage: 'policy_evaluated',
    disposition: input.disposition,
    policyEvaluations: [...input.previous.policyEvaluations, evaluation],
    candidateAction,
    risk,
    policy,
    barrier,
    explanation,
    evidence,
    approvalRequest: approval,
  };
}

function policySnapshotShape(value: Record<string, unknown>, state: GmailArchiveApprovalCanonicalState): boolean {
  const keys = [
    'allowed', 'approvalId', 'autonomySettings', 'candidate', 'candidateActionId',
    'confirmationLevel', 'decisionId', 'evaluatedPolicies', 'globallyPaused', 'phase',
    'policyIds', 'reason', 'requiresApproval', 'riskAssessment', 'trustTier',
    'userUpdatedAt', 'version',
  ];
  return ownData(value, keys) !== null && value['version'] === 1 &&
    value['phase'] === 'post_approval' && value['approvalId'] === state.approval.id &&
    value['decisionId'] === state.decision.id && value['candidateActionId'] === state.candidate.id &&
    typeof value['allowed'] === 'boolean' && typeof value['requiresApproval'] === 'boolean' &&
    typeof value['reason'] === 'string' && Array.isArray(value['policyIds']) &&
    (value['policyIds'] as unknown[]).every((id) => typeof id === 'string' && UUID.test(id));
}

function exactCompletedBarrier(barrier: PreEffectBarrierRow): boolean {
  if (barrier.status === 'prepared') {
    return barrier.failure_reason === null && ownData(barrier.effect_result, []) !== null;
  }
  const result = ownData(barrier.effect_result, ['dispatched']);
  return barrier.status === 'blocked' && barrier.failure_reason === POLICY_BLOCKED &&
    result?.['dispatched'] === false;
}

/** Validate and recover the exact immutable preparation graph without opening a transaction. */
export async function loadGmailArchivePreparationReplay(
  client: PoolClient,
  input: PrepareGmailArchiveInput,
  state: GmailArchiveApprovalCanonicalState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
  options: { readonly allowSingleFeedbackContinuation?: boolean } = {},
): Promise<PrepareGmailArchiveResult> {
  if ((barrier.status !== 'prepared' && barrier.status !== 'blocked') ||
      barrier.decision_id !== state.decision.id || barrier.action_id !== state.candidate.id ||
      barrier.explanation_id === null || !policySnapshotShape(barrier.policy_snapshot, state) ||
      !exactCompletedBarrier(barrier) ||
      (barrier.status === 'prepared' &&
        (barrier.policy_snapshot['allowed'] !== true ||
         barrier.policy_snapshot['requiresApproval'] !== true ||
         (barrier.policy_snapshot['confirmationLevel'] !== null &&
          barrier.policy_snapshot['confirmationLevel'] !== 'single'))) ||
      (barrier.status === 'blocked' && barrier.policy_snapshot['allowed'] !== false)) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const explanation = (await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
    [barrier.explanation_id, state.decision.id],
  )).rows[0];
  const candidate = canonicalGmailArchiveCandidate(state);
  const risk = canonicalStoredGmailArchiveRisk(state.candidate.risk_assessment);
  const reason = barrier.policy_snapshot['reason'];
  const policyIds = barrier.policy_snapshot['policyIds'];
  if (!explanation || !candidate || !risk || typeof reason !== 'string' || !exactExplanation(
    explanation,
    expectedExplanation({
      state,
      candidate,
      risk,
      allowed: barrier.status === 'prepared',
      reason,
      policyIds: Array.isArray(policyIds) ? policyIds as string[] : [],
    }),
  )) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const disposition = barrier.status === 'prepared' ? 'allowed' : 'blocked';
  const r5 = postPolicyContent({ previous: approved, state, barrier, explanation, disposition });
  const revisions = (await client.query<DecisionReceiptRevisionRow>(
    'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
    [state.receipt.id],
  )).rows;
  let plan: ExecutionPlanRow | null = null;
  if (barrier.status === 'prepared') {
    const plans = await client.query<ExecutionPlanRow>(
      'SELECT * FROM execution_plans WHERE decision_id = $1',
      [state.decision.id],
    );
    if (plans.rows.length !== 1) return { ok: false, error: 'idempotency_conflict' };
    plan = plans.rows[0]!;
    if (state.outcome.execution_plan_id !== plan.id || plan.action_id !== state.candidate.id ||
        plan.status !== 'pending' ||
        joinedDecisionReceiptArtifactDigest('policy', plan.steps) !==
          joinedDecisionReceiptArtifactDigest('policy', canonicalGmailArchivePlanSteps(candidate))) {
      return { ok: false, error: 'idempotency_conflict' };
    }
  } else {
    if (state.outcome.execution_plan_id !== null) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    const planCount = await client.query<{ count: string }>(
      'SELECT count(*)::STRING AS count FROM execution_plans WHERE decision_id = $1',
      [state.decision.id],
    );
    if (planCount.rows[0]?.count !== '0') return { ok: false, error: 'idempotency_conflict' };
  }
  const expectedLength = plan ? 6 : 5;
  const expectedLast = plan
    ? { ...r5, stage: 'execution_admitted' as const, disposition: 'pending' as const, executionPlan: executionPlanRef(plan) }
    : r5;
  const continuation = revisions[expectedLength];
  const continuationOkay = options.allowSingleFeedbackContinuation === true &&
    revisions.length === expectedLength + 1 &&
    continuation?.content.version === 3 &&
    continuation.stage === 'feedback_recorded' &&
    continuation.disposition === disposition &&
    continuation.event_key === buildDecisionReceiptEventKey(
      'feedback_recorded',
      continuation.content.feedbackApplication.snapshot.feedbackEventId,
    );
  if ((revisions.length !== expectedLength && !continuationOkay) ||
      revisions.some((revision) => revision.trusted !== true) ||
      !verifyJoinedDecisionReceiptChain({
        receiptId: state.receipt.id,
        decisionId: state.decision.id,
        userId: input.userId,
        revisions,
      }) || revisions[4]?.event_key !== buildDecisionReceiptEventKey('policy_evaluated', barrier.id) ||
      revisions[4]?.content_digest !== joinedDecisionReceiptContentDigest(r5) ||
      (plan && (revisions[5]?.event_key !== buildDecisionReceiptEventKey('execution_admitted', plan.id) ||
        revisions[5]?.content_digest !== joinedDecisionReceiptContentDigest(expectedLast)))) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  return {
    ok: true,
    created: false,
    preparation: { status: barrier.status, barrier, explanation, plan, receipt: state.receipt, revisions },
  };
}

function fail(result: PrepareGmailArchiveResult): never {
  throw new RollbackResult(result);
}

async function transition(
  client: PoolClient,
  input: PrepareGmailArchiveInput,
  ids: GmailArchivePreparationStableIds,
): Promise<PrepareGmailArchiveResult> {
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

  // Approval and its feedback event committed atomically. Only the application
  // marker may lag; validate it before touching the execution barrier or any
  // mutable eligibility/policy authority.
  const feedbackApplication = await inspectGmailArchiveApprovalFeedbackApplication(client, state);
  if (feedbackApplication.status === 'not_applied') {
    return { ok: false, error: 'not_ready' };
  }
  if (feedbackApplication.status !== 'verified') {
    return { ok: false, error: 'idempotency_conflict' };
  }

  const barriers = await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2
      FOR UPDATE`,
    [input.userId, input.approvalId],
  );
  if (barriers.rows.length !== 1) return { ok: false, error: 'not_ready' };
  const barrier = barriers.rows[0]!;
  if (!exactReservedGmailArchiveBarrier(barrier, input)) {
    return loadGmailArchivePreparationReplay(client, input, state, barrier, approved);
  }

  if (state.outcome.execution_plan_id !== null) {
    return { ok: false, error: 'idempotency_conflict' };
  }

  const preexistingPlanCount = await client.query<{ count: string }>(
    'SELECT count(*)::STRING AS count FROM execution_plans WHERE decision_id = $1',
    [state.decision.id],
  );
  if (preexistingPlanCount.rows[0]?.count !== '0') {
    return { ok: false, error: 'idempotency_conflict' };
  }

  const candidate = canonicalGmailArchiveCandidate(state);
  const risk = canonicalStoredGmailArchiveRisk(state.candidate.risk_assessment);
  if (!candidate || !risk) return { ok: false, error: 'idempotency_conflict' };

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
  if (eligible.rows[0]?.count !== '1') return { ok: false, error: 'not_ready' };

  const user = (await client.query<UserRow>(
    'SELECT * FROM users WHERE id = $1 FOR UPDATE',
    [input.userId],
  )).rows[0];
  if (!user) return { ok: false, error: 'not_found' };
  const policyRows = (await client.query<ActionPolicyRow>(
    'SELECT * FROM action_policies WHERE user_id = $1 ORDER BY priority DESC, id ASC FOR UPDATE',
    [input.userId],
  )).rows;
  const policyPort = createGmailArchiveTransactionPolicyPort(input.userId, policyRows);
  const evaluator = new PolicyEvaluator(policyPort);
  const policies = await policyPort.getAllPolicies(input.userId);
  const policyDecision = await evaluator.evaluate(
    candidate,
    policies,
    user.trust_tier as TrustTier,
    risk,
    parseAutonomySettings(user.autonomy_settings),
  );
  if (policyDecision.allowed &&
      (!policyDecision.requiresApproval || policyDecision.confirmationLevel === 'dual')) {
    return { ok: false, error: 'policy_invariant' };
  }
  const snapshot = buildGmailArchivePostApprovalPolicySnapshot({
    state,
    candidate,
    risk,
    user,
    policyRows,
    decision: policyDecision,
    evaluator,
  });
  const disposition = policyDecision.allowed ? 'allowed' : 'blocked';
  const explanationValues = expectedExplanation({
    state,
    candidate,
    risk,
    allowed: policyDecision.allowed,
    reason: policyDecision.reason,
    policyIds: snapshot['policyIds'] as string[],
  });
  const explanationResult = await client.query<ExplanationRecordRow>(
    `INSERT INTO explanation_records (
       id, decision_id, what_happened, evidence_used, preferences_invoked,
       confidence_reasoning, action_rationale, escalation_rationale,
       correction_guidance, capability_provenance_node_id
     ) VALUES ($1, $2, $3, $4, $5::STRING[], $6, $7, $8, $9, NULL)
     RETURNING *`,
    [
      ids.explanation,
      state.decision.id,
      explanationValues.what_happened,
      JSON.stringify(explanationValues.evidence_used),
      explanationValues.preferences_invoked,
      explanationValues.confidence_reasoning,
      explanationValues.action_rationale,
      explanationValues.escalation_rationale,
      explanationValues.correction_guidance,
    ],
  );
  const explanation = explanationResult.rows[0];
  if (!explanation) fail({ ok: false, error: 'idempotency_conflict' });
  const updatedBarrier = (await client.query<PreEffectBarrierRow>(
    `UPDATE pre_effect_barriers
        SET status = $3, decision_id = $4, action_id = $5, explanation_id = $6,
            policy_snapshot = $7, effect_result = $8, failure_reason = $9, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'reserved'
        AND decision_id IS NULL AND action_id IS NULL AND explanation_id IS NULL
      RETURNING *`,
    [
      barrier.id,
      input.userId,
      policyDecision.allowed ? 'prepared' : 'blocked',
      state.decision.id,
      state.candidate.id,
      explanation.id,
      JSON.stringify(snapshot),
      JSON.stringify(policyDecision.allowed ? {} : { dispatched: false }),
      policyDecision.allowed ? null : POLICY_BLOCKED,
    ],
  )).rows[0];
  if (!updatedBarrier) fail({ ok: false, error: 'idempotency_conflict' });

  const r5Content = postPolicyContent({
    previous: approved,
    state,
    barrier: updatedBarrier,
    explanation,
    disposition,
  });
  const r5 = await decisionReceiptLifecycleRepository.appendForUser(client, input.userId, {
    eventKind: 'policy_evaluated',
    eventId: updatedBarrier.id,
    expectedPreviousDigest: state.revisions.at(-1)!.revision_digest,
    content: r5Content,
    revisionId: ids.policyRevision,
  });
  if (!r5.success) fail({ ok: false, error: 'idempotency_conflict' });
  if (!policyDecision.allowed) {
    return {
      ok: true,
      created: true,
      preparation: {
        status: 'blocked',
        barrier: updatedBarrier,
        explanation,
        plan: null,
        receipt: r5.receipt,
        revisions: [...state.revisions, r5.revision],
      },
    };
  }

  const insertedPlan = (await client.query<ExecutionPlanRow>(
    `INSERT INTO execution_plans (id, decision_id, action_id, status, steps)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING *`,
    [ids.plan, state.decision.id, state.candidate.id, JSON.stringify(canonicalGmailArchivePlanSteps(candidate))],
  )).rows[0];
  if (!insertedPlan) fail({ ok: false, error: 'idempotency_conflict' });
  const linked = await client.query(
    `UPDATE decision_outcomes
        SET execution_plan_id = $1
      WHERE decision_id = $2 AND selected_action_id = $3
        AND auto_executed = false AND requires_approval = true
        AND execution_plan_id IS NULL
      RETURNING decision_id`,
    [insertedPlan.id, state.decision.id, state.candidate.id],
  );
  if (linked.rows.length !== 1) fail({ ok: false, error: 'idempotency_conflict' });
  const r6Content: JoinedDecisionReceiptContentV1 = {
    ...r5Content,
    stage: 'execution_admitted',
    disposition: 'pending',
    executionPlan: executionPlanRef(insertedPlan),
  };
  const r6 = await decisionReceiptLifecycleRepository.appendForUser(client, input.userId, {
    eventKind: 'execution_admitted',
    eventId: insertedPlan.id,
    expectedPreviousDigest: r5.revision.revision_digest,
    content: r6Content,
    revisionId: ids.admissionRevision,
  });
  if (!r6.success) fail({ ok: false, error: 'idempotency_conflict' });
  return {
    ok: true,
    created: true,
    preparation: {
      status: 'prepared',
      barrier: updatedBarrier,
      explanation,
      plan: insertedPlan,
      receipt: r6.receipt,
      revisions: [...state.revisions, r5.revision, r6.revision],
    },
  };
}

async function prepareWithTransition(
  input: PrepareGmailArchiveInput,
  transitionFn: GmailArchivePreparationTransition,
): Promise<PrepareGmailArchiveResult> {
  const snapshot = snapshotInput(input);
  if (!snapshot) return { ok: false, error: 'invalid_input' };
  const ids: GmailArchivePreparationStableIds = {
    explanation: randomUUID(),
    plan: randomUUID(),
    policyRevision: randomUUID(),
    admissionRevision: randomUUID(),
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction((client) => transitionFn(client, snapshot, ids));
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
export const gmailArchivePreparationTestHooks = { prepareWithTransition };

export const gmailArchivePreparationRepository = {
  async prepare(input: PrepareGmailArchiveInput): Promise<PrepareGmailArchiveResult> {
    return prepareWithTransition(input, transition);
  },
};
