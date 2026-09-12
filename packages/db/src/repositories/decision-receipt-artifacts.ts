import {
  joinedDecisionReceiptArtifactDigest,
  type DecisionReceiptApprovalRef,
  type DecisionReceiptApprovalSnapshotV1,
  type DecisionReceiptArtifactKind,
  type DecisionReceiptArtifactRef,
  type DecisionReceiptBarrierRef,
  type DecisionReceiptBarrierSnapshotV1,
  type DecisionReceiptEvidenceRef,
  type DecisionReceiptExecutionPlanRef,
  type DecisionReceiptExecutionPlanSnapshotV1,
  type DecisionReceiptExecutionResultRef,
  type DecisionReceiptExecutionResultSnapshotV1,
  type DecisionReceiptFeedbackApplicationRef,
  type DecisionReceiptFeedbackApplicationSnapshotV1,
} from '@skytwin/shared-types';
import type { ApprovalRequestRow, ExecutionPlanRow, ExecutionResultRow } from '../types.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

export type DecisionReceiptRowArtifactKind = Extract<
  DecisionReceiptArtifactKind,
  'decision' | 'candidate_action' | 'explanation' | 'signal' | 'preference' |
  'feedback' | 'inference_completion'
>;

const V1_FIELDS: Record<DecisionReceiptRowArtifactKind, readonly string[]> = {
  decision: [
    'id', 'user_id', 'situation_type', 'raw_event', 'interpreted_situation',
    'domain', 'urgency', 'metadata', 'signal_id',
  ],
  candidate_action: [
    'id', 'decision_id', 'action_type', 'description', 'parameters',
    'predicted_user_preference', 'risk_assessment', 'reversible', 'estimated_cost',
  ],
  explanation: [
    'id', 'decision_id', 'what_happened', 'evidence_used', 'preferences_invoked',
    'confidence_reasoning', 'action_rationale', 'escalation_rationale',
    'correction_guidance', 'capability_provenance_node_id',
  ],
  signal: [
    'id', 'user_id', 'source', 'type', 'domain', 'data', 'timestamp', 'retention_until',
  ],
  preference: [
    'id', 'user_id', 'domain', 'key', 'value', 'confidence', 'source', 'evidence',
    'version', 'value_encrypted', 'evidence_encrypted', 'encryption_key_version',
  ],
  feedback: ['id', 'user_id', 'decision_id', 'type', 'data'],
  inference_completion: ['decision_id', 'explanation_id', 'completed_at'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface FeedbackApplicationArtifactInput {
  readonly id: string;
  readonly feedbackEventId: string;
  readonly userId: string;
  readonly decisionId: string;
  readonly profileId: string;
  readonly inputProfileVersion: number;
  readonly outputProfileVersion: number;
  readonly changed: boolean;
  readonly outputDigest: string;
  readonly appliedAt: string;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function isoInstant(value: Date): string {
  return value.toISOString();
}

/**
 * Stable v1 projection for row-backed receipt artifacts. Unknown/future DB
 * columns are deliberately ignored; changing this allowlist requires v2.
 */
export function decisionReceiptRowArtifactV1(
  kind: DecisionReceiptRowArtifactKind,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const field of V1_FIELDS[kind]) {
    if (Object.prototype.hasOwnProperty.call(row, field)) projection[field] = normalize(row[field]);
  }
  return projection;
}

/** Build a canonical reference from a row already returned by the database. */
export function decisionReceiptRowArtifactRefV1(
  kind: DecisionReceiptRowArtifactKind,
  row: Record<string, unknown>,
): DecisionReceiptArtifactRef {
  const id = kind === 'inference_completion' ? row['decision_id'] : row['id'];
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError(`cannot build ${kind} receipt reference without a UUID`);
  }
  return {
    id,
    canonicalHash: joinedDecisionReceiptArtifactDigest(kind, decisionReceiptRowArtifactV1(kind, row)),
  };
}

/** Canonical receipt reference for a verified DB-owned twin feedback application. */
export function decisionReceiptFeedbackApplicationRefV1(
  application: FeedbackApplicationArtifactInput,
): DecisionReceiptFeedbackApplicationRef {
  if (!UUID.test(application.id) || !UUID.test(application.feedbackEventId) ||
      !UUID.test(application.userId) || !UUID.test(application.decisionId) ||
      !UUID.test(application.profileId) ||
      !Number.isSafeInteger(application.inputProfileVersion) ||
      application.inputProfileVersion < 1 ||
      !Number.isSafeInteger(application.outputProfileVersion) ||
      application.outputProfileVersion < 1 || typeof application.changed !== 'boolean' ||
      !SHA256.test(application.outputDigest) ||
      (application.changed
        ? application.outputProfileVersion !== application.inputProfileVersion + 1
        : application.outputProfileVersion !== application.inputProfileVersion)) {
    throw new TypeError('cannot build an invalid feedback application reference');
  }
  const snapshot: DecisionReceiptFeedbackApplicationSnapshotV1 = {
    version: 1,
    feedbackEventId: application.feedbackEventId,
    userId: application.userId,
    decisionId: application.decisionId,
    profileId: application.profileId,
    inputProfileVersion: application.inputProfileVersion,
    outputProfileVersion: application.outputProfileVersion,
    changed: application.changed,
    outputDigest: application.outputDigest,
    appliedAt: application.appliedAt,
  };
  return {
    id: application.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('feedback_application', snapshot),
    snapshot,
  };
}

/** Evidence references keep their artifact kind explicit in cumulative snapshots. */
export function decisionReceiptRowEvidenceRefV1(
  kind: 'signal' | 'preference',
  row: Record<string, unknown>,
): DecisionReceiptEvidenceRef {
  return { ...decisionReceiptRowArtifactRefV1(kind, row), kind };
}

/** Canonical approval snapshot/reference derived from the inserted database row. */
export function decisionReceiptApprovalRefV1(
  row: ApprovalRequestRow,
): DecisionReceiptApprovalRef {
  const candidate = row.candidate_action;
  const candidateActionId = candidate['id'];
  if (!UUID.test(row.id) || typeof candidateActionId !== 'string' || !UUID.test(candidateActionId)) {
    throw new TypeError('cannot build approval receipt reference without a candidate UUID');
  }
  const snapshot: DecisionReceiptApprovalSnapshotV1 = {
    version: 1,
    status: row.status as DecisionReceiptApprovalSnapshotV1['status'],
    candidateActionId,
    requestedAt: isoInstant(row.requested_at),
    expiresAt: isoInstant(row.expires_at),
    respondedAt: row.responded_at === null ? null : isoInstant(row.responded_at),
  };
  return {
    id: row.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('approval', snapshot),
    snapshot,
  };
}

/** Canonical barrier snapshot/reference derived from the inserted database row. */
export function decisionReceiptBarrierRefV1(
  row: PreEffectBarrierRow,
): DecisionReceiptBarrierRef {
  const snapshot: DecisionReceiptBarrierSnapshotV1 = {
    version: 1,
    status: row.status,
    effectType: row.effect_type,
    decisionId: row.decision_id ?? '',
    candidateActionId: row.action_id,
    explanationId: row.explanation_id,
    policyHash: joinedDecisionReceiptArtifactDigest('policy', row.policy_snapshot),
    createdAt: isoInstant(row.created_at),
    updatedAt: isoInstant(row.updated_at),
  };
  if (!UUID.test(row.id) || !UUID.test(snapshot.decisionId)) {
    throw new TypeError('cannot build barrier receipt reference without a decision UUID');
  }
  return {
    id: row.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', snapshot),
    snapshot,
  };
}

/** Canonical execution-plan snapshot/reference derived from a database row. */
export function decisionReceiptExecutionPlanRefV1(
  row: ExecutionPlanRow,
): DecisionReceiptExecutionPlanRef {
  const snapshot: DecisionReceiptExecutionPlanSnapshotV1 = {
    version: 1,
    status: row.status as DecisionReceiptExecutionPlanSnapshotV1['status'],
    decisionId: row.decision_id,
    candidateActionId: row.action_id,
    createdAt: isoInstant(row.created_at),
    updatedAt: isoInstant(row.updated_at),
  };
  return {
    id: row.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', snapshot),
    snapshot,
  };
}

/** Canonical execution-result snapshot/reference derived from a database row. */
export function decisionReceiptExecutionResultRefV1(
  row: ExecutionResultRow,
  outcome: DecisionReceiptExecutionResultSnapshotV1['outcome'],
): DecisionReceiptExecutionResultRef {
  const snapshot: DecisionReceiptExecutionResultSnapshotV1 = {
    version: 1,
    planId: row.plan_id,
    success: row.success,
    outcome,
    rollbackAvailable: row.rollback_available,
    completedAt: isoInstant(row.completed_at),
  };
  return {
    id: row.id,
    canonicalHash: joinedDecisionReceiptArtifactDigest('execution_result', snapshot),
    snapshot,
  };
}
