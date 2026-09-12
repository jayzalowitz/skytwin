import {
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  isDecisionReceiptEventKey,
  preservesJoinedDecisionReceiptLinks,
  normalizeDecisionReceiptSequence,
  verifyJoinedDecisionReceiptChain,
  validateJoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContent,
  type DecisionReceiptEventKey,
  type DecisionReceiptArtifactKind,
  type DecisionReceiptExecutionPlanSnapshotV1,
  type DecisionReceiptExecutionResultSnapshotV1,
  type DecisionReceiptPreferenceHistorySnapshotV1,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../connection.js';
import type { ApprovalRequestRow, DecisionReceiptRevisionRow, DecisionReceiptRow } from '../types.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';
import {
  decisionReceiptRowArtifactV1,
  decisionReceiptApprovalRefV1,
  decisionReceiptBarrierRefV1,
  type DecisionReceiptRowArtifactKind,
} from './decision-receipt-artifacts.js';

export type AppendDecisionReceiptFailureCode =
  | 'invalid_content'
  | 'linkage_mismatch'
  | 'chain_conflict'
  | 'idempotency_conflict';

export type AppendDecisionReceiptResult =
  | {
      success: true;
      created: boolean;
      receipt: DecisionReceiptRow;
      revision: DecisionReceiptRevisionRow;
    }
  | { success: false; code: AppendDecisionReceiptFailureCode };

export type FindDecisionReceiptResult =
  | { success: true; receipt: DecisionReceiptRow; revisions: DecisionReceiptRevisionRow[] }
  | { success: false; code: 'verification_failed' }
  | null;

export interface AppendDecisionReceiptInput {
  eventKey: DecisionReceiptEventKey;
  expectedPreviousDigest: string | null;
  content: JoinedDecisionReceiptContent;
  /** Optional caller-owned IDs keep whole-transaction retries byte-stable. */
  receiptId?: string;
  revisionId?: string;
  /** Optional caller-owned timestamp keeps whole-transaction retries stable. */
  createdAt?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCanonicalIsoInstant(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function normalizeRevisionRow(
  row: DecisionReceiptRevisionRow | undefined,
): DecisionReceiptRevisionRow | null {
  if (!row) return null;
  const sequence = normalizeDecisionReceiptSequence(row.sequence);
  return sequence === null ? null : { ...row, sequence };
}

async function loadVerifiedRetainedChain(
  client: PoolClient,
  receipt: DecisionReceiptRow,
): Promise<DecisionReceiptRevisionRow[] | null> {
  const raw = (await client.query<DecisionReceiptRevisionRow>(
    'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
    [receipt.id],
  )).rows;
  const normalized = raw.map((revision) => normalizeRevisionRow(revision));
  if (normalized.some((revision) => revision === null)) return null;
  const revisions = normalized as DecisionReceiptRevisionRow[];
  if (revisions.some((revision) => !revision.trusted)) return null;
  if (revisions.length > 0 && !verifyJoinedDecisionReceiptChain({
    receiptId: receipt.id,
    decisionId: receipt.decision_id,
    userId: receipt.user_id,
    revisions,
  })) return null;
  return revisions;
}

async function hasExactly(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
  expected: number,
): Promise<boolean> {
  const result = await client.query<{ count: string }>(sql, [...params]);
  return Number(result.rows[0]?.count ?? -1) === expected;
}

function isoInstant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function executionPlanSnapshot(row: Record<string, unknown>): DecisionReceiptExecutionPlanSnapshotV1 {
  return {
    version: 1,
    status: String(row['status']) as DecisionReceiptExecutionPlanSnapshotV1['status'],
    decisionId: String(row['decision_id']),
    candidateActionId: row['action_id'] == null ? null : String(row['action_id']),
    createdAt: isoInstant(row['created_at']),
    updatedAt: isoInstant(row['updated_at']),
  };
}

function executionResultSnapshot(
  row: Record<string, unknown>,
  outcome: DecisionReceiptExecutionResultSnapshotV1['outcome'],
): DecisionReceiptExecutionResultSnapshotV1 {
  return {
    version: 1,
    planId: String(row['plan_id']),
    success: row['success'] === true,
    outcome,
    rollbackAvailable: row['rollback_available'] === true,
    completedAt: isoInstant(row['completed_at']),
  };
}

function preferenceHistorySnapshot(row: Record<string, unknown>): DecisionReceiptPreferenceHistorySnapshotV1 {
  return {
    version: 1,
    learnedSubjectId: String(row['preference_id']),
    attributionType: 'feedback',
    attributionId: String(row['attribution_id']),
    changedAt: isoInstant(row['changed_at']),
    previousValueHash: row['previous_value'] == null ? null :
      joinedDecisionReceiptArtifactDigest('preference_history_value', row['previous_value']),
    newValueHash: joinedDecisionReceiptArtifactDigest('preference_history_value', row['new_value']),
    previousConfidence: row['previous_confidence'] == null ? null : String(row['previous_confidence']),
    newConfidence: String(row['new_confidence']),
  };
}

function snapshotMatches(
  kind: DecisionReceiptArtifactKind,
  expected: { snapshot: object; canonicalHash: string },
  derived: object,
): boolean {
  const derivedHash = joinedDecisionReceiptArtifactDigest(kind, derived);
  return derivedHash === expected.canonicalHash &&
    joinedDecisionReceiptArtifactDigest(kind, expected.snapshot) === derivedHash;
}

function containsExactString(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      return containsExactString(JSON.parse(value) as unknown, target);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, target));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsExactString(item, target));
  }
  return false;
}

async function artifactMatches(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
  expectedHash: string,
  kind: DecisionReceiptRowArtifactKind,
): Promise<boolean> {
  const result = await client.query<Record<string, unknown>>(sql, [...params]);
  const row = result.rows[0];
  return !!row && result.rows.length === 1 &&
    joinedDecisionReceiptArtifactDigest(kind, decisionReceiptRowArtifactV1(kind, row)) === expectedHash;
}

async function linkageIsOwned(
  client: PoolClient,
  userId: string,
  content: JoinedDecisionReceiptContent,
  previous?: JoinedDecisionReceiptContent,
): Promise<boolean> {
  const decisionId = content.decision.id;
  let barrierStatus: unknown = content.barrier?.snapshot.status;
  let approvalStatus: unknown = content.approvalRequest?.snapshot.status;
  let executionPlanStatus: unknown = content.executionPlan?.snapshot.status;
  let executionResultSuccess: unknown = content.executionResult?.snapshot.success;
  let explanationEvidence: unknown;
  let barrierPolicySnapshot: unknown;
  let decisionSignalId: unknown;
  const currentEvaluation = content.policyEvaluations[content.policyEvaluations.length - 1];
  const previousEvaluation = previous?.policyEvaluations[previous.policyEvaluations.length - 1];
  const evaluationPreviouslyValidated = !!currentEvaluation && !!previousEvaluation &&
    joinedDecisionReceiptArtifactDigest('policy_evaluation', currentEvaluation) ===
      joinedDecisionReceiptArtifactDigest('policy_evaluation', previousEvaluation);
  const decisionResult = await client.query<Record<string, unknown>>(
    'SELECT * FROM decisions WHERE id = $1 AND user_id = $2',
    [decisionId, userId],
  );
  if (decisionResult.rows.length !== 1 || (!previous && joinedDecisionReceiptArtifactDigest('decision',
    decisionReceiptRowArtifactV1('decision', decisionResult.rows[0]!),
  ) !== content.decision.canonicalHash)) return false;
  const decisionRow = decisionResult.rows[0]!;
  decisionSignalId = decisionRow['signal_id'];
  const rawEvent = decisionRow['raw_event'];
  const decisionMessageRefId = rawEvent && typeof rawEvent === 'object' && !Array.isArray(rawEvent) &&
    typeof (rawEvent as Record<string, unknown>)['messageRefId'] === 'string'
    ? (rawEvent as Record<string, unknown>)['messageRefId']
    : null;
  const actionId = content.candidateAction?.id ?? content.risk?.candidateActionId;
  if (content.candidateAction && !evaluationPreviouslyValidated && !await artifactMatches(
    client,
    'SELECT * FROM candidate_actions WHERE id = $1 AND decision_id = $2',
    [content.candidateAction.id, decisionId],
    content.candidateAction.canonicalHash,
    'candidate_action',
  )) return false;

  if (!content.candidateAction && actionId && !await hasExactly(
    client,
    'SELECT count(*)::STRING AS count FROM candidate_actions WHERE id = $1 AND decision_id = $2',
    [actionId, decisionId], 1,
  )) return false;

  if (content.candidateAction && content.risk &&
      content.candidateAction.id !== content.risk.candidateActionId) return false;
  if (content.risk && !evaluationPreviouslyValidated) {
    const risk = await client.query<{ risk_assessment: unknown }>(
      'SELECT risk_assessment FROM candidate_actions WHERE id = $1 AND decision_id = $2',
      [content.risk.candidateActionId, decisionId],
    );
    if (!risk.rows[0] || joinedDecisionReceiptArtifactDigest('risk', risk.rows[0].risk_assessment) !==
        content.risk.canonicalHash) return false;
  }

  if (content.explanation) {
    const explanation = await client.query<Record<string, unknown>>(
      'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [content.explanation.id, decisionId],
    );
    if (!explanation.rows[0] || (!evaluationPreviouslyValidated && joinedDecisionReceiptArtifactDigest('explanation',
      decisionReceiptRowArtifactV1('explanation', explanation.rows[0]),
    ) !== content.explanation.canonicalHash)) return false;
    explanationEvidence = [
      explanation.rows[0]['evidence_used'],
      explanation.rows[0]['preferences_invoked'],
    ];
  }

  // The terminal explanation is a new v2 artifact, not an alias for the
  // policy explanation stored in revision.explanation_id. Verify it
  // independently against the same owned decision on every v2 append.
  if (content.version === 2) {
    const executionExplanation = await client.query<Record<string, unknown>>(
      'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [content.executionExplanation.id, decisionId],
    );
    if (executionExplanation.rows.length !== 1 ||
        joinedDecisionReceiptArtifactDigest('explanation',
          decisionReceiptRowArtifactV1('explanation', executionExplanation.rows[0]!),
        ) !== content.executionExplanation.canonicalHash) return false;
  }

  const joinedBarriers = content.barrier ? [content.barrier] : [];
  for (const ref of joinedBarriers) {
    const sameBarrier = previous?.barrier?.id === ref.id &&
      previous.barrier.canonicalHash === ref.canonicalHash;
    if (sameBarrier) continue;
    const result = await client.query<PreEffectBarrierRow>(
      `SELECT * FROM pre_effect_barriers
        WHERE id = $1 AND user_id = $2 AND decision_id = $3
          AND ($4::UUID IS NULL OR action_id = $4)
          AND ($5::UUID IS NULL OR explanation_id = $5)`,
      [ref.id, userId, decisionId, ref.snapshot.candidateActionId, ref.snapshot.explanationId],
    );
    const barrierRow = result.rows[0];
    const barrier = barrierRow ? decisionReceiptBarrierRefV1(barrierRow) : null;
    if (!barrier || !snapshotMatches('barrier', ref, barrier.snapshot)) return false;
    if (content.barrier?.id === ref.id) barrierStatus = barrierRow!.status;
    if (content.policy?.barrierId === ref.id) barrierPolicySnapshot = barrierRow!.policy_snapshot;
  }

  const evidenceByKind = new Map<'signal' | 'preference', string[]>([
    ['signal', []], ['preference', []],
  ]);
  for (const ref of content.evidence) evidenceByKind.get(ref.kind)!.push(ref.id);
  for (const [kind, ids] of evidenceByKind) {
    if (evaluationPreviouslyValidated) continue;
    if (ids.length === 0) continue;
    const table = kind === 'signal' ? 'signals' : 'preferences';
    if (!await hasExactly(
      client,
      `SELECT count(*)::STRING AS count FROM ${table} WHERE user_id = $1 AND id = ANY($2::UUID[])`,
      [userId, ids],
      ids.length,
    )) return false;
  }
  for (const ref of content.evidence) {
    if (evaluationPreviouslyValidated) continue;
    const table = ref.kind === 'signal' ? 'signals' : 'preferences';
    const evidenceResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE user_id = $1 AND id = $2`,
      [userId, ref.id],
    );
    const evidenceRow = evidenceResult.rows[0];
    if (!evidenceRow || evidenceResult.rows.length !== 1 ||
        joinedDecisionReceiptArtifactDigest(
          ref.kind,
          decisionReceiptRowArtifactV1(ref.kind, evidenceRow),
        ) !== ref.canonicalHash) return false;
    // Decisions may name signals.id directly. Earlier account-bound Gmail
    // decisions retained the stable connector source ID, so accept both while
    // binding either form to the opaque target through the owned signals row. The
    // database's composite signal -> gmail_message_refs FK enforces the
    // matching owner and connector account behind resource_ref_id.
    const isLegacyDecisionSignal = ref.kind === 'signal' && decisionSignalId === ref.id &&
      evidenceRow['source_signal_id'] == null && evidenceRow['connector_account_id'] == null &&
      evidenceRow['resource_ref_id'] == null;
    const isGmailDecisionSignal = ref.kind === 'signal' && evidenceRow['source'] === 'gmail' &&
      typeof evidenceRow['source_signal_id'] === 'string' &&
      (ref.id === decisionSignalId || evidenceRow['source_signal_id'] === decisionSignalId) &&
      typeof evidenceRow['connector_account_id'] === 'string' &&
      typeof evidenceRow['resource_ref_id'] === 'string' &&
      evidenceRow['resource_ref_id'] === decisionMessageRefId;
    const usedByExplanation = containsExactString(explanationEvidence, ref.id) ||
      ((isLegacyDecisionSignal || isGmailDecisionSignal) &&
        containsExactString(explanationEvidence, `raw_${decisionId}`));
    if (!usedByExplanation) return false;
  }

  const policyIds = [...(content.policy?.policyIds ?? [])];
  if (!evaluationPreviouslyValidated && policyIds.length > 0 && !await hasExactly(
    client,
    'SELECT count(*)::STRING AS count FROM action_policies WHERE user_id = $1 AND id = ANY($2::UUID[])',
    [userId, policyIds],
    policyIds.length,
  )) return false;
  if (content.policy && !evaluationPreviouslyValidated) {
    if (barrierPolicySnapshot === undefined ||
        joinedDecisionReceiptArtifactDigest('policy', barrierPolicySnapshot) !==
          content.policy.canonicalHash) return false;
    const snapshotPolicyIds = barrierPolicySnapshot && typeof barrierPolicySnapshot === 'object' &&
      Array.isArray((barrierPolicySnapshot as Record<string, unknown>)['policyIds'])
      ? (barrierPolicySnapshot as Record<string, unknown>)['policyIds']
      : [];
    if (JSON.stringify(snapshotPolicyIds) !== JSON.stringify(policyIds)) return false;
    if (content.stage === 'policy_evaluated') {
      const snapshot = barrierPolicySnapshot as Record<string, unknown>;
      if (content.disposition === 'allowed') {
        const expectedRequiresApproval = currentEvaluation?.phase === 'post_approval';
        if (!(snapshot['allowed'] === true &&
            snapshot['requiresApproval'] === expectedRequiresApproval)) return false;
      }
      if (content.disposition === 'requires_approval' && snapshot['requiresApproval'] !== true) return false;
      if (['blocked', 'deliberate_non_action'].includes(content.disposition) &&
          snapshot['allowed'] !== false) return false;
    }
  }

  const durableInference = (await client.query<{ id: string; receipt: unknown }>(
    'SELECT id, receipt FROM inference_receipts WHERE decision_id = $1 ORDER BY id ASC',
    [decisionId],
  )).rows;
  const previousInference = new Map(previous?.inference.receipts.map((ref) => [ref.id, ref]) ?? []);
  const previousInferenceIds = new Set(previousInference.keys());
  for (const row of durableInference) {
    const prior = previousInference.get(row.id);
    if (prior && joinedDecisionReceiptArtifactDigest('inference_receipt', row.receipt) !==
        prior.canonicalHash) return false;
  }
  const newlyJoinedInference = content.inference.receipts.filter((ref) => !previousInferenceIds.has(ref.id));
  const newlyDurableInference = durableInference.filter((row) => !previousInferenceIds.has(row.id));
  if (previous?.inference.completion &&
      (newlyJoinedInference.length > 0 || newlyDurableInference.length > 0)) return false;
  if (newlyDurableInference.length !== newlyJoinedInference.length) return false;
  for (let index = 0; index < newlyDurableInference.length; index += 1) {
    const row = newlyDurableInference[index]!;
    const ref = newlyJoinedInference[index]!;
    if (row.id !== ref.id ||
        joinedDecisionReceiptArtifactDigest('inference_receipt', row.receipt) !== ref.canonicalHash) {
      return false;
    }
  }
  if (!previous?.inference.completion) {
    const completion = await client.query<Record<string, unknown>>(
      'SELECT * FROM inference_receipt_completions WHERE decision_id = $1',
      [decisionId],
    );
    if ((completion.rows.length === 1) !== !!content.inference.completion) return false;
    if (content.inference.completion && (
      content.inference.completion.id !== decisionId ||
      joinedDecisionReceiptArtifactDigest('inference_completion',
        decisionReceiptRowArtifactV1('inference_completion', completion.rows[0]!)) !==
        content.inference.completion.canonicalHash
    )) return false;
  }

  if (content.approvalRequest) {
    const sameApproval = previous?.approvalRequest?.id === content.approvalRequest.id &&
      previous.approvalRequest.canonicalHash === content.approvalRequest.canonicalHash;
    if (!sameApproval) {
    const approval = await client.query<ApprovalRequestRow>(
      'SELECT * FROM approval_requests WHERE id = $1 AND user_id = $2 AND decision_id = $3',
      [content.approvalRequest.id, userId, decisionId],
    );
    const approvalRow = approval.rows[0];
    const approvalRef = approvalRow ? decisionReceiptApprovalRefV1(approvalRow) : null;
    if (!approvalRef || !snapshotMatches('approval', content.approvalRequest, approvalRef.snapshot)) return false;
    approvalStatus = approvalRow!.status;
    const approvedCandidate = approvalRow!.candidate_action;
    if (content.candidateAction && (
      !approvedCandidate || typeof approvedCandidate !== 'object' ||
      (approvedCandidate as Record<string, unknown>)['id'] !== content.candidateAction.id
    )) return false;
    }
  }

  if (content.executionPlan) {
    const samePlan = previous?.executionPlan?.id === content.executionPlan.id &&
      previous.executionPlan.canonicalHash === content.executionPlan.canonicalHash;
    if (!samePlan) {
    const plan = await client.query<Record<string, unknown>>(
      `SELECT * FROM execution_plans
        WHERE id = $1 AND decision_id = $2
          AND ($3::UUID IS NULL OR action_id = $3)`,
      [content.executionPlan.id, decisionId, content.candidateAction?.id ?? null],
    );
    if (!plan.rows[0] || !snapshotMatches(
      'execution_plan', content.executionPlan, executionPlanSnapshot(plan.rows[0]),
    )) return false;
    executionPlanStatus = plan.rows[0]['status'];
    }
  }

  if (content.executionResult) {
    const sameResult = previous?.executionResult?.id === content.executionResult.id &&
      previous.executionResult.canonicalHash === content.executionResult.canonicalHash;
    if (!sameResult) {
    if (!content.executionPlan) return false;
    const result = await client.query<Record<string, unknown>>(
      `SELECT result.* FROM execution_results result
        JOIN execution_plans plan ON plan.id = result.plan_id
       WHERE result.id = $1 AND result.plan_id = $2 AND plan.decision_id = $3`,
      [content.executionResult.id, content.executionPlan.id, decisionId],
    );
    if (!result.rows[0] || !snapshotMatches(
      'execution_result', content.executionResult, executionResultSnapshot(
        result.rows[0], content.executionDisposition ?? (result.rows[0]['success'] === true ? 'succeeded' : 'failed'),
      ),
    )) return false;
    executionResultSuccess = result.rows[0]['success'];
    }
  }

  const feedbackIds = content.feedbackEvents.map((ref) => ref.id);
  if (feedbackIds.length > 0 && !await hasExactly(
    client,
    `SELECT count(*)::STRING AS count FROM feedback_events
      WHERE user_id = $1 AND decision_id = $2 AND id = ANY($3::UUID[])`,
    [userId, decisionId, feedbackIds],
    feedbackIds.length,
  )) return false;
  for (const ref of content.feedbackEvents) {
    if (!await artifactMatches(
      client,
      'SELECT * FROM feedback_events WHERE id = $1 AND user_id = $2 AND decision_id = $3',
      [ref.id, userId, decisionId],
      ref.canonicalHash,
      'feedback',
    )) return false;
  }

  const currentCorrection = content.stage === 'corrected'
    ? content.corrections[content.corrections.length - 1]
    : undefined;
  for (const change of currentCorrection?.preferenceChanges ?? []) {
    const history = await client.query<Record<string, unknown>>(
      'SELECT * FROM preference_history WHERE id = $1 AND user_id = $2',
      [change.preferenceHistory.id, userId],
    );
    const row = history.rows[0];
    if (!row || !snapshotMatches(
      'preference_history', change.preferenceHistory, preferenceHistorySnapshot(row),
    ) ||
      row['preference_id'] !== change.learnedSubjectId ||
      row['attribution_type'] !== 'feedback' ||
      row['attribution_id'] !== currentCorrection?.feedbackEvent.id) return false;
  }

  if (content.disposition === 'requires_approval' && approvalStatus !== undefined &&
      approvalStatus !== 'pending') return false;
  if (content.disposition === 'approved' && approvalStatus !== 'approved') return false;
  if (content.disposition === 'rejected' && approvalStatus !== 'rejected') return false;
  if (content.disposition === 'expired' && approvalStatus !== 'expired') return false;
  if (content.stage === 'execution_admitted' &&
      !['prepared', 'in_progress'].includes(String(barrierStatus))) return false;
  if (content.stage === 'execution_recorded') {
    if (!content.executionPlan) return false;
    if (barrierStatus !== content.disposition) return false;
    if (content.disposition === 'succeeded' &&
        (executionResultSuccess !== true || executionPlanStatus !== 'completed')) return false;
    if (content.disposition === 'failed' &&
        (executionResultSuccess !== false || executionPlanStatus !== 'failed')) return false;
    if (content.disposition === 'unknown') {
      if (executionPlanStatus !== 'failed') return false;
      if (!content.executionResult) {
        const known = await client.query(
          'SELECT 1 FROM execution_results WHERE plan_id = $1',
          [content.executionPlan.id],
        );
        if (known.rows[0]) return false;
      }
    }
  }
  if (content.executionDisposition) {
    if (content.executionDisposition === 'succeeded' &&
        (barrierStatus !== 'succeeded' || executionPlanStatus !== 'completed' ||
         executionResultSuccess !== true)) return false;
    if (content.executionDisposition === 'failed' &&
        (barrierStatus !== 'failed' || executionPlanStatus !== 'failed' ||
         executionResultSuccess !== false)) return false;
    if (content.executionDisposition === 'unknown' &&
        (barrierStatus !== 'unknown' || executionPlanStatus !== 'failed' ||
         executionResultSuccess === true)) return false;
  }
  if (content.stage === 'corrected') {
    if (!currentCorrection) return false;
  }
  return true;
}

async function appendTransaction(
  userId: string,
  input: AppendDecisionReceiptInput,
  contentDigest: string,
  transactionClient?: PoolClient,
): Promise<AppendDecisionReceiptResult> {
  const append = async (client: PoolClient): Promise<AppendDecisionReceiptResult> => {
    let root = (await client.query<DecisionReceiptRow>(
      `SELECT receipt.* FROM decision_receipts receipt
        JOIN decisions decision ON decision.id = receipt.decision_id
       WHERE receipt.decision_id = $1 AND receipt.user_id = $2 AND decision.user_id = $2
       FOR UPDATE`,
      [input.content.decision.id, userId],
    )).rows[0];
    let retainedChain: DecisionReceiptRevisionRow[] = [];
    if (root) {
      const verified = await loadVerifiedRetainedChain(client, root);
      if (!verified) return { success: false, code: 'chain_conflict' };
      retainedChain = verified;
      // Response-loss replay is bound to immutable event content and owner,
      // not to source rows that may legitimately have changed or been purged.
      const existing = retainedChain.find((revision) => revision.event_key === input.eventKey);
      if (existing) {
        if (existing.content_digest !== contentDigest) {
          return { success: false, code: 'idempotency_conflict' };
        }
        return { success: true, created: false, receipt: root, revision: existing };
      }
    }

    const trustedPrevious = retainedChain[retainedChain.length - 1] ?? null;
    if (!await linkageIsOwned(client, userId, input.content, trustedPrevious?.content)) {
      return { success: false, code: 'linkage_mismatch' };
    }

    if (!root) {
      // A non-first append cannot manufacture an empty root. Reject before
      // writing anything so stale/cross-chain requests leave no shell row.
      if (input.expectedPreviousDigest !== null) {
        return { success: false, code: 'chain_conflict' };
      }
      if (input.content.correctionOfRevision) {
        return { success: false, code: 'linkage_mismatch' };
      }
      if (input.content.stage !== 'decision_recorded') {
        return { success: false, code: 'chain_conflict' };
      }
      root = (await client.query<DecisionReceiptRow>(
        `INSERT INTO decision_receipts (id, user_id, decision_id)
         SELECT $3, $1, decision.id FROM decisions decision
          WHERE decision.id = $2 AND decision.user_id = $1
         ON CONFLICT (decision_id) DO NOTHING
         RETURNING *`,
        [userId, input.content.decision.id, input.receiptId ?? randomUUID()],
      )).rows[0];
      if (!root) {
        root = (await client.query<DecisionReceiptRow>(
          `SELECT receipt.* FROM decision_receipts receipt
            JOIN decisions decision ON decision.id = receipt.decision_id
           WHERE receipt.decision_id = $1 AND receipt.user_id = $2 AND decision.user_id = $2
           FOR UPDATE`,
          [input.content.decision.id, userId],
        )).rows[0];
      }
      if (!root) return { success: false, code: 'chain_conflict' };
      await client.query('SELECT id FROM decision_receipts WHERE id = $1 FOR UPDATE', [root.id]);
      const verified = await loadVerifiedRetainedChain(client, root);
      if (!verified) return { success: false, code: 'chain_conflict' };
      retainedChain = verified;
    }

    const previous = retainedChain[retainedChain.length - 1] ?? null;
    if (!previous && (input.content.stage !== 'decision_recorded' ||
        input.content.correctionOfRevision !== undefined)) {
      return { success: false, code: 'chain_conflict' };
    }
    if ((previous?.revision_digest ?? null) !== input.expectedPreviousDigest) {
      return { success: false, code: 'chain_conflict' };
    }
    if (previous && !preservesJoinedDecisionReceiptLinks(previous.content, input.content)) {
      return { success: false, code: 'chain_conflict' };
    }
    const previousSequence = previous?.sequence ?? 0;
    if (input.content.correctionOfRevision) {
      const corrected = (await client.query<DecisionReceiptRevisionRow>(
        'SELECT * FROM decision_receipt_revisions WHERE id = $1 AND receipt_id = $2',
        [input.content.correctionOfRevision.id, root.id],
      )).rows[0];
      if (!corrected || corrected.revision_digest !== input.content.correctionOfRevision.canonicalHash) {
        return { success: false, code: 'linkage_mismatch' };
      }
    }

    const revisionId = input.revisionId ?? randomUUID();
    const revisionDigest = joinedDecisionReceiptRevisionDigest({
      revisionId,
      receiptId: root.id,
      decisionId: input.content.decision.id,
      userId,
      sequence: previousSequence + 1,
      eventKey: input.eventKey,
      previousDigest: previous?.revision_digest ?? null,
      contentDigest,
    });

    const insertedRaw = (await client.query<DecisionReceiptRevisionRow>(
      `INSERT INTO decision_receipt_revisions (
         id, receipt_id, sequence, event_key, previous_digest, content_digest, revision_digest,
         stage, disposition, content, trusted, candidate_action_id, barrier_id,
         explanation_id, approval_request_id, execution_plan_id,
         execution_result_id, execution_disposition, correction_of_revision_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, true, $11, $12, $13, $14, $15, $16, $17, $18,
         COALESCE($19::TIMESTAMPTZ, now())
       ) RETURNING *`,
      [revisionId, root.id, previousSequence + 1, input.eventKey,
        previous?.revision_digest ?? null, contentDigest, revisionDigest, input.content.stage,
        input.content.disposition, JSON.stringify(input.content),
        input.content.candidateAction?.id ?? null, input.content.barrier?.id ?? null,
        input.content.explanation?.id ?? null, input.content.approvalRequest?.id ?? null,
        input.content.executionPlan?.id ?? null, input.content.executionResult?.id ?? null,
        input.content.executionDisposition ?? null, input.content.correctionOfRevision?.id ?? null,
        input.createdAt ?? null],
    )).rows[0]!;
    const inserted = normalizeRevisionRow(insertedRaw);
    if (!inserted) throw new TypeError('database returned an invalid receipt sequence');
    return { success: true, created: true, receipt: root, revision: inserted };
  };
  return transactionClient ? append(transactionClient) : withTransaction(append);
}

function validateAppendInput(
  userId: string,
  input: AppendDecisionReceiptInput,
): string | null {
  if (!UUID.test(userId) || !isDecisionReceiptEventKey(input.eventKey) ||
      (input.expectedPreviousDigest !== null && !SHA256.test(input.expectedPreviousDigest)) ||
      (input.receiptId !== undefined && !UUID.test(input.receiptId)) ||
      (input.revisionId !== undefined && !UUID.test(input.revisionId)) ||
      (input.createdAt !== undefined && !isCanonicalIsoInstant(input.createdAt))) {
    return null;
  }
  try {
    validateJoinedDecisionReceiptContent(input.content);
    return joinedDecisionReceiptContentDigest(input.content);
  } catch {
    return null;
  }
}

export const decisionReceiptRepository = {
  async appendForUser(
    userId: string,
    input: AppendDecisionReceiptInput,
  ): Promise<AppendDecisionReceiptResult> {
    const contentDigest = validateAppendInput(userId, input);
    if (!contentDigest) return { success: false, code: 'invalid_content' };
    // CockroachDB may restart either concurrent root creation or a competing
    // append. The event key makes a commit-then-retry converge on the existing
    // immutable revision rather than append twice.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await appendTransaction(userId, input, contentDigest);
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== '40001' || attempt >= 2) throw error;
      }
    }
  },

  /**
   * Append inside a caller-owned transaction. The caller owns CockroachDB
   * serialization retries for the entire transaction; the immutable event
   * key makes a commit-then-retry converge on the same revision.
   */
  async appendForUserInTransaction(
    client: PoolClient,
    userId: string,
    input: AppendDecisionReceiptInput,
  ): Promise<AppendDecisionReceiptResult> {
    const contentDigest = validateAppendInput(userId, input);
    if (!contentDigest) return { success: false, code: 'invalid_content' };
    return appendTransaction(userId, input, contentDigest, client);
  },

  async findByDecisionForUser(
    userId: string,
    decisionId: string,
  ): Promise<FindDecisionReceiptResult> {
    if (!UUID.test(userId) || !UUID.test(decisionId)) return null;
    return withTransaction(async (client) => {
      const receipt = (await client.query<DecisionReceiptRow>(
        `SELECT receipt.* FROM decision_receipts receipt
          JOIN decisions decision ON decision.id = receipt.decision_id
         WHERE receipt.user_id = $1 AND receipt.decision_id = $2 AND decision.user_id = $1`,
        [userId, decisionId],
      )).rows[0];
      if (!receipt) return null;
      const rawRevisions = (await client.query<DecisionReceiptRevisionRow>(
        'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
        [receipt.id],
      )).rows;
      const revisions = rawRevisions.map((revision) => normalizeRevisionRow(revision));
      if (revisions.some((revision) => revision === null)) {
        return { success: false, code: 'verification_failed' };
      }
      const normalizedRevisions = revisions as DecisionReceiptRevisionRow[];
      if (normalizedRevisions.some((revision) => !revision.trusted) || !verifyJoinedDecisionReceiptChain({
        receiptId: receipt.id, decisionId, userId, revisions: normalizedRevisions,
      })) return { success: false, code: 'verification_failed' };
      return { success: true, receipt, revisions: normalizedRevisions };
    });
  },
};
