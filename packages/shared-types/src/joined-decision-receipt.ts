import { createHash } from 'node:crypto';

/** Lower-case SHA-256 of canonical, typed metadata. */
export type DecisionReceiptDigest = string;
export type DecisionReceiptEventKey = string;
export type DecisionReceiptArtifactKind =
  | 'decision' | 'candidate_action' | 'risk' | 'policy' | 'barrier' | 'explanation'
  | 'signal' | 'preference' | 'inference_receipt' | 'inference_completion'
  | 'approval' | 'execution_plan' | 'execution_result' | 'feedback'
  | 'feedback_application'
  | 'preference_history' | 'preference_history_value' | 'policy_evaluation' | 'correction';

export type DecisionReceiptStage =
  | 'decision_recorded'
  | 'policy_evaluated'
  | 'approval_recorded'
  | 'execution_admitted'
  | 'execution_recorded'
  | 'feedback_recorded'
  | 'corrected';

export type DecisionReceiptDisposition =
  | 'pending'
  | 'allowed'
  | 'deliberate_non_action'
  | 'requires_approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'corrected';

export interface DecisionReceiptArtifactRef {
  id: string;
  canonicalHash: DecisionReceiptDigest;
}

export interface DecisionReceiptPreferenceHistorySnapshotV1 {
  version: 1;
  learnedSubjectId: string;
  attributionType: 'feedback';
  attributionId: string;
  changedAt: string;
  previousValueHash: DecisionReceiptDigest | null;
  newValueHash: DecisionReceiptDigest;
  previousConfidence: string | null;
  newConfidence: string;
}

export interface DecisionReceiptPreferenceHistoryRef extends DecisionReceiptArtifactRef {
  snapshot: DecisionReceiptPreferenceHistorySnapshotV1;
}

export interface DecisionReceiptApprovalSnapshotV1 {
  version: 1;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  candidateActionId: string;
  requestedAt: string;
  expiresAt: string;
  respondedAt: string | null;
}

export interface DecisionReceiptApprovalRef extends DecisionReceiptArtifactRef {
  snapshot: DecisionReceiptApprovalSnapshotV1;
}

export interface DecisionReceiptBarrierSnapshotV1 {
  version: 1;
  status: 'reserved' | 'prepared' | 'in_progress' | 'succeeded' | 'blocked' | 'failed' | 'unknown';
  effectType: 'assistant_approval' | 'event_execution' | 'memory_execution' | 'routine_registration';
  decisionId: string;
  candidateActionId: string | null;
  explanationId: string | null;
  policyHash: DecisionReceiptDigest;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionReceiptBarrierRef extends DecisionReceiptArtifactRef {
  snapshot: DecisionReceiptBarrierSnapshotV1;
}

export interface DecisionReceiptExecutionPlanSnapshotV1 {
  version: 1;
  status: 'pending' | 'running' | 'in_progress' | 'completed' | 'failed';
  decisionId: string;
  candidateActionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionReceiptExecutionPlanRef extends DecisionReceiptArtifactRef {
  snapshot: DecisionReceiptExecutionPlanSnapshotV1;
}

export interface DecisionReceiptExecutionResultSnapshotV1 {
  version: 1;
  planId: string;
  success: boolean;
  outcome: 'succeeded' | 'failed' | 'unknown';
  rollbackAvailable: boolean;
  completedAt: string;
}

export interface DecisionReceiptExecutionResultRef extends DecisionReceiptArtifactRef {
  snapshot: DecisionReceiptExecutionResultSnapshotV1;
}

export interface DecisionReceiptEvidenceRef extends DecisionReceiptArtifactRef {
  kind: 'signal' | 'preference';
}

export interface DecisionReceiptRiskRef {
  candidateActionId: string;
  canonicalHash: DecisionReceiptDigest;
}

export interface DecisionReceiptPolicyRef {
  barrierId: string;
  policyIds: readonly string[];
  canonicalHash: DecisionReceiptDigest;
}

export interface DecisionReceiptPolicyEvaluationV1 {
  version: 1;
  /** Authoritative durable policy barrier, not a provisional in-memory evaluation. */
  phase: 'pre_effect' | 'post_approval';
  disposition: 'allowed' | 'deliberate_non_action' | 'requires_approval' | 'blocked';
  candidateAction?: DecisionReceiptArtifactRef;
  risk?: DecisionReceiptRiskRef;
  policy: DecisionReceiptPolicyRef;
  barrier: DecisionReceiptBarrierRef;
  explanation: DecisionReceiptArtifactRef;
  evidence: readonly DecisionReceiptEvidenceRef[];
  /** Approval that authorizes an otherwise approval-gated post-approval check. */
  approvalSatisfied?: DecisionReceiptApprovalRef;
}

export interface DecisionReceiptInferenceSet {
  /** Canonically sorted by receipt ID. */
  receipts: readonly DecisionReceiptArtifactRef[];
  /** Present only when the durable completion marker exists. */
  completion?: DecisionReceiptArtifactRef;
}

/** Immutable causal edge for a durable preference correction. */
export interface DecisionReceiptCorrectionV1 {
  version: 1;
  correctionOfRevision: DecisionReceiptArtifactRef;
  feedbackEvent: DecisionReceiptArtifactRef;
  /** One feedback event may cause several preference-history rows. */
  preferenceChanges: readonly {
    learnedSubjectId: string;
    preferenceHistory: DecisionReceiptPreferenceHistoryRef;
  }[];
}

/** Immutable identity and output commitment for one DB-owned feedback projection. */
export interface DecisionReceiptFeedbackApplicationSnapshotV1 {
  version: 1;
  feedbackEventId: string;
  userId: string;
  decisionId: string;
  profileId: string;
  inputProfileVersion: number;
  outputProfileVersion: number;
  changed: boolean;
  outputDigest: DecisionReceiptDigest;
  appliedAt: string;
}

export interface DecisionReceiptFeedbackApplicationRef extends DecisionReceiptArtifactRef {
  snapshot: DecisionReceiptFeedbackApplicationSnapshotV1;
}

/**
 * Versioned metadata-only content joined by a receipt revision. Deliberately
 * excludes prompts, responses, chain-of-thought, credentials, provider error
 * text, and protected inference bytes. Those bytes remain deferred to #662.
 */
export interface JoinedDecisionReceiptContentV1 {
  version: 1;
  stage: DecisionReceiptStage;
  disposition: DecisionReceiptDisposition;
  decision: DecisionReceiptArtifactRef;
  /** Immutable, cumulative policy phases; current flat refs mirror the tail. */
  policyEvaluations: readonly DecisionReceiptPolicyEvaluationV1[];
  evidence: readonly DecisionReceiptEvidenceRef[];
  candidateAction?: DecisionReceiptArtifactRef;
  risk?: DecisionReceiptRiskRef;
  policy?: DecisionReceiptPolicyRef;
  barrier?: DecisionReceiptBarrierRef;
  explanation?: DecisionReceiptArtifactRef;
  inference: DecisionReceiptInferenceSet;
  approvalRequest?: DecisionReceiptApprovalRef;
  executionPlan?: DecisionReceiptExecutionPlanRef;
  executionResult?: DecisionReceiptExecutionResultRef;
  executionDisposition?: 'succeeded' | 'failed' | 'unknown';
  feedbackEvents: readonly DecisionReceiptArtifactRef[];
  correctionOfRevision?: DecisionReceiptArtifactRef;
  /** Append-only correction edges; flat correction refs mirror the tail. */
  corrections: readonly DecisionReceiptCorrectionV1[];
}

/**
 * Terminal lifecycle content. Version 2 leaves every v1 field and artifact
 * meaning unchanged, and adds a distinct explanation of what execution
 * actually did. The policy explanation remains bound to the latest immutable
 * policy evaluation; it must never be replaced with this terminal record.
 */
export interface JoinedDecisionReceiptContentV2
  extends Omit<JoinedDecisionReceiptContentV1, 'version'> {
  version: 2;
  executionExplanation: DecisionReceiptArtifactRef;
}

/**
 * Feedback lifecycle content. Version 3 binds the canonical feedback event to
 * the exact DB-owned projection application. Terminal execution explanations
 * remain present when the preceding terminal revision was v2.
 */
export interface JoinedDecisionReceiptContentV3
  extends Omit<JoinedDecisionReceiptContentV1, 'version'> {
  version: 3;
  feedbackApplication: DecisionReceiptFeedbackApplicationRef;
  executionExplanation?: DecisionReceiptArtifactRef;
}

export type JoinedDecisionReceiptContent =
  | JoinedDecisionReceiptContentV1
  | JoinedDecisionReceiptContentV2
  | JoinedDecisionReceiptContentV3;

export interface DecisionReceiptRevisionDigestInput {
  revisionId: string;
  receiptId: string;
  decisionId: string;
  userId: string;
  sequence: number;
  eventKey: DecisionReceiptEventKey;
  previousDigest: DecisionReceiptDigest | null;
  contentDigest: DecisionReceiptDigest;
}

export interface DecisionReceiptChainRevisionV1 {
  id: string;
  sequence: number | string;
  event_key: string;
  previous_digest: string | null;
  content_digest: string;
  revision_digest: string;
  stage: DecisionReceiptStage;
  disposition: DecisionReceiptDisposition;
  content: JoinedDecisionReceiptContent;
  candidate_action_id: string | null;
  barrier_id: string | null;
  explanation_id: string | null;
  approval_request_id: string | null;
  execution_plan_id: string | null;
  execution_result_id: string | null;
  execution_disposition: 'succeeded' | 'failed' | 'unknown' | null;
  correction_of_revision_id: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_KEY = /^[a-z][a-z0-9_]{0,47}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEARNED_SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('joined receipt contains invalid Unicode');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('joined receipt contains invalid Unicode');
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('joined receipt contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol') ||
        ownKeys.some((key) => typeof key === 'string' && key !== 'length' &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) ||
        Array.from({ length: value.length }, (_item, index) => index)
          .some((index) => !Object.prototype.hasOwnProperty.call(value, index))) {
      throw new TypeError('joined receipt arrays must be dense and canonical');
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new TypeError('joined receipt arrays must contain ordinary data properties');
      }
    }
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('joined receipt must contain only plain JSON values');
  }
  const record = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new TypeError('joined receipt cannot contain symbol keys');
  }
  const keys = Object.keys(record).sort();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new TypeError('joined receipt must contain ordinary data properties');
    }
  }
  if (keys.some((key) => record[key] === undefined)) {
    throw new TypeError('joined receipt cannot contain undefined');
  }
  keys.forEach(assertUnicode);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unsupported field`);
  }
}

function assertRef(
  ref: DecisionReceiptArtifactRef,
  label: string,
  allowed: readonly string[] = ['id', 'canonicalHash'],
): void {
  if (!ref || typeof ref !== 'object' || Object.getPrototypeOf(ref) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  assertExactKeys(ref, allowed, label);
  if (typeof ref.id !== 'string' || !UUID.test(ref.id) || !SHA256.test(ref.canonicalHash)) {
    throw new TypeError(`${label} must have a UUID and lower-case SHA-256 canonical hash`);
  }
}

function assertPreferenceHistoryRef(ref: DecisionReceiptPreferenceHistoryRef): void {
  if (!ref || typeof ref !== 'object' || Object.getPrototypeOf(ref) !== Object.prototype) {
    throw new TypeError('preference history must be a plain object');
  }
  assertExactKeys(ref, ['id', 'canonicalHash', 'snapshot'], 'preference history');
  if (!/^phist_[0-9]+_[a-z0-9]{7}$/.test(ref.id) || !SHA256.test(ref.canonicalHash) ||
      !ref.snapshot || typeof ref.snapshot !== 'object' ||
      Object.getPrototypeOf(ref.snapshot) !== Object.prototype) {
    throw new TypeError('preference history reference is invalid');
  }
  assertExactKeys(ref.snapshot, [
    'version', 'learnedSubjectId', 'attributionType', 'attributionId', 'changedAt',
    'previousValueHash', 'newValueHash', 'previousConfidence', 'newConfidence',
  ], 'preference history snapshot');
  if (ref.snapshot.version !== 1 || !LEARNED_SUBJECT_ID.test(ref.snapshot.learnedSubjectId) ||
      ref.snapshot.attributionType !== 'feedback' || !UUID.test(ref.snapshot.attributionId) ||
      (ref.snapshot.previousValueHash !== null && !SHA256.test(ref.snapshot.previousValueHash)) ||
      !SHA256.test(ref.snapshot.newValueHash) ||
      (ref.snapshot.previousConfidence !== null && typeof ref.snapshot.previousConfidence !== 'string') ||
      typeof ref.snapshot.newConfidence !== 'string' ||
      joinedDecisionReceiptArtifactDigest('preference_history', ref.snapshot) !== ref.canonicalHash) {
    throw new TypeError('preference history snapshot is invalid');
  }
  assertIsoInstant(ref.snapshot.changedAt, 'preference history changedAt');
}

function assertIsoInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO instant`);
  }
}

function assertCanonicalSqlInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a canonical SQL instant`);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(value);
  if (!match || (match[2]!.length === 6 && match[2]!.slice(3) === '000') ||
      Number.isNaN(Date.parse(value)) ||
      new Date(`${match[1]}.${match[2]!.slice(0, 3)}Z`).toISOString() !==
        `${match[1]}.${match[2]!.slice(0, 3)}Z`) {
    throw new TypeError(`${label} must be a canonical SQL instant`);
  }
}

function assertFeedbackApplicationRef(ref: DecisionReceiptFeedbackApplicationRef): void {
  assertRef(ref, 'feedback application', ['id', 'canonicalHash', 'snapshot']);
  if (!ref.snapshot || typeof ref.snapshot !== 'object' ||
      Object.getPrototypeOf(ref.snapshot) !== Object.prototype) {
    throw new TypeError('feedback application snapshot must be a plain object');
  }
  assertExactKeys(ref.snapshot, [
    'version', 'feedbackEventId', 'userId', 'decisionId', 'profileId',
    'inputProfileVersion', 'outputProfileVersion', 'changed', 'outputDigest', 'appliedAt',
  ], 'feedback application snapshot');
  const snapshot = ref.snapshot;
  if (snapshot.version !== 1 || !UUID.test(snapshot.feedbackEventId) ||
      !UUID.test(snapshot.userId) || !UUID.test(snapshot.decisionId) ||
      !UUID.test(snapshot.profileId) || !Number.isSafeInteger(snapshot.inputProfileVersion) ||
      snapshot.inputProfileVersion < 1 || !Number.isSafeInteger(snapshot.outputProfileVersion) ||
      snapshot.outputProfileVersion < 1 || typeof snapshot.changed !== 'boolean' ||
      !SHA256.test(snapshot.outputDigest) ||
      (snapshot.changed
        ? snapshot.outputProfileVersion !== snapshot.inputProfileVersion + 1
        : snapshot.outputProfileVersion !== snapshot.inputProfileVersion) ||
      joinedDecisionReceiptArtifactDigest('feedback_application', snapshot) !== ref.canonicalHash) {
    throw new TypeError('feedback application snapshot is invalid');
  }
  assertCanonicalSqlInstant(snapshot.appliedAt, 'feedback application appliedAt');
}

function assertSnapshotRef(
  ref: DecisionReceiptArtifactRef & { snapshot: object },
  label: string,
  snapshotKeys: readonly string[],
  kind: DecisionReceiptArtifactKind,
): void {
  assertRef(ref, label, ['id', 'canonicalHash', 'snapshot']);
  if (!ref.snapshot || typeof ref.snapshot !== 'object' ||
      Object.getPrototypeOf(ref.snapshot) !== Object.prototype) {
    throw new TypeError(`${label} snapshot must be a plain object`);
  }
  assertExactKeys(ref.snapshot, snapshotKeys, `${label} snapshot`);
  if (joinedDecisionReceiptArtifactDigest(kind, ref.snapshot) !== ref.canonicalHash) {
    throw new TypeError(`${label} hash must match its immutable snapshot`);
  }
}

function assertApprovalRef(ref: DecisionReceiptApprovalRef): void {
  assertSnapshotRef(ref, 'approval request', [
    'version', 'status', 'candidateActionId', 'requestedAt', 'expiresAt', 'respondedAt',
  ], 'approval');
  if (ref.snapshot.version !== 1 || !['pending', 'approved', 'rejected', 'expired'].includes(ref.snapshot.status) ||
      !UUID.test(ref.snapshot.candidateActionId)) throw new TypeError('approval snapshot is invalid');
  assertIsoInstant(ref.snapshot.requestedAt, 'approval requestedAt');
  assertIsoInstant(ref.snapshot.expiresAt, 'approval expiresAt');
  if (ref.snapshot.respondedAt !== null) assertIsoInstant(ref.snapshot.respondedAt, 'approval respondedAt');
}

function assertBarrierRef(ref: DecisionReceiptBarrierRef): void {
  assertSnapshotRef(ref, 'barrier', [
    'version', 'status', 'effectType', 'decisionId', 'candidateActionId', 'explanationId',
    'policyHash', 'createdAt', 'updatedAt',
  ], 'barrier');
  if (ref.snapshot.version !== 1 ||
      !['reserved', 'prepared', 'in_progress', 'succeeded', 'blocked', 'failed', 'unknown'].includes(ref.snapshot.status) ||
      !['assistant_approval', 'event_execution', 'memory_execution', 'routine_registration'].includes(ref.snapshot.effectType) ||
      !UUID.test(ref.snapshot.decisionId) ||
      (ref.snapshot.candidateActionId !== null && !UUID.test(ref.snapshot.candidateActionId)) ||
      (ref.snapshot.explanationId !== null && !UUID.test(ref.snapshot.explanationId)) ||
      !SHA256.test(ref.snapshot.policyHash)) throw new TypeError('barrier snapshot is invalid');
  assertIsoInstant(ref.snapshot.createdAt, 'barrier createdAt');
  assertIsoInstant(ref.snapshot.updatedAt, 'barrier updatedAt');
}

function assertExecutionPlanRef(ref: DecisionReceiptExecutionPlanRef): void {
  assertSnapshotRef(ref, 'execution plan', [
    'version', 'status', 'decisionId', 'candidateActionId', 'createdAt', 'updatedAt',
  ], 'execution_plan');
  if (ref.snapshot.version !== 1 || !['pending', 'running', 'in_progress', 'completed', 'failed'].includes(ref.snapshot.status) ||
      !UUID.test(ref.snapshot.decisionId) ||
      (ref.snapshot.candidateActionId !== null && !UUID.test(ref.snapshot.candidateActionId))) {
    throw new TypeError('execution plan snapshot is invalid');
  }
  assertIsoInstant(ref.snapshot.createdAt, 'execution plan createdAt');
  assertIsoInstant(ref.snapshot.updatedAt, 'execution plan updatedAt');
}

function assertExecutionResultRef(ref: DecisionReceiptExecutionResultRef): void {
  assertSnapshotRef(ref, 'execution result', [
    'version', 'planId', 'success', 'outcome', 'rollbackAvailable', 'completedAt',
  ], 'execution_result');
  if (ref.snapshot.version !== 1 || !UUID.test(ref.snapshot.planId) ||
      typeof ref.snapshot.success !== 'boolean' ||
      !['succeeded', 'failed', 'unknown'].includes(ref.snapshot.outcome) ||
      typeof ref.snapshot.rollbackAvailable !== 'boolean') {
    throw new TypeError('execution result snapshot is invalid');
  }
  assertIsoInstant(ref.snapshot.completedAt, 'execution result completedAt');
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index] || (index > 0 && values[index - 1]! >= values[index]!)) {
      throw new TypeError(`${label} must be sorted and unique`);
    }
  }
}

function assertPolicyEvaluation(evaluation: DecisionReceiptPolicyEvaluationV1, index: number): void {
  const label = `policy evaluation ${index}`;
  if (!evaluation || typeof evaluation !== 'object' || Object.getPrototypeOf(evaluation) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  assertExactKeys(evaluation, [
    'version', 'phase', 'disposition', 'candidateAction', 'risk', 'policy',
    'barrier', 'explanation', 'evidence', 'approvalSatisfied',
  ], label);
  if (evaluation.version !== 1 || !['pre_effect', 'post_approval'].includes(evaluation.phase) ||
      !['allowed', 'deliberate_non_action', 'requires_approval', 'blocked'].includes(evaluation.disposition)) {
    throw new TypeError(`${label} has invalid phase or disposition`);
  }
  if (evaluation.candidateAction) assertRef(evaluation.candidateAction, `${label} candidate`);
  if (!!evaluation.candidateAction !== !!evaluation.risk) {
    throw new TypeError(`${label} candidate and risk must be joined together`);
  }
  if (evaluation.risk) {
    assertExactKeys(evaluation.risk, ['candidateActionId', 'canonicalHash'], `${label} risk`);
    assertRef({ id: evaluation.risk.candidateActionId, canonicalHash: evaluation.risk.canonicalHash }, `${label} risk`);
    if (evaluation.risk.candidateActionId !== evaluation.candidateAction?.id) {
      throw new TypeError(`${label} risk must bind its candidate`);
    }
  }
  if ((evaluation.disposition === 'allowed' || evaluation.disposition === 'requires_approval') &&
      !evaluation.candidateAction) throw new TypeError(`${label} actionable disposition requires a candidate`);
  assertExactKeys(evaluation.policy, ['barrierId', 'policyIds', 'canonicalHash'], `${label} policy`);
  if (!UUID.test(evaluation.policy.barrierId) || !Array.isArray(evaluation.policy.policyIds) ||
      !SHA256.test(evaluation.policy.canonicalHash) ||
      evaluation.policy.policyIds.some((id) => !UUID.test(id))) throw new TypeError(`${label} policy is invalid`);
  assertSortedUnique(evaluation.policy.policyIds, `${label} policy IDs`);
  assertBarrierRef(evaluation.barrier);
  assertRef(evaluation.explanation, `${label} explanation`);
  if (evaluation.approvalSatisfied) {
    assertApprovalRef(evaluation.approvalSatisfied);
  }
  if (evaluation.phase === 'pre_effect' && evaluation.approvalSatisfied) {
    throw new TypeError(`${label} pre-effect phase cannot claim a prior approval`);
  }
  if (evaluation.phase === 'post_approval' && (
      evaluation.approvalSatisfied?.snapshot.status !== 'approved' ||
      evaluation.approvalSatisfied.snapshot.candidateActionId !== evaluation.candidateAction?.id)) {
    throw new TypeError(`${label} post-approval phase requires its approved authorization`);
  }
  if (evaluation.phase === 'post_approval' && evaluation.disposition === 'requires_approval') {
    throw new TypeError(`${label} post-approval phase cannot reopen the consumed approval`);
  }
  if (evaluation.policy.barrierId !== evaluation.barrier.id ||
      evaluation.barrier.snapshot.policyHash !== evaluation.policy.canonicalHash ||
      evaluation.barrier.snapshot.candidateActionId !== (evaluation.candidateAction?.id ?? null) ||
      evaluation.barrier.snapshot.explanationId !== evaluation.explanation.id) {
    throw new TypeError(`${label} artifact links are inconsistent`);
  }
  if (!Array.isArray(evaluation.evidence)) throw new TypeError(`${label} evidence must be an array`);
  evaluation.evidence.forEach((ref) => {
    assertExactKeys(ref, ['id', 'canonicalHash', 'kind'], `${label} evidence`);
    if (ref.kind !== 'signal' && ref.kind !== 'preference') throw new TypeError(`${label} evidence kind is invalid`);
    assertRef(ref, `${label} evidence`, ['id', 'canonicalHash', 'kind']);
  });
  assertSortedUnique(evaluation.evidence.map((ref) => `${ref.kind}:${ref.id}`), `${label} evidence`);
}

export function validateJoinedDecisionReceiptContent(
  content: JoinedDecisionReceiptContent,
): void {
  if (!content || typeof content !== 'object' || Object.getPrototypeOf(content) !== Object.prototype) {
    throw new TypeError('joined receipt content must be a plain object');
  }
  const contentKeys = [
    'version', 'stage', 'disposition', 'decision', 'policyEvaluations', 'evidence', 'candidateAction',
    'risk', 'policy', 'barrier', 'explanation', 'inference', 'approvalRequest',
    'executionPlan', 'executionResult', 'executionDisposition', 'feedbackEvents',
    'correctionOfRevision', 'corrections',
  ];
  assertExactKeys(content, content.version === 2
    ? [...contentKeys, 'executionExplanation']
    : content.version === 3
      ? [...contentKeys, 'feedbackApplication', 'executionExplanation']
      : contentKeys, 'joined receipt content');
  if (content.version !== 1 && content.version !== 2 && content.version !== 3) {
    throw new TypeError('unsupported joined receipt version');
  }
  if (content.version === 2 ||
      (content.version === 3 && content.executionExplanation !== undefined)) {
    const executionExplanation = content.executionExplanation;
    if (!executionExplanation) throw new TypeError('execution explanation is required');
    assertRef(executionExplanation, 'execution explanation');
    if (!['execution_recorded', 'feedback_recorded', 'corrected'].includes(content.stage)) {
      throw new TypeError('execution explanation cannot precede execution recording');
    }
  }
  if (content.version === 3) {
    if (content.stage !== 'feedback_recorded') {
      throw new TypeError('feedback application cannot precede feedback recording');
    }
    assertFeedbackApplicationRef(content.feedbackApplication);
    if (content.feedbackEvents.length !== 1 ||
        content.feedbackEvents[0]?.id !== content.feedbackApplication.snapshot.feedbackEventId ||
        content.feedbackApplication.snapshot.decisionId !== content.decision.id) {
      throw new TypeError('feedback application must bind the joined feedback event and decision');
    }
  }
  if (!new Set<DecisionReceiptStage>([
    'decision_recorded', 'policy_evaluated', 'approval_recorded',
    'execution_admitted', 'execution_recorded', 'feedback_recorded', 'corrected',
  ]).has(content.stage)) throw new TypeError('unsupported joined receipt stage');
  if (!new Set<DecisionReceiptDisposition>([
    'pending', 'allowed', 'deliberate_non_action', 'requires_approval', 'approved', 'rejected',
    'expired', 'blocked', 'succeeded', 'failed', 'unknown', 'corrected',
  ]).has(content.disposition)) throw new TypeError('unsupported joined receipt disposition');
  assertRef(content.decision, 'decision');
  if (!Array.isArray(content.policyEvaluations)) throw new TypeError('policy evaluations must be an array');
  content.policyEvaluations.forEach(assertPolicyEvaluation);
  if ((content.version === 2 ||
      (content.version === 3 && content.executionExplanation !== undefined)) &&
      content.policyEvaluations.some(
    (evaluation) => evaluation.explanation.id === content.executionExplanation!.id,
  )) {
    throw new TypeError('execution explanation must be distinct from every policy explanation');
  }
  if (content.policyEvaluations.length > 2) {
    throw new TypeError('joined receipt supports at most one post-approval policy phase');
  }
  if (content.policyEvaluations.length > 0 && (
      content.policyEvaluations[0]?.phase !== 'pre_effect' ||
      content.policyEvaluations.slice(1).some((evaluation) => evaluation.phase !== 'post_approval'))) {
    throw new TypeError('policy evaluations must begin with pre-effect and append post-approval phases');
  }
  if (!Array.isArray(content.evidence)) throw new TypeError('evidence must be an array');
  for (const ref of content.evidence) {
    assertExactKeys(ref, ['id', 'canonicalHash', 'kind'], 'evidence');
    if (ref.kind !== 'signal' && ref.kind !== 'preference') throw new TypeError('unsupported evidence kind');
  }
  content.evidence.forEach((ref) => assertRef(ref, 'evidence', ['id', 'canonicalHash', 'kind']));
  assertSortedUnique(content.evidence.map((ref) => `${ref.kind}:${ref.id}`), 'evidence');
  if (content.evidence.length > 0 && !content.explanation) {
    throw new TypeError('evidence requires the joined explanation that used it');
  }
  if (content.candidateAction) assertRef(content.candidateAction, 'candidate action');
  if (!!content.candidateAction !== !!content.risk) {
    throw new TypeError('candidate action and risk must be joined together');
  }
  if (content.risk) {
    assertExactKeys(content.risk, ['candidateActionId', 'canonicalHash'], 'risk');
    assertRef({ id: content.risk.candidateActionId, canonicalHash: content.risk.canonicalHash }, 'risk');
    if (content.candidateAction && content.risk.candidateActionId !== content.candidateAction.id) {
      throw new TypeError('risk must reference the joined candidate action');
    }
    if (!content.candidateAction) throw new TypeError('risk requires the joined candidate action');
  }
  if (content.policy) {
    assertExactKeys(content.policy, ['barrierId', 'policyIds', 'canonicalHash'], 'policy');
    if (!UUID.test(content.policy.barrierId)) throw new TypeError('policy barrier ID must be a UUID');
    if (!Array.isArray(content.policy.policyIds)) throw new TypeError('policy IDs must be an array');
    if (!SHA256.test(content.policy.canonicalHash)) throw new TypeError('policy hash is invalid');
    if (content.policy.policyIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
      throw new TypeError('policy IDs must be UUIDs');
    }
    assertSortedUnique(content.policy.policyIds, 'policy IDs');
  }
  if (content.barrier) {
    assertBarrierRef(content.barrier);
    if (content.barrier.snapshot.decisionId !== content.decision.id ||
        content.barrier.snapshot.candidateActionId !== (content.candidateAction?.id ?? null) ||
        content.barrier.snapshot.explanationId !== (content.explanation?.id ?? null)) {
      throw new TypeError('barrier snapshot must bind the joined decision, action, and explanation');
    }
  }
  const policyBarrier = content.policy && content.barrier?.id === content.policy.barrierId
    ? content.barrier
    : undefined;
  if (content.policy && !policyBarrier) {
    throw new TypeError('policy must bind the joined pre-effect barrier');
  }
  if (content.policy && policyBarrier?.snapshot.policyHash !== content.policy.canonicalHash) {
    throw new TypeError('barrier policy snapshot must match the joined policy hash');
  }
  if (content.explanation) assertRef(content.explanation, 'explanation');
  const currentEvaluation = content.policyEvaluations[content.policyEvaluations.length - 1];
  if (currentEvaluation) {
    const sameEvidence = JSON.stringify(currentEvaluation.evidence) === JSON.stringify(content.evidence);
    if (currentEvaluation.candidateAction?.id !== content.candidateAction?.id ||
        currentEvaluation.candidateAction?.canonicalHash !== content.candidateAction?.canonicalHash ||
        currentEvaluation.risk?.candidateActionId !== content.risk?.candidateActionId ||
        currentEvaluation.risk?.canonicalHash !== content.risk?.canonicalHash ||
        currentEvaluation.policy.barrierId !== content.policy?.barrierId ||
        currentEvaluation.policy.canonicalHash !== content.policy?.canonicalHash ||
        currentEvaluation.policy.policyIds.join('\0') !== content.policy?.policyIds.join('\0') ||
        currentEvaluation.explanation.id !== content.explanation?.id ||
        currentEvaluation.explanation.canonicalHash !== content.explanation?.canonicalHash ||
        currentEvaluation.barrier.id !== content.barrier?.id || !sameEvidence) {
      throw new TypeError('current policy artifacts must mirror the latest immutable evaluation');
    }
    if (currentEvaluation.phase === 'post_approval' && (
        currentEvaluation.approvalSatisfied?.id !== content.approvalRequest?.id ||
        currentEvaluation.approvalSatisfied?.canonicalHash !== content.approvalRequest?.canonicalHash)) {
      throw new TypeError('post-approval policy phase must bind the joined approval');
    }
    if ((content.stage === 'policy_evaluated' || content.stage === 'approval_recorded') &&
        currentEvaluation.barrier.canonicalHash !== content.barrier?.canonicalHash) {
      throw new TypeError('policy and approval stages must retain the evaluated barrier snapshot');
    }
  } else if (content.candidateAction || content.risk || content.policy || content.barrier ||
      content.explanation || content.evidence.length > 0) {
    throw new TypeError('policy artifacts require an immutable policy evaluation');
  }
  if (!content.inference || typeof content.inference !== 'object' ||
      Object.getPrototypeOf(content.inference) !== Object.prototype) {
    throw new TypeError('inference set must be a plain object');
  }
  assertExactKeys(content.inference, ['receipts', 'completion'], 'inference set');
  if (!Array.isArray(content.inference.receipts)) {
    throw new TypeError('inference set is invalid');
  }
  content.inference.receipts.forEach((ref) => assertRef(ref, 'inference receipt'));
  if (content.inference.completion) assertRef(content.inference.completion, 'inference completion');
  assertSortedUnique(content.inference.receipts.map((ref) => ref.id), 'inference receipt IDs');
  if (!Array.isArray(content.feedbackEvents)) throw new TypeError('feedback events must be an array');
  content.feedbackEvents.forEach((ref) => assertRef(ref, 'feedback event'));
  assertSortedUnique(content.feedbackEvents.map((ref) => ref.id), 'feedback event IDs');
  if (!Array.isArray(content.corrections)) throw new TypeError('corrections must be an array');
  const correctionFeedbackIds = new Set<string>();
  const correctionHistoryIds = new Set<string>();
  content.corrections.forEach((correction, index) => {
    const label = `correction ${index}`;
    if (!correction || typeof correction !== 'object' ||
        Object.getPrototypeOf(correction) !== Object.prototype) {
      throw new TypeError(`${label} must be a plain object`);
    }
    assertExactKeys(correction, [
      'version', 'correctionOfRevision', 'feedbackEvent', 'preferenceChanges',
    ], label);
    if (correction.version !== 1 || !Array.isArray(correction.preferenceChanges) ||
        correction.preferenceChanges.length === 0) {
      throw new TypeError(`${label} is invalid`);
    }
    const preferenceChanges = correction.preferenceChanges as DecisionReceiptCorrectionV1['preferenceChanges'];
    assertRef(correction.correctionOfRevision, `${label} prior revision`);
    assertRef(correction.feedbackEvent, `${label} feedback event`);
    preferenceChanges.forEach((change, changeIndex) => {
      const changeLabel = `${label} preference change ${changeIndex}`;
      if (!change || typeof change !== 'object' || Object.getPrototypeOf(change) !== Object.prototype) {
        throw new TypeError(`${changeLabel} must be a plain object`);
      }
      assertExactKeys(change, ['learnedSubjectId', 'preferenceHistory'], changeLabel);
      if (!LEARNED_SUBJECT_ID.test(change.learnedSubjectId)) throw new TypeError(`${changeLabel} is invalid`);
      assertPreferenceHistoryRef(change.preferenceHistory);
      if (change.preferenceHistory.snapshot.learnedSubjectId !== change.learnedSubjectId ||
          change.preferenceHistory.snapshot.attributionId !== correction.feedbackEvent.id) {
        throw new TypeError(`${changeLabel} must bind the corrected preference and causal feedback`);
      }
    });
    assertSortedUnique(
      preferenceChanges.map((change) => change.learnedSubjectId),
      `${label} learned subject IDs`,
    );
    if (new Set(preferenceChanges.map((change) => change.preferenceHistory.id)).size !==
        preferenceChanges.length) {
      throw new TypeError(`${label} preference history links must be unique`);
    }
    if (!content.feedbackEvents.some((ref) => ref.id === correction.feedbackEvent.id &&
        ref.canonicalHash === correction.feedbackEvent.canonicalHash)) {
      throw new TypeError(`${label} must bind a joined feedback event`);
    }
    if (correctionFeedbackIds.has(correction.feedbackEvent.id) ||
        preferenceChanges.some((change) => correctionHistoryIds.has(change.preferenceHistory.id))) {
      throw new TypeError('correction feedback and history links cannot be reused');
    }
    correctionFeedbackIds.add(correction.feedbackEvent.id);
    preferenceChanges.forEach((change) => correctionHistoryIds.add(change.preferenceHistory.id));
  });
  if (content.approvalRequest) {
    assertApprovalRef(content.approvalRequest);
    if (content.approvalRequest.snapshot.candidateActionId !== content.candidateAction?.id) {
      throw new TypeError('approval snapshot must bind the joined candidate action');
    }
  }
  if (content.executionPlan) {
    assertExecutionPlanRef(content.executionPlan);
    if (content.executionPlan.snapshot.decisionId !== content.decision.id ||
        content.executionPlan.snapshot.candidateActionId !== (content.candidateAction?.id ?? null)) {
      throw new TypeError('execution plan snapshot must bind the joined decision and action');
    }
  }
  if (content.executionResult) {
    assertExecutionResultRef(content.executionResult);
    if (content.executionResult.snapshot.planId !== content.executionPlan?.id) {
      throw new TypeError('execution result snapshot must bind the joined plan');
    }
  }
  if (content.correctionOfRevision) assertRef(content.correctionOfRevision, 'correction revision');
  if (content.executionResult && !content.executionPlan) {
    throw new TypeError('execution result requires its execution plan');
  }
  if (content.stage === 'corrected' || content.disposition === 'corrected') {
    const correction = content.corrections[content.corrections.length - 1];
    if (content.stage !== 'corrected' || content.disposition !== 'corrected' || !correction ||
        content.correctionOfRevision?.id !== correction.correctionOfRevision.id ||
        content.correctionOfRevision?.canonicalHash !== correction.correctionOfRevision.canonicalHash) {
      throw new TypeError('corrections require a prior revision and corrected stage/disposition');
    }
  } else if (content.correctionOfRevision || content.corrections.length > 0) {
    throw new TypeError('only a corrected receipt may link a correction revision');
  }
  if (content.stage === 'policy_evaluated' && (!content.policy || !content.explanation)) {
    throw new TypeError('policy evaluation requires policy and explanation links');
  }
  if (content.stage === 'policy_evaluated' && currentEvaluation?.disposition !== content.disposition) {
    throw new TypeError('policy stage disposition must match the latest evaluation');
  }
  if ((content.disposition === 'requires_approval' || content.disposition === 'allowed') &&
      (!content.candidateAction || !content.policy || !content.explanation)) {
    throw new TypeError('actionable policy disposition requires candidate, policy, and explanation links');
  }
  if (content.stage === 'approval_recorded' && !content.approvalRequest) {
    throw new TypeError('approval stage requires an approval request link');
  }
  if (content.stage === 'approval_recorded' && currentEvaluation?.disposition !== 'requires_approval') {
    throw new TypeError('approval stage requires a policy evaluation that requested approval');
  }
  if (content.stage === 'approval_recorded' && content.approvalRequest) {
    const expectedApprovalStatus = content.disposition === 'requires_approval'
      ? 'pending'
      : content.disposition;
    if (content.approvalRequest.snapshot.status !== expectedApprovalStatus) {
      throw new TypeError('approval snapshot status must match the recorded disposition');
    }
  }
  if (content.stage === 'approval_recorded' &&
      (!content.candidateAction || !content.policy || !content.explanation || !content.barrier)) {
    throw new TypeError('approval stage requires candidate, risk, policy, barrier, and explanation links');
  }
  if ((content.disposition === 'approved' || content.disposition === 'rejected' ||
      content.disposition === 'expired') &&
      !content.approvalRequest) {
    throw new TypeError('approval disposition requires an approval request link');
  }
  if (content.stage === 'execution_admitted' &&
      (!content.barrier || !content.candidateAction || !content.policy || !content.explanation ||
       !content.executionPlan)) {
    throw new TypeError('execution admission requires barrier, candidate, policy, explanation, and plan links');
  }
  if ((content.stage === 'execution_admitted' || content.stage === 'execution_recorded') &&
      currentEvaluation?.disposition !== 'allowed') {
    throw new TypeError('execution requires an allowed current policy evaluation');
  }
  if (content.stage === 'execution_recorded') {
    if (!content.barrier || !content.executionPlan || !content.candidateAction ||
        !content.risk || !content.policy || !content.explanation ||
        !['succeeded', 'failed', 'unknown'].includes(content.disposition)) {
      throw new TypeError('execution result stage requires the complete admitted action chain');
    }
    if ((content.disposition === 'succeeded' || content.disposition === 'failed') &&
        !content.executionResult) {
      throw new TypeError('known execution requires an execution result link');
    }
    if (content.executionDisposition !== content.disposition) {
      throw new TypeError('execution disposition must preserve terminal execution truth');
    }
    const expectedPlanStatus = content.disposition === 'succeeded' ? 'completed' :
      content.disposition === 'failed' ? 'failed' : null;
    if (content.barrier.snapshot.status !== content.disposition ||
        (expectedPlanStatus !== null && content.executionPlan.snapshot.status !== expectedPlanStatus) ||
        (content.disposition === 'unknown' && content.executionPlan.snapshot.status !== 'failed') ||
        (content.executionResult && content.executionResult.snapshot.outcome !== content.disposition) ||
        (content.disposition === 'succeeded' && content.executionResult?.snapshot.success !== true) ||
        (content.disposition !== 'succeeded' && content.executionResult?.snapshot.success === true)) {
      throw new TypeError('execution snapshots must match terminal execution truth');
    }
  } else if (content.executionPlan &&
      (content.stage === 'feedback_recorded' || content.stage === 'corrected')) {
    if (!content.executionDisposition) {
      throw new TypeError('later revisions must preserve terminal execution truth');
    }
  } else if (content.executionDisposition) {
    throw new TypeError('execution disposition requires an execution or later stage');
  }
  if (content.stage === 'feedback_recorded' && content.feedbackEvents.length === 0) {
    throw new TypeError('feedback stage requires a feedback event link');
  }
  if (content.stage === 'feedback_recorded' && content.executionDisposition &&
      content.disposition !== content.executionDisposition) {
    throw new TypeError('feedback disposition must preserve terminal execution truth');
  }
  if (content.disposition === 'deliberate_non_action' && !content.explanation) {
    throw new TypeError('deliberate non-action requires an explanation link');
  }
  const hasFutureActionState = !!(
    content.candidateAction || content.risk || content.policy || content.barrier || content.explanation ||
    content.approvalRequest || content.executionPlan || content.executionResult ||
    content.executionDisposition ||
    content.correctionOfRevision || content.evidence.length > 0 || content.feedbackEvents.length > 0
    || content.corrections.length > 0
  );
  if (content.stage === 'decision_recorded' && hasFutureActionState) {
    throw new TypeError('decision stage cannot contain later lifecycle artifacts');
  }
  if (content.stage === 'policy_evaluated' && currentEvaluation?.phase === 'pre_effect' && (
    content.approvalRequest || content.executionPlan || content.executionResult ||
    content.executionDisposition || content.feedbackEvents.length > 0 ||
    content.correctionOfRevision
  )) throw new TypeError('pre-effect policy stage cannot contain later lifecycle artifacts');
  if (content.stage === 'policy_evaluated' && currentEvaluation?.phase === 'post_approval' &&
      (!content.approvalRequest || content.approvalRequest.snapshot.status !== 'approved' ||
       content.policyEvaluations.length < 2 || content.executionPlan ||
       content.executionResult || content.executionDisposition || content.feedbackEvents.length > 0 ||
       content.correctionOfRevision)) {
    throw new TypeError('post-approval policy recheck requires the approved request');
  }
  if (content.stage === 'approval_recorded' && (
    content.executionPlan || content.executionResult || content.executionDisposition ||
    content.feedbackEvents.length > 0 ||
    content.correctionOfRevision
  )) throw new TypeError('approval stage cannot contain later lifecycle artifacts');
  if (content.stage === 'execution_admitted' && (
    content.executionResult || content.executionDisposition || content.feedbackEvents.length > 0 ||
    content.correctionOfRevision
  )) throw new TypeError('execution admission cannot contain later lifecycle artifacts');
  if (content.stage === 'execution_recorded' && (
    content.feedbackEvents.length > 0 ||
    content.correctionOfRevision
  )) throw new TypeError('execution stage cannot contain later lifecycle artifacts');
  if (content.stage === 'feedback_recorded' && (
    content.correctionOfRevision
  )) throw new TypeError('feedback stage cannot contain correction artifacts');
  if (content.stage === 'policy_evaluated' && content.barrier) {
    const expected = content.disposition === 'allowed' ? 'prepared' : 'blocked';
    if (content.barrier.snapshot.status !== expected) {
      throw new TypeError('policy barrier state must match its disposition');
    }
  }
  if (content.stage === 'approval_recorded' && content.barrier?.snapshot.status !== 'blocked') {
    throw new TypeError('approval stage must retain the blocked approval barrier');
  }
  if (content.stage === 'execution_admitted' && content.barrier &&
      (!['prepared', 'in_progress'].includes(content.barrier.snapshot.status) ||
       !['pending', 'running', 'in_progress'].includes(content.executionPlan!.snapshot.status))) {
    throw new TypeError('execution admission snapshots must be pre-dispatch states');
  }
  const allowedByStage: Record<DecisionReceiptStage, readonly DecisionReceiptDisposition[]> = {
    decision_recorded: ['pending'],
    policy_evaluated: ['allowed', 'deliberate_non_action', 'requires_approval', 'blocked'],
    approval_recorded: ['requires_approval', 'approved', 'rejected', 'expired'],
    execution_admitted: ['pending'],
    execution_recorded: ['succeeded', 'failed', 'unknown'],
    feedback_recorded: [
      'deliberate_non_action', 'approved', 'rejected', 'expired', 'blocked',
      'succeeded', 'failed', 'unknown',
    ],
    corrected: ['corrected'],
  };
  if (!allowedByStage[content.stage].includes(content.disposition)) {
    throw new TypeError('joined receipt stage and disposition are inconsistent');
  }
  canonicalJson(content);
}

/** Legal cumulative-snapshot lifecycle edge for an immutable receipt chain. */
export function isJoinedDecisionReceiptTransition(
  previous: JoinedDecisionReceiptContent,
  next: JoinedDecisionReceiptContent,
): boolean {
  if (previous.version === 3 && next.version !== 3) return false;
  if (previous.version !== 3 && next.version === 3 && next.stage !== 'feedback_recorded') return false;
  if (previous.version === 2 && next.version === 1) return false;
  if (previous.version === 1 && next.version === 2 &&
      (previous.stage !== 'execution_admitted' || next.stage !== 'execution_recorded')) {
    return false;
  }
  if (previous.stage === 'decision_recorded') return next.stage === 'policy_evaluated';
  if (previous.stage === 'policy_evaluated') {
    if (previous.disposition === 'allowed') return next.stage === 'execution_admitted';
    if (previous.disposition === 'requires_approval') return next.stage === 'approval_recorded';
    return next.stage === 'feedback_recorded' || next.stage === 'corrected';
  }
  if (previous.stage === 'approval_recorded') {
    if (previous.disposition === 'requires_approval') return next.stage === 'approval_recorded';
    if (previous.disposition === 'approved') {
      const nextEvaluation = next.policyEvaluations[next.policyEvaluations.length - 1];
      return next.stage === 'policy_evaluated' && nextEvaluation?.phase === 'post_approval';
    }
    return next.stage === 'feedback_recorded' || next.stage === 'corrected';
  }
  if (previous.stage === 'execution_admitted') return next.stage === 'execution_recorded';
  if (previous.stage === 'execution_recorded') {
    return next.stage === 'feedback_recorded' || next.stage === 'corrected';
  }
  if (previous.stage === 'feedback_recorded') {
    return next.stage === 'feedback_recorded' || next.stage === 'corrected';
  }
  return next.stage === 'corrected';
}

function sameReceiptRef(
  previous: { id: string; canonicalHash: string } | undefined,
  next: { id: string; canonicalHash: string } | undefined,
): boolean {
  return !previous || (!!next && previous.id === next.id &&
    previous.canonicalHash === next.canonicalHash);
}

function approvalMayAdvance(previous: DecisionReceiptApprovalRef | undefined, next: DecisionReceiptApprovalRef | undefined): boolean {
  if (!previous) return true;
  if (!next || previous.id !== next.id) return false;
  const from = previous.snapshot;
  const to = next.snapshot;
  const statusOkay = from.status === to.status ||
    (from.status === 'pending' && ['approved', 'rejected', 'expired'].includes(to.status));
  return statusOkay && from.candidateActionId === to.candidateActionId &&
    from.requestedAt === to.requestedAt && from.expiresAt === to.expiresAt;
}

function barrierMayAdvance(previous: DecisionReceiptBarrierRef, next: DecisionReceiptBarrierRef): boolean {
  if (previous.id !== next.id) return false;
  const from = previous.snapshot;
  const to = next.snapshot;
  const allowed: Record<DecisionReceiptBarrierSnapshotV1['status'], readonly DecisionReceiptBarrierSnapshotV1['status'][]> = {
    reserved: ['reserved', 'prepared', 'blocked'],
    prepared: ['prepared', 'in_progress', 'succeeded', 'blocked', 'failed', 'unknown'],
    in_progress: ['in_progress', 'succeeded', 'failed', 'unknown'],
    succeeded: ['succeeded'], blocked: ['blocked'], failed: ['failed'], unknown: ['unknown'],
  };
  return allowed[from.status].includes(to.status) && from.effectType === to.effectType &&
    from.decisionId === to.decisionId && from.candidateActionId === to.candidateActionId &&
    from.explanationId === to.explanationId && from.policyHash === to.policyHash &&
    from.createdAt === to.createdAt;
}

function planMayAdvance(previous: DecisionReceiptExecutionPlanRef | undefined, next: DecisionReceiptExecutionPlanRef | undefined): boolean {
  if (!previous) return true;
  if (!next || previous.id !== next.id) return false;
  const from = previous.snapshot;
  const to = next.snapshot;
  const allowed: Record<DecisionReceiptExecutionPlanSnapshotV1['status'], readonly DecisionReceiptExecutionPlanSnapshotV1['status'][]> = {
    pending: ['pending', 'running', 'in_progress', 'completed', 'failed'],
    running: ['running', 'in_progress', 'completed', 'failed'],
    in_progress: ['in_progress', 'completed', 'failed'],
    completed: ['completed'], failed: ['failed'],
  };
  return allowed[from.status].includes(to.status) && from.decisionId === to.decisionId &&
    from.candidateActionId === to.candidateActionId && from.createdAt === to.createdAt;
}

/** Preserve every established artifact and known terminal fact across snapshots. */
export function preservesJoinedDecisionReceiptLinks(
  previous: JoinedDecisionReceiptContent,
  next: JoinedDecisionReceiptContent,
): boolean {
  if (!isJoinedDecisionReceiptTransition(previous, next)) return false;
  // The approval request is a historical event, not optional context that a
  // later snapshot may backfill. It can enter the chain only at the stage
  // that records the request; every later stage may only preserve/advance it.
  if (!previous.approvalRequest && next.approvalRequest &&
      next.stage !== 'approval_recorded') return false;
  if ((next.stage === 'feedback_recorded' || next.stage === 'corrected') &&
      ((!previous.executionPlan && next.executionPlan) ||
       (!previous.executionResult && next.executionResult))) return false;
  if (next.stage === 'feedback_recorded' && next.disposition !== previous.disposition) return false;
  if (previous.executionDisposition !== undefined &&
      previous.executionDisposition !== next.executionDisposition) return false;
  const addsPreEffectEvaluation = previous.stage === 'decision_recorded' &&
    next.stage === 'policy_evaluated' &&
    next.policyEvaluations[next.policyEvaluations.length - 1]?.phase === 'pre_effect';
  const addsPostApprovalEvaluation = previous.stage === 'approval_recorded' &&
    previous.disposition === 'approved' && next.stage === 'policy_evaluated' &&
    next.policyEvaluations[next.policyEvaluations.length - 1]?.phase === 'post_approval';
  const addsEvaluation = addsPreEffectEvaluation || addsPostApprovalEvaluation;
  const priorEvaluationsPreserved = previous.policyEvaluations.every((evaluation, index) =>
    joinedDecisionReceiptArtifactDigest('policy_evaluation', evaluation) ===
      joinedDecisionReceiptArtifactDigest('policy_evaluation', next.policyEvaluations[index]));
  if (!priorEvaluationsPreserved ||
      next.policyEvaluations.length !== previous.policyEvaluations.length + (addsEvaluation ? 1 : 0)) {
    return false;
  }
  const candidatePreserved = sameReceiptRef(previous.candidateAction, next.candidateAction) ||
    (addsEvaluation && (!previous.candidateAction || previous.candidateAction.id === next.candidateAction?.id));
  const approvalIntroducedAtApprovalStage = previous.approvalRequest !== undefined ||
    next.approvalRequest === undefined || next.stage === 'approval_recorded';
  if (!sameReceiptRef(previous.decision, next.decision) ||
      !candidatePreserved ||
      !(sameReceiptRef(previous.explanation, next.explanation) ||
        addsEvaluation) ||
      !approvalIntroducedAtApprovalStage ||
      !approvalMayAdvance(previous.approvalRequest, next.approvalRequest) ||
      !planMayAdvance(previous.executionPlan, next.executionPlan) ||
      !sameReceiptRef(previous.executionResult, next.executionResult) ||
      !sameReceiptRef(previous.inference.completion, next.inference.completion)) return false;
  const previousExecutionExplanation = previous.version === 2 || previous.version === 3
    ? previous.executionExplanation
    : undefined;
  const nextExecutionExplanation = next.version === 2 || next.version === 3
    ? next.executionExplanation
    : undefined;
  if (previousExecutionExplanation &&
      !sameReceiptRef(previousExecutionExplanation, nextExecutionExplanation)) return false;
  if (!previousExecutionExplanation && nextExecutionExplanation &&
      !(previous.version === 1 && previous.stage === 'execution_admitted' &&
        next.version === 2 && next.stage === 'execution_recorded')) return false;
  if (previous.version === 3 && next.version === 3 && (
      next.feedbackApplication.id !== previous.feedbackApplication.id ||
      next.feedbackApplication.canonicalHash !== previous.feedbackApplication.canonicalHash)) return false;
  if (previous.barrier && next.barrier && !addsEvaluation &&
      !barrierMayAdvance(previous.barrier, next.barrier)) return false;
  if (previous.barrier && !next.barrier) return false;
  if (previous.barrier && next.barrier && previous.barrier.id !== next.barrier.id &&
      !addsEvaluation) return false;
  if (previous.risk && (!next.risk || previous.risk.candidateActionId !== next.risk.candidateActionId ||
      (!addsEvaluation && previous.risk.canonicalHash !== next.risk.canonicalHash))) return false;
  if (previous.policy && (!next.policy || (
      !addsEvaluation &&
      (previous.policy.barrierId !== next.policy.barrierId ||
       previous.policy.canonicalHash !== next.policy.canonicalHash ||
       previous.policy.policyIds.join('\0') !== next.policy.policyIds.join('\0'))
  ))) return false;
  const includesRefs = (
    prior: readonly { id: string; canonicalHash: string }[],
    later: readonly { id: string; canonicalHash: string }[],
  ) => prior.every((ref) => later.some((item) =>
    item.id === ref.id && item.canonicalHash === ref.canonicalHash));
  const priorCorrectionsPreserved = previous.corrections.every((correction, index) =>
    joinedDecisionReceiptArtifactDigest('correction', correction) ===
      joinedDecisionReceiptArtifactDigest('correction', next.corrections[index]));
  const correctionCountOkay = next.corrections.length === previous.corrections.length +
    (next.stage === 'corrected' ? 1 : 0);
  const completedInferenceSetUnchanged = previous.inference.completion === undefined ||
    next.inference.receipts.length === previous.inference.receipts.length;
  return (addsEvaluation || includesRefs(previous.evidence, next.evidence)) &&
    includesRefs(previous.inference.receipts, next.inference.receipts) &&
    completedInferenceSetUnchanged &&
    includesRefs(previous.feedbackEvents, next.feedbackEvents) &&
    priorCorrectionsPreserved && correctionCountOkay;
}

export function isDecisionReceiptEventKey(value: unknown): value is DecisionReceiptEventKey {
  return typeof value === 'string' && EVENT_KEY.test(value);
}

export function buildDecisionReceiptEventKey(kind: string, eventId: string): DecisionReceiptEventKey {
  const value = `${kind}:${eventId}`;
  if (!isDecisionReceiptEventKey(value)) throw new TypeError('invalid joined receipt event key');
  return value;
}

export function canonicalJoinedDecisionReceiptContent(
  content: JoinedDecisionReceiptContent,
): string {
  validateJoinedDecisionReceiptContent(content);
  return canonicalJson(content);
}

export function joinedDecisionReceiptContentDigest(
  content: JoinedDecisionReceiptContent,
): DecisionReceiptDigest {
  return createHash('sha256')
    .update(canonicalJoinedDecisionReceiptContent(content), 'utf8')
    .digest('hex');
}

/** Domain-separated digest that commits to chain order, identity, event, and content. */
export function joinedDecisionReceiptRevisionDigest(
  input: DecisionReceiptRevisionDigestInput,
): DecisionReceiptDigest {
  if (!UUID.test(input.revisionId) || !UUID.test(input.receiptId) ||
      !UUID.test(input.decisionId) || !UUID.test(input.userId) ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
      !isDecisionReceiptEventKey(input.eventKey) || !SHA256.test(input.contentDigest) ||
      (input.previousDigest !== null && !SHA256.test(input.previousDigest))) {
    throw new TypeError('invalid joined receipt revision digest input');
  }
  return createHash('sha256')
    .update('skytwin.joined-decision-receipt/revision/v1\0', 'utf8')
    .update(canonicalJson(input), 'utf8')
    .digest('hex');
}

/** Normalize Cockroach INT8 values without accepting JavaScript coercions. */
export function normalizeDecisionReceiptSequence(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 && String(normalized) === value
    ? normalized
    : null;
}

/** Verify a retained repository hash chain before it is displayed or exported. */
export function verifyJoinedDecisionReceiptChain(input: {
  receiptId: string;
  decisionId: string;
  userId: string;
  revisions: readonly DecisionReceiptChainRevisionV1[];
}): boolean {
  if (!UUID.test(input.receiptId) || !UUID.test(input.decisionId) ||
      !UUID.test(input.userId) || input.revisions.length === 0) return false;
  let previousDigest: string | null = null;
  let previousContent: JoinedDecisionReceiptContent | null = null;
  const eventKeys = new Set<string>();
  const revisionIds = new Set<string>();
  const revisionDigests = new Map<string, string>();
  for (let index = 0; index < input.revisions.length; index += 1) {
    const revision = input.revisions[index]!;
    const sequence = normalizeDecisionReceiptSequence(revision.sequence);
    if (sequence === null) return false;
    try {
      validateJoinedDecisionReceiptContent(revision.content);
      const contentDigest = joinedDecisionReceiptContentDigest(revision.content);
      const revisionDigest = joinedDecisionReceiptRevisionDigest({
        revisionId: revision.id,
        receiptId: input.receiptId,
        decisionId: input.decisionId,
        userId: input.userId,
        sequence,
        eventKey: revision.event_key,
        previousDigest,
        contentDigest,
      });
      const correction = revision.content.correctionOfRevision;
      if (sequence !== index + 1 ||
          revision.previous_digest !== previousDigest ||
          revision.content_digest !== contentDigest || revision.revision_digest !== revisionDigest ||
          revision.stage !== revision.content.stage || revision.disposition !== revision.content.disposition ||
          revision.candidate_action_id !== (revision.content.candidateAction?.id ?? null) ||
          revision.barrier_id !== (revision.content.barrier?.id ?? null) ||
          revision.explanation_id !== (revision.content.explanation?.id ?? null) ||
          revision.approval_request_id !== (revision.content.approvalRequest?.id ?? null) ||
          revision.execution_plan_id !== (revision.content.executionPlan?.id ?? null) ||
          revision.execution_result_id !== (revision.content.executionResult?.id ?? null) ||
          revision.execution_disposition !== (revision.content.executionDisposition ?? null) ||
          revision.correction_of_revision_id !== (correction?.id ?? null) ||
          revision.content.decision.id !== input.decisionId || eventKeys.has(revision.event_key) ||
          revisionIds.has(revision.id) ||
          (index === 0 && revision.content.stage !== 'decision_recorded') ||
          (previousContent !== null && !preservesJoinedDecisionReceiptLinks(previousContent, revision.content)) ||
          (correction !== undefined && revisionDigests.get(correction.id) !== correction.canonicalHash)) {
        return false;
      }
    } catch {
      return false;
    }
    eventKeys.add(revision.event_key);
    revisionIds.add(revision.id);
    revisionDigests.set(revision.id, revision.revision_digest);
    previousDigest = revision.revision_digest;
    previousContent = revision.content;
  }
  return true;
}

/** Hash a server-derived, artifact-kind/version-separated JSON projection. */
export function joinedDecisionReceiptArtifactDigest(
  kind: DecisionReceiptArtifactKind,
  value: unknown,
): DecisionReceiptDigest {
  return createHash('sha256')
    .update(`skytwin.joined-decision-receipt/artifact/${kind}/v1\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}
