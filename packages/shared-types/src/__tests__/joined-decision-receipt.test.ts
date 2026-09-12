import { describe, expect, it } from 'vitest';
import {
  canonicalJoinedDecisionReceiptContent,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  normalizeDecisionReceiptSequence,
  preservesJoinedDecisionReceiptLinks,
  type DecisionReceiptApprovalRef,
  type DecisionReceiptPolicyEvaluationV1,
  type JoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContentV1,
  type JoinedDecisionReceiptContentV2,
} from '../index.js';

const hash = 'a'.repeat(64);
const decisionId = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';
const actionId = '33333333-3333-4333-8333-333333333333';
const explanationId = '44444444-4444-4444-8444-444444444444';
const executionExplanationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const firstBarrierId = '55555555-5555-4555-8555-555555555555';
const secondBarrierId = '66666666-6666-4666-8666-666666666666';
const approvalId = '77777777-7777-4777-8777-777777777777';
const planId = '88888888-8888-4888-8888-888888888888';
const resultId = '99999999-9999-4999-8999-999999999999';
const instant = '2026-01-01T00:00:00.000Z';

function content(): JoinedDecisionReceiptContentV1 {
  return {
    version: 1,
    stage: 'decision_recorded',
    disposition: 'pending',
    decision: { id: decisionId, canonicalHash: hash },
    policyEvaluations: [],
    evidence: [],
    inference: { receipts: [] },
    feedbackEvents: [],
    corrections: [],
  };
}

function approval(status: 'pending' | 'approved'): DecisionReceiptApprovalRef {
  const snapshot = {
    version: 1 as const, status, candidateActionId: actionId, requestedAt: instant,
    expiresAt: '2026-01-02T00:00:00.000Z', respondedAt: status === 'approved' ? instant : null,
  };
  return { id: approvalId, snapshot, canonicalHash: joinedDecisionReceiptArtifactDigest('approval', snapshot) };
}

function evaluation(
  phase: 'pre_effect' | 'post_approval',
  disposition: 'allowed' | 'requires_approval',
): DecisionReceiptPolicyEvaluationV1 {
  const policyHash = disposition === 'allowed' ? 'b'.repeat(64) : 'c'.repeat(64);
  const barrierSnapshot = {
    version: 1 as const,
    status: disposition === 'allowed' ? 'prepared' as const : 'blocked' as const,
    effectType: 'event_execution' as const,
    decisionId,
    candidateActionId: actionId,
    explanationId,
    policyHash,
    createdAt: instant,
    updatedAt: instant,
  };
  return {
    version: 1,
    phase,
    disposition,
    candidateAction: { id: actionId, canonicalHash: 'd'.repeat(64) },
    risk: { candidateActionId: actionId, canonicalHash: 'e'.repeat(64) },
    policy: {
      barrierId: phase === 'pre_effect' ? firstBarrierId : secondBarrierId,
      policyIds: [], canonicalHash: policyHash,
    },
    barrier: {
      id: phase === 'pre_effect' ? firstBarrierId : secondBarrierId,
      snapshot: barrierSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot),
    },
    explanation: { id: explanationId, canonicalHash: 'f'.repeat(64) },
    evidence: [],
    ...(phase === 'post_approval' ? { approvalSatisfied: approval('approved') } : {}),
  };
}

function policySnapshot(): JoinedDecisionReceiptContentV1 {
  const current = evaluation('pre_effect', 'requires_approval');
  return {
    ...content(),
    stage: 'policy_evaluated',
    disposition: 'requires_approval',
    policyEvaluations: [current],
    candidateAction: current.candidateAction,
    risk: current.risk,
    policy: current.policy,
    barrier: current.barrier,
    explanation: current.explanation,
  };
}

function admittedContent(): JoinedDecisionReceiptContentV1 {
  const approvedRequest = approval('approved');
  const initial = policySnapshot();
  const approved: JoinedDecisionReceiptContentV1 = {
    ...initial, stage: 'approval_recorded', disposition: 'approved',
    approvalRequest: approvedRequest,
  };
  const postApproval = evaluation('post_approval', 'allowed');
  const rechecked: JoinedDecisionReceiptContentV1 = {
    ...approved, stage: 'policy_evaluated', disposition: 'allowed',
    policyEvaluations: [initial.policyEvaluations[0]!, postApproval],
    candidateAction: postApproval.candidateAction,
    risk: postApproval.risk,
    policy: postApproval.policy,
    barrier: postApproval.barrier,
    explanation: postApproval.explanation,
  };
  const planSnapshot = {
    version: 1 as const, status: 'pending' as const, decisionId,
    candidateActionId: actionId, createdAt: instant, updatedAt: instant,
  };
  return {
    ...rechecked, stage: 'execution_admitted', disposition: 'pending',
    executionPlan: {
      id: planId, snapshot: planSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
    },
  };
}

function terminalContent(
  outcome: 'succeeded' | 'failed' | 'unknown',
): JoinedDecisionReceiptContentV2 {
  const admitted = admittedContent();
  const barrierSnapshot = {
    ...admitted.barrier!.snapshot,
    status: outcome,
  };
  const planSnapshot = {
    ...admitted.executionPlan!.snapshot,
    status: outcome === 'succeeded' ? 'completed' as const : 'failed' as const,
  };
  const resultSnapshot = {
    version: 1 as const,
    planId,
    success: outcome === 'succeeded',
    outcome,
    rollbackAvailable: false,
    completedAt: instant,
  };
  return {
    ...admitted,
    version: 2,
    stage: 'execution_recorded',
    disposition: outcome,
    barrier: {
      id: admitted.barrier!.id,
      snapshot: barrierSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot),
    },
    executionPlan: {
      id: planId,
      snapshot: planSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
    },
    executionResult: {
      id: resultId,
      snapshot: resultSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_result', resultSnapshot),
    },
    executionDisposition: outcome,
    executionExplanation: {
      id: executionExplanationId,
      canonicalHash: '9'.repeat(64),
    },
  };
}

describe('joined decision receipt content', () => {
  it('normalizes only safe positive integer numbers and canonical decimal strings', () => {
    expect(normalizeDecisionReceiptSequence(1)).toBe(1);
    expect(normalizeDecisionReceiptSequence('2')).toBe(2);
    for (const value of [true, [1], '01', ' 1', '1 ', '1.0', 0, -1, 1.5,
      Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(normalizeDecisionReceiptSequence(value)).toBeNull();
    }
  });
  it('has a stable canonical digest regardless of object key insertion order', () => {
    const first = content();
    const reordered = {
      feedbackEvents: [], inference: { receipts: [] }, evidence: [],
      decision: first.decision, policyEvaluations: [], corrections: [], disposition: 'pending', stage: 'decision_recorded', version: 1,
    } as JoinedDecisionReceiptContentV1;
    expect(joinedDecisionReceiptContentDigest(first)).toBe(joinedDecisionReceiptContentDigest(reordered));
  });

  it.each(['succeeded', 'failed', 'unknown'] as const)(
    'upgrades an admitted v1 receipt to a terminal v2 %s receipt',
    (outcome) => {
      const admitted = admittedContent();
      const terminal = terminalContent(outcome);
      expect(() => canonicalJoinedDecisionReceiptContent(terminal)).not.toThrow();
      expect(preservesJoinedDecisionReceiptLinks(admitted, terminal)).toBe(true);
    },
  );

  it('allows v2 only at execution recording and keeps its exact field set', () => {
    const terminal = terminalContent('succeeded');
    expect(() => canonicalJoinedDecisionReceiptContent({
      ...terminal,
      providerResponse: 'must not persist',
    } as JoinedDecisionReceiptContent)).toThrow('unsupported field');
    const missing = { ...terminal } as Record<string, unknown>;
    delete missing['executionExplanation'];
    expect(() => canonicalJoinedDecisionReceiptContent(
      missing as unknown as JoinedDecisionReceiptContent,
    )).toThrow('execution explanation');
    expect(() => canonicalJoinedDecisionReceiptContent({
      ...terminal,
      stage: 'execution_admitted',
      disposition: 'pending',
      executionDisposition: undefined,
      executionResult: undefined,
    } as unknown as JoinedDecisionReceiptContentV2)).toThrow('cannot precede');
    expect(preservesJoinedDecisionReceiptLinks(policySnapshot(), terminal)).toBe(false);
  });

  it('rejects terminal explanation drop, replacement, downgrade, and policy-ref swaps', () => {
    const terminal = terminalContent('failed');
    const feedback = { id: approvalId, canonicalHash: '1'.repeat(64) };
    const preserved: JoinedDecisionReceiptContentV2 = {
      ...terminal,
      stage: 'feedback_recorded',
      feedbackEvents: [feedback],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(preserved)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(terminal, preserved)).toBe(true);

    const correctionOfRevision = { id: firstBarrierId, canonicalHash: '2'.repeat(64) };
    const historySnapshot = {
      version: 1 as const,
      learnedSubjectId: actionId,
      attributionType: 'feedback' as const,
      attributionId: feedback.id,
      changedAt: instant,
      previousValueHash: null,
      newValueHash: '3'.repeat(64),
      previousConfidence: null,
      newConfidence: '0.8',
    };
    const corrected: JoinedDecisionReceiptContentV2 = {
      ...preserved,
      stage: 'corrected',
      disposition: 'corrected',
      correctionOfRevision,
      corrections: [{
        version: 1,
        correctionOfRevision,
        feedbackEvent: feedback,
        preferenceChanges: [{
          learnedSubjectId: actionId,
          preferenceHistory: {
            id: 'phist_1_abcdefg',
            snapshot: historySnapshot,
            canonicalHash: joinedDecisionReceiptArtifactDigest('preference_history', historySnapshot),
          },
        }],
      }],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(corrected)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(preserved, corrected)).toBe(true);

    const changed: JoinedDecisionReceiptContentV2 = {
      ...preserved,
      executionExplanation: { id: userId, canonicalHash: '8'.repeat(64) },
    };
    expect(preservesJoinedDecisionReceiptLinks(terminal, changed)).toBe(false);
    const downgraded: JoinedDecisionReceiptContentV1 = {
      ...terminal,
      version: 1,
    } as unknown as JoinedDecisionReceiptContentV1;
    delete (downgraded as unknown as Record<string, unknown>)['executionExplanation'];
    expect(preservesJoinedDecisionReceiptLinks(terminal, downgraded)).toBe(false);

    const swapped: JoinedDecisionReceiptContentV2 = {
      ...terminal,
      explanation: terminal.executionExplanation,
      executionExplanation: terminal.explanation!,
    };
    expect(preservesJoinedDecisionReceiptLinks(admittedContent(), swapped)).toBe(false);
    expect(() => canonicalJoinedDecisionReceiptContent({
      ...terminal,
      executionExplanation: terminal.explanation!,
    })).toThrow('distinct');
  });

  it('rejects receipt fields that could carry protected inference or provider material', () => {
    const unsafe = { ...content(), rawPrompt: 'do not persist this' } as JoinedDecisionReceiptContentV1;
    expect(() => canonicalJoinedDecisionReceiptContent(unsafe)).toThrow('unsupported field');
  });

  it('rejects non-canonical arrays and unsorted receipt sets', () => {
    const withProperty = content();
    Object.defineProperty(withProperty.evidence, 'secret', { value: 'hidden', enumerable: true });
    expect(() => canonicalJoinedDecisionReceiptContent(withProperty)).toThrow('dense and canonical');

    const unsorted = content();
    unsorted.inference = {
      receipts: [
        { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', canonicalHash: hash },
        { id: '11111111-1111-4111-8111-111111111111', canonicalHash: hash },
      ],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(unsorted)).toThrow('sorted and unique');
  });

  it('rejects semantically impossible terminal and correction shapes', () => {
    expect(() => canonicalJoinedDecisionReceiptContent({
      ...content(), stage: 'execution_recorded', disposition: 'succeeded',
    })).toThrow('allowed current policy evaluation');
    expect(() => canonicalJoinedDecisionReceiptContent({
      ...content(), stage: 'corrected', disposition: 'corrected',
    })).toThrow('corrections require');
  });

  it('binds revision identity, order, event, previous digest, and content', () => {
    const input = {
      revisionId: resultId,
      receiptId: firstBarrierId,
      decisionId,
      userId,
      sequence: 1,
      eventKey: `created:${approvalId}`,
      previousDigest: null,
      contentDigest: joinedDecisionReceiptContentDigest(content()),
    } as const;
    const digest = joinedDecisionReceiptRevisionDigest(input);
    expect(joinedDecisionReceiptRevisionDigest({ ...input, revisionId: approvalId })).not.toBe(digest);
    expect(joinedDecisionReceiptRevisionDigest({ ...input, sequence: 2 })).not.toBe(digest);
    expect(joinedDecisionReceiptRevisionDigest({ ...input, userId: actionId })).not.toBe(digest);
    expect(joinedDecisionReceiptRevisionDigest({ ...input, previousDigest: hash })).not.toBe(digest);
    expect(joinedDecisionReceiptRevisionDigest({ ...input, contentDigest: 'b'.repeat(64) })).not.toBe(digest);
  });

  it('preserves both authoritative policy phases through approval and admission', () => {
    const first = policySnapshot();
    expect(preservesJoinedDecisionReceiptLinks(content(), first)).toBe(true);
    const approvedRequest = approval('approved');
    const approved: JoinedDecisionReceiptContentV1 = {
      ...first, stage: 'approval_recorded', disposition: 'approved', approvalRequest: approvedRequest,
    };
    const postApproval = evaluation('post_approval', 'allowed');
    const rechecked: JoinedDecisionReceiptContentV1 = {
      ...approved,
      stage: 'policy_evaluated',
      disposition: 'allowed',
      policyEvaluations: [first.policyEvaluations[0]!, postApproval],
      candidateAction: postApproval.candidateAction,
      risk: postApproval.risk,
      policy: postApproval.policy,
      barrier: postApproval.barrier,
      explanation: postApproval.explanation,
    };
    expect(() => canonicalJoinedDecisionReceiptContent(rechecked)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(approved, rechecked)).toBe(true);

    const planSnapshot = {
      version: 1 as const, status: 'pending' as const, decisionId,
      candidateActionId: actionId, createdAt: instant, updatedAt: instant,
    };
    const admitted: JoinedDecisionReceiptContentV1 = {
      ...rechecked,
      stage: 'execution_admitted',
      disposition: 'pending',
      executionPlan: {
        id: planId, snapshot: planSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
      },
    };
    expect(() => canonicalJoinedDecisionReceiptContent(admitted)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(rechecked, admitted)).toBe(true);

    const terminalBarrierSnapshot = {
      ...postApproval.barrier.snapshot, status: 'unknown' as const,
    };
    const failedPlanSnapshot = {
      ...planSnapshot, status: 'failed' as const,
    };
    const unknown: JoinedDecisionReceiptContentV1 = {
      ...admitted,
      stage: 'execution_recorded',
      disposition: 'unknown',
      executionDisposition: 'unknown',
      barrier: {
        ...postApproval.barrier,
        snapshot: terminalBarrierSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', terminalBarrierSnapshot),
      },
      executionPlan: {
        id: planId, snapshot: failedPlanSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', failedPlanSnapshot),
      },
    };
    expect(() => canonicalJoinedDecisionReceiptContent(unknown)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(admitted, unknown)).toBe(true);

    const feedback = { id: resultId, canonicalHash: '1'.repeat(64) };
    const lateResultSnapshot = {
      version: 1 as const, planId, success: false, outcome: 'unknown' as const,
      rollbackAvailable: false, completedAt: instant,
    };
    const smuggledResult: JoinedDecisionReceiptContentV1 = {
      ...unknown,
      stage: 'feedback_recorded',
      feedbackEvents: [feedback],
      executionResult: {
        id: approvalId, snapshot: lateResultSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('execution_result', lateResultSnapshot),
      },
    };
    expect(preservesJoinedDecisionReceiptLinks(unknown, smuggledResult)).toBe(false);
    expect(() => canonicalJoinedDecisionReceiptContent({
      ...unknown, stage: 'feedback_recorded', disposition: 'failed', feedbackEvents: [feedback],
    })).toThrow('preserve terminal execution truth');
  });

  it('rejects reopening a consumed approval during the post-approval phase', () => {
    const unsafe = evaluation('post_approval', 'requires_approval');
    const prior = policySnapshot();
    const receipt: JoinedDecisionReceiptContentV1 = {
      ...prior,
      stage: 'policy_evaluated',
      disposition: 'requires_approval',
      policyEvaluations: [prior.policyEvaluations[0]!, unsafe],
      candidateAction: unsafe.candidateAction,
      risk: unsafe.risk,
      policy: unsafe.policy,
      barrier: unsafe.barrier,
      explanation: unsafe.explanation,
      approvalRequest: approval('approved'),
    };
    expect(() => canonicalJoinedDecisionReceiptContent(receipt)).toThrow('cannot reopen');
  });

  it('cannot attach an approval request to an auto-execution admission', () => {
    const automatic = evaluation('pre_effect', 'allowed');
    const evaluated: JoinedDecisionReceiptContentV1 = {
      ...content(), stage: 'policy_evaluated', disposition: 'allowed',
      policyEvaluations: [automatic], candidateAction: automatic.candidateAction,
      risk: automatic.risk, policy: automatic.policy, barrier: automatic.barrier,
      explanation: automatic.explanation,
    };
    const planSnapshot = {
      version: 1 as const, status: 'pending' as const, decisionId,
      candidateActionId: actionId, createdAt: instant, updatedAt: instant,
    };
    const pollutedAdmission: JoinedDecisionReceiptContentV1 = {
      ...evaluated, stage: 'execution_admitted', disposition: 'pending',
      approvalRequest: approval('approved'),
      executionPlan: {
        id: planId, snapshot: planSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
      },
    };
    expect(() => canonicalJoinedDecisionReceiptContent(pollutedAdmission)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(evaluated, pollutedAdmission)).toBe(false);
  });

  it('cannot backfill an approval request after a blocked non-action', () => {
    const blockedEvaluation = {
      ...evaluation('pre_effect', 'requires_approval'),
      disposition: 'blocked' as const,
    };
    const blocked: JoinedDecisionReceiptContentV1 = {
      ...content(), stage: 'policy_evaluated', disposition: 'blocked',
      policyEvaluations: [blockedEvaluation], candidateAction: blockedEvaluation.candidateAction,
      risk: blockedEvaluation.risk, policy: blockedEvaluation.policy,
      barrier: blockedEvaluation.barrier, explanation: blockedEvaluation.explanation,
    };
    const feedback = { id: resultId, canonicalHash: '1'.repeat(64) };
    const pollutedFeedback: JoinedDecisionReceiptContentV1 = {
      ...blocked, stage: 'feedback_recorded', disposition: 'blocked',
      approvalRequest: approval('approved'), feedbackEvents: [feedback],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(pollutedFeedback)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(blocked, pollutedFeedback)).toBe(false);
  });

  it('cannot add inference receipts after the set is finalized', () => {
    const completion = { id: decisionId, canonicalHash: '1'.repeat(64) };
    const firstReceipt = { id: firstBarrierId, canonicalHash: '2'.repeat(64) };
    const finalized: JoinedDecisionReceiptContentV1 = {
      ...content(),
      inference: { receipts: [firstReceipt], completion },
    };
    const evaluated = policySnapshot();
    const appendedAfterCompletion: JoinedDecisionReceiptContentV1 = {
      ...evaluated,
      inference: {
        receipts: [
          firstReceipt,
          { id: secondBarrierId, canonicalHash: '3'.repeat(64) },
        ],
        completion,
      },
    };
    expect(() => canonicalJoinedDecisionReceiptContent(finalized)).not.toThrow();
    expect(() => canonicalJoinedDecisionReceiptContent(appendedAfterCompletion)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(finalized, appendedAfterCompletion)).toBe(false);
  });

  it('binds one correction feedback to multiple preference-history snapshots without reuse', () => {
    const policy = policySnapshot();
    const rejectedApproval = approval('pending');
    const rejectedSnapshot = {
      ...rejectedApproval.snapshot, status: 'rejected' as const, respondedAt: instant,
    };
    const rejected: JoinedDecisionReceiptContentV1 = {
      ...policy,
      stage: 'approval_recorded',
      disposition: 'rejected',
      approvalRequest: {
        id: approvalId,
        snapshot: rejectedSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('approval', rejectedSnapshot),
      },
    };
    const feedback = { id: resultId, canonicalHash: '1'.repeat(64) };
    const recorded: JoinedDecisionReceiptContentV1 = {
      ...rejected, stage: 'feedback_recorded', feedbackEvents: [feedback],
    };
    expect(preservesJoinedDecisionReceiptLinks(rejected, {
      ...recorded, disposition: 'expired',
    })).toBe(false);
    const correctionOfRevision = { id: planId, canonicalHash: '2'.repeat(64) };
    const secondPreferenceId = 'inf_123456789_abcdefg';
    const history = (id: string, learnedSubjectId: string) => {
      const snapshot = {
        version: 1 as const,
        learnedSubjectId,
        attributionType: 'feedback' as const,
        attributionId: feedback.id,
        changedAt: instant,
        previousValueHash: null,
        newValueHash: '3'.repeat(64),
        previousConfidence: null,
        newConfidence: '0.8',
      };
      return {
        id, snapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('preference_history', snapshot),
      };
    };
    const correction = {
      version: 1 as const,
      correctionOfRevision,
      feedbackEvent: feedback,
      preferenceChanges: [
        { learnedSubjectId: actionId, preferenceHistory: history('phist_1_abcdefg', actionId) },
        { learnedSubjectId: secondPreferenceId, preferenceHistory: history('phist_2_abcdefg', secondPreferenceId) },
      ],
    };
    const corrected: JoinedDecisionReceiptContentV1 = {
      ...recorded,
      stage: 'corrected',
      disposition: 'corrected',
      correctionOfRevision,
      corrections: [correction],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(corrected)).not.toThrow();
    expect(preservesJoinedDecisionReceiptLinks(recorded, corrected)).toBe(true);

    const wrongAttributionSnapshot = {
      ...correction.preferenceChanges[0]!.preferenceHistory.snapshot,
      attributionId: actionId,
    };
    const contradictory: JoinedDecisionReceiptContentV1 = {
      ...corrected,
      corrections: [{
        ...correction,
        preferenceChanges: [{
          ...correction.preferenceChanges[0]!,
          preferenceHistory: {
            ...correction.preferenceChanges[0]!.preferenceHistory,
            snapshot: wrongAttributionSnapshot,
            canonicalHash: joinedDecisionReceiptArtifactDigest('preference_history', wrongAttributionSnapshot),
          },
        }],
      }],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(contradictory)).toThrow('causal feedback');

    const duplicateHistory: JoinedDecisionReceiptContentV1 = {
      ...corrected,
      corrections: [{
        ...correction,
        preferenceChanges: [
          correction.preferenceChanges[0]!,
          {
            ...correction.preferenceChanges[1]!,
            preferenceHistory: {
              ...correction.preferenceChanges[1]!.preferenceHistory,
              id: correction.preferenceChanges[0]!.preferenceHistory.id,
            },
          },
        ],
      }],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(duplicateHistory)).toThrow('must be unique');

    const oversizedSubject = 'x'.repeat(129);
    const oversizedHistorySnapshot = {
      ...correction.preferenceChanges[1]!.preferenceHistory.snapshot,
      learnedSubjectId: oversizedSubject,
    };
    const oversized: JoinedDecisionReceiptContentV1 = {
      ...corrected,
      corrections: [{
        ...correction,
        preferenceChanges: [
          correction.preferenceChanges[0]!,
          {
            learnedSubjectId: oversizedSubject,
            preferenceHistory: {
              ...correction.preferenceChanges[1]!.preferenceHistory,
              snapshot: oversizedHistorySnapshot,
              canonicalHash: joinedDecisionReceiptArtifactDigest(
                'preference_history', oversizedHistorySnapshot,
              ),
            },
          },
        ],
      }],
    };
    expect(() => canonicalJoinedDecisionReceiptContent(oversized)).toThrow('is invalid');

    const reused: JoinedDecisionReceiptContentV1 = {
      ...corrected,
      corrections: [correction, {
        ...correction,
        correctionOfRevision: { id: firstBarrierId, canonicalHash: '4'.repeat(64) },
        preferenceChanges: [{
          learnedSubjectId: secondPreferenceId,
          preferenceHistory: history('phist_3_abcdefg', secondPreferenceId),
        }],
      }],
      correctionOfRevision: { id: firstBarrierId, canonicalHash: '4'.repeat(64) },
    };
    expect(() => canonicalJoinedDecisionReceiptContent(reused)).toThrow('cannot be reused');
  });
});
