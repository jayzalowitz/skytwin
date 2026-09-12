import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  verifyJoinedDecisionReceiptChain,
  type JoinedDecisionReceiptContentV1,
} from '@skytwin/shared-types';
import type { ExecutionPlanRow, ExplanationRecordRow } from '../types.js';
import { decisionReceiptRowArtifactRefV1 } from './decision-receipt-artifacts.js';
import type { GmailArchiveApprovalCanonicalState } from './gmail-archive-approval-response-repository.js';
import {
  canonicalGmailArchiveCandidate,
  canonicalGmailArchivePlanSteps,
} from './gmail-archive-preparation-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

export interface GmailArchiveClaimAuthority {
  userId: string;
  approvalId: string;
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

export function exactGmailArchiveBarrierIdentity(
  barrier: PreEffectBarrierRow,
  input: GmailArchiveClaimAuthority,
  state: Pick<GmailArchiveApprovalCanonicalState, 'candidate' | 'decision'>,
): boolean {
  return barrier.user_id === input.userId && barrier.effect_type === 'event_execution' &&
    barrier.idempotency_key === input.approvalId && barrier.decision_id === state.decision.id &&
    barrier.action_id === state.candidate.id && barrier.explanation_id !== null;
}

/** Exact immutable r1-r6 admission graph shared by claim and terminal replay. */
export function exactClaimedGmailArchiveReceipt(
  input: GmailArchiveClaimAuthority,
  state: Pick<
    GmailArchiveApprovalCanonicalState,
    'approval' | 'candidate' | 'decision' | 'receipt' | 'revisions'
  >,
  barrier: PreEffectBarrierRow,
  plan: ExecutionPlanRow,
  policyExplanation: ExplanationRecordRow,
  approved: JoinedDecisionReceiptContentV1,
): boolean {
  const candidate = canonicalGmailArchiveCandidate(state);
  const revisions = state.revisions;
  const r4 = revisions[3];
  const r5 = revisions[4];
  const r6 = revisions[5];
  const barrierRef = r6?.content.barrier;
  const planRef = r6?.content.executionPlan;
  const policyRef = r6?.content.policy;
  const explanationRef = r6?.content.explanation;
  const candidateRef = r6?.content.candidateAction;
  if (!candidate || !exactGmailArchiveBarrierIdentity(barrier, input, state) ||
      revisions.length !== 6 || revisions.some((revision) => revision.trusted !== true) ||
      !verifyJoinedDecisionReceiptChain({
        receiptId: state.receipt.id,
        decisionId: state.decision.id,
        userId: input.userId,
        revisions,
      }) || !r4 || !r5 || !r6 ||
      r4.content_digest !== joinedDecisionReceiptContentDigest(approved) ||
      r5.event_key !== buildDecisionReceiptEventKey('policy_evaluated', barrier.id) ||
      r5.stage !== 'policy_evaluated' || r5.disposition !== 'allowed' ||
      r6.event_key !== buildDecisionReceiptEventKey('execution_admitted', plan.id) ||
      r6.stage !== 'execution_admitted' || r6.disposition !== 'pending' ||
      !barrierRef || barrierRef.id !== barrier.id || barrierRef.snapshot.status !== 'prepared' ||
      barrierRef.snapshot.effectType !== 'event_execution' ||
      barrierRef.snapshot.decisionId !== state.decision.id ||
      barrierRef.snapshot.candidateActionId !== state.candidate.id ||
      barrierRef.snapshot.explanationId !== barrier.explanation_id ||
      barrierRef.snapshot.policyHash !== joinedDecisionReceiptArtifactDigest('policy', barrier.policy_snapshot) ||
      barrierRef.snapshot.createdAt !== barrier.created_at.toISOString() ||
      ownData(barrier.effect_result, []) === null || barrier.failure_reason !== null ||
      !planRef || planRef.id !== plan.id || planRef.snapshot.status !== 'pending' ||
      planRef.snapshot.decisionId !== state.decision.id ||
      planRef.snapshot.candidateActionId !== state.candidate.id ||
      planRef.snapshot.createdAt !== plan.created_at.toISOString() ||
      joinedDecisionReceiptArtifactDigest('policy', plan.steps) !==
        joinedDecisionReceiptArtifactDigest('policy', canonicalGmailArchivePlanSteps(candidate)) ||
      !policyRef || policyRef.barrierId !== barrier.id ||
      policyRef.canonicalHash !== joinedDecisionReceiptArtifactDigest('policy', barrier.policy_snapshot) ||
      !explanationRef || explanationRef.id !== barrier.explanation_id ||
      policyExplanation.id !== barrier.explanation_id ||
      policyExplanation.decision_id !== state.decision.id ||
      explanationRef.canonicalHash !==
        decisionReceiptRowArtifactRefV1('explanation', { ...policyExplanation }).canonicalHash ||
      !candidateRef || candidateRef.id !== state.candidate.id ||
      candidateRef.canonicalHash !==
        decisionReceiptRowArtifactRefV1('candidate_action', { ...state.candidate }).canonicalHash) {
    return false;
  }
  return r5.content.barrier?.canonicalHash === barrierRef.canonicalHash &&
    r5.content.policy?.canonicalHash === policyRef.canonicalHash &&
    r5.content.explanation?.canonicalHash === explanationRef.canonicalHash;
}
