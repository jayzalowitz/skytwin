/**
 * backup-restore-guards.test.ts — validation + pre-DB guards in restoreBackup
 * and validateBackupData (#400).
 *
 * The connection + repository modules are mocked so these tests run without a
 * real DB. They cover the paths that should reject BEFORE any write happens:
 * malformed payloads, unsupported schema versions, and an already-existing
 * user. The happy-path DB write itself is covered end-to-end against a real
 * CRDB in the e2e suite; here we assert the guards fail closed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  type DecisionReceiptEventKey,
  type JoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContentV1,
  type JoinedDecisionReceiptContentV2,
} from '@skytwin/shared-types';
import {
  decisionReceiptRowArtifactRefV1,
  decisionReceiptRowArtifactV1,
} from '../repositories/decision-receipt-artifacts.js';
import {
  buildGmailArchiveReconciliationTerminalEnvelope,
  gmailArchiveReconciliationExplanationSemantics,
} from '../repositories/gmail-archive-reconciliation-repository.js';

let userExists = false;
const poolQuery = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
  rows: [], rowCount: 0,
}));
const clientQuery = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
  rows: [], rowCount: 1,
}));

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => poolQuery(...args),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: clientQuery }),
  ),
}));

vi.mock('../repositories/user-repository.js', () => ({
  userRepository: {
    findById: vi.fn(async () => (userExists ? { id: 'u1' } : null)),
  },
}));

vi.mock('../repositories/twin-repository.js', () => ({
  twinRepository: { getProfile: vi.fn(async () => null) },
}));

import { restoreBackup, validateBackupData, BACKUP_SCHEMA_VERSION } from '../backup/backup.js';

beforeEach(() => {
  userExists = false;
  poolQuery.mockClear();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockClear();
  clientQuery.mockImplementation(async (sql: unknown) => ({
    rows: userExists && typeof sql === 'string' && sql.includes('SELECT id FROM users')
      ? [{ id: 'u1' }]
      : [],
    rowCount: 1,
  }));
});

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-06-15T00:00:00.000Z',
    user: {
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      trust_tier: 'observer',
      autonomy_settings: {},
      ironclaw_channel: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    twinProfile: null,
    twinProfileVersions: [],
    preferences: [],
    decisions: [],
  };
}

function terminalReceiptPayload(): {
  payload: Record<string, unknown>;
  executionExplanation: Record<string, unknown>;
} {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const decisionId = '22222222-2222-4222-8222-222222222222';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const candidateId = '44444444-4444-4444-8444-444444444444';
  const policyExplanationId = '55555555-5555-4555-8555-555555555555';
  const barrierId = '66666666-6666-4666-8666-666666666666';
  const planId = '77777777-7777-4777-8777-777777777777';
  const executionExplanationId = '88888888-8888-4888-8888-888888888888';
  const now = new Date('2026-06-15T00:00:00.000Z');
  const decision = {
    id: decisionId, user_id: ownerId, situation_type: 'email', raw_event: {},
    interpreted_situation: {}, domain: 'email', urgency: 'normal', metadata: {},
    signal_id: null, created_at: now,
  };
  const candidate = {
    id: candidateId, decision_id: decisionId, action_type: 'archive_email',
    description: 'Archive the selected message', parameters: {},
    predicted_user_preference: 'positive', risk_assessment: {}, reversible: true,
    estimated_cost: null, created_at: now,
  };
  const policyExplanation = {
    id: policyExplanationId, decision_id: decisionId, what_happened: 'Policy allowed the action',
    evidence_used: [], preferences_invoked: [], confidence_reasoning: 'Explicit policy',
    action_rationale: 'The action is within scope', escalation_rationale: null,
    correction_guidance: 'Change the archive policy', capability_provenance_node_id: null,
    created_at: now,
  };
  const executionExplanation = {
    id: executionExplanationId, decision_id: decisionId,
    what_happened: 'The mutation POST outcome remains unknown after the confirming read.',
    evidence_used: [{
      schema: 'gmail_archive_terminal_result_v1',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }], preferences_invoked: [],
    confidence_reasoning:
      'The execution port returned remote_outcome_unknown after one POST and one inconclusive confirming read.',
    action_rationale: 'The admitted action was dispatched',
    escalation_rationale: 'Terminal classification: remote_outcome_unknown.',
    correction_guidance:
      'Reconcile the mailbox state before considering any new archive request; automated restore and compensation are unavailable.',
    capability_provenance_node_id: null,
    created_at: now,
  };
  const policySnapshot = { allowed: true, requiresApproval: false, policyIds: [] };
  const policyHash = joinedDecisionReceiptArtifactDigest('policy', policySnapshot);
  const candidateAction = {
    id: candidateId,
    canonicalHash: joinedDecisionReceiptArtifactDigest(
      'candidate_action',
      decisionReceiptRowArtifactV1('candidate_action', candidate),
    ),
  };
  const risk = {
    candidateActionId: candidateId,
    canonicalHash: joinedDecisionReceiptArtifactDigest('risk', candidate.risk_assessment),
  };
  const explanation = {
    id: policyExplanationId,
    canonicalHash: joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', policyExplanation),
    ),
  };
  const barrierSnapshot = {
    version: 1 as const, status: 'prepared' as const, effectType: 'event_execution' as const,
    decisionId, candidateActionId: candidateId, explanationId: policyExplanationId,
    policyHash, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const barrier = {
    id: barrierId, snapshot: barrierSnapshot,
    canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot),
  };
  const evaluation = {
    version: 1 as const, phase: 'pre_effect' as const, disposition: 'allowed' as const,
    candidateAction, risk, policy: { barrierId, policyIds: [], canonicalHash: policyHash },
    barrier, explanation, evidence: [],
  };
  const base: JoinedDecisionReceiptContentV1 = {
    version: 1, stage: 'decision_recorded', disposition: 'pending',
    decision: {
      id: decisionId,
      canonicalHash: joinedDecisionReceiptArtifactDigest(
        'decision',
        decisionReceiptRowArtifactV1('decision', decision),
      ),
    },
    policyEvaluations: [], evidence: [], inference: { receipts: [] },
    feedbackEvents: [], corrections: [],
  };
  const evaluated: JoinedDecisionReceiptContentV1 = {
    ...base, stage: 'policy_evaluated', disposition: 'allowed',
    policyEvaluations: [evaluation], candidateAction, risk, policy: evaluation.policy,
    barrier, explanation,
  };
  const planSnapshot = {
    version: 1 as const, status: 'pending' as const, decisionId,
    candidateActionId: candidateId, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const admitted: JoinedDecisionReceiptContentV1 = {
    ...evaluated, stage: 'execution_admitted', disposition: 'pending',
    executionPlan: {
      id: planId, snapshot: planSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
    },
  };
  const terminalBarrierSnapshot = { ...barrierSnapshot, status: 'unknown' as const };
  const terminalPlanSnapshot = { ...planSnapshot, status: 'failed' as const };
  const terminal: JoinedDecisionReceiptContentV2 = {
    ...admitted, version: 2, stage: 'execution_recorded', disposition: 'unknown',
    barrier: {
      id: barrierId, snapshot: terminalBarrierSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', terminalBarrierSnapshot),
    },
    executionPlan: {
      id: planId, snapshot: terminalPlanSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', terminalPlanSnapshot),
    },
    executionDisposition: 'unknown',
    executionExplanation: {
      id: executionExplanationId,
      canonicalHash: joinedDecisionReceiptArtifactDigest(
        'explanation',
        decisionReceiptRowArtifactV1('explanation', executionExplanation),
      ),
    },
  };
  let previousDigest: string | null = null;
  const revisionIds = [
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];
  const revisions = ([base, evaluated, admitted, terminal] as JoinedDecisionReceiptContent[])
    .map((content, index) => {
      const revisionId = revisionIds[index]!;
      const eventKey = buildDecisionReceiptEventKey(`backup_${index + 1}`, revisionId);
      const contentDigest = joinedDecisionReceiptContentDigest(content);
      const revisionDigest = joinedDecisionReceiptRevisionDigest({
        revisionId, receiptId: rootId, decisionId, userId: ownerId,
        sequence: index + 1, eventKey, previousDigest, contentDigest,
      });
      const revision = {
        id: revisionId, receipt_id: rootId, sequence: index + 1, event_key: eventKey,
        previous_digest: previousDigest, content_digest: contentDigest, revision_digest: revisionDigest,
        stage: content.stage, disposition: content.disposition, content,
        candidate_action_id: content.candidateAction?.id ?? null,
        barrier_id: content.barrier?.id ?? null,
        explanation_id: content.explanation?.id ?? null,
        approval_request_id: content.approvalRequest?.id ?? null,
        execution_plan_id: content.executionPlan?.id ?? null,
        execution_result_id: content.executionResult?.id ?? null,
        execution_disposition: content.executionDisposition ?? null,
        correction_of_revision_id: content.correctionOfRevision?.id ?? null,
        trusted: true, created_at: now,
      };
      previousDigest = revisionDigest;
      return revision;
    });
  const payload = validPayload();
  payload['user'] = { ...(payload['user'] as object), id: ownerId };
  payload['decisions'] = [{
    decision, candidateActions: [candidate], outcome: null,
    explanations: [policyExplanation, executionExplanation], inferenceReceipts: [],
    executionPlans: [{
      id: planId, decision_id: decisionId, action_id: candidateId, status: 'failed', steps: [],
      created_at: now, updated_at: now,
    }],
    joinedReceipt: {
      root: { id: rootId, user_id: ownerId, decision_id: decisionId, created_at: now },
      revisions,
    },
  }];
  return { payload, executionExplanation };
}

function rehashTerminalReceipt(payload: Record<string, unknown>): void {
  const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
  const revisions = (bundle['joinedReceipt'] as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  let previousDigest: string | null = null;
  for (const revision of revisions) {
    const content = revision['content'] as JoinedDecisionReceiptContent;
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    revision['previous_digest'] = previousDigest;
    revision['content_digest'] = contentDigest;
    revision['revision_digest'] = joinedDecisionReceiptRevisionDigest({
      revisionId: revision['id'] as string,
      receiptId: revision['receipt_id'] as string,
      decisionId: (bundle['decision'] as Record<string, unknown>)['id'] as string,
      userId: (payload['user'] as Record<string, unknown>)['id'] as string,
      sequence: revision['sequence'] as number,
      eventKey: revision['event_key'] as DecisionReceiptEventKey,
      previousDigest,
      contentDigest,
    });
    previousDigest = revision['revision_digest'] as string;
  }
}

function reconciliationTerminalReceiptPayload(): {
  payload: Record<string, unknown>;
  executionExplanation: Record<string, unknown>;
} {
  const { payload, executionExplanation } = terminalReceiptPayload();
  const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
  const candidate = (bundle['candidateActions'] as Array<Record<string, unknown>>)[0]!;
  const revisions = (bundle['joinedReceipt'] as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  const terminal = revisions.at(-1)!;
  const terminalContent = terminal['content'] as JoinedDecisionReceiptContentV2;
  const ownerId = (payload['user'] as Record<string, unknown>)['id'] as string;
  const messageRefId = '12121212-1212-4212-8212-121212121212';
  const terminalAt = terminalContent.barrier!.snapshot.updatedAt;
  candidate['parameters'] = { messageRefId };
  const candidateHash = joinedDecisionReceiptArtifactDigest(
    'candidate_action',
    decisionReceiptRowArtifactV1('candidate_action', candidate),
  );
  for (const revision of revisions) {
    const content = revision['content'] as JoinedDecisionReceiptContent;
    if (content.candidateAction) content.candidateAction.canonicalHash = candidateHash;
  }
  const envelope = buildGmailArchiveReconciliationTerminalEnvelope({
    phase: 'dispatch_may_have_started',
    phaseChangedAt: new Date(Date.parse(terminalAt) - 600_000).toISOString(),
    evidence: {
      kind: 'mailbox_observed',
      binding: {
        userId: ownerId,
        admissionId: terminalContent.barrier!.id,
        messageRefId,
      },
      inbox: false,
      observedAt: new Date(Date.parse(terminalAt) - 1_000).toISOString(),
    },
  });
  const semantics = gmailArchiveReconciliationExplanationSemantics(envelope);
  executionExplanation['evidence_used'] = [envelope];
  executionExplanation['what_happened'] = semantics.whatHappened;
  executionExplanation['confidence_reasoning'] = semantics.confidenceReasoning;
  executionExplanation['escalation_rationale'] = semantics.escalationRationale;
  executionExplanation['correction_guidance'] = semantics.correctionGuidance;
  terminalContent.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
    'explanation',
    decisionReceiptRowArtifactV1('explanation', executionExplanation),
  );
  rehashTerminalReceipt(payload);
  return { payload, executionExplanation };
}

function rehashReconciliationExplanation(
  payload: Record<string, unknown>,
  executionExplanation: Record<string, unknown>,
): void {
  const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
  const revisions = (bundle['joinedReceipt'] as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  const explanationHash = joinedDecisionReceiptArtifactDigest(
    'explanation',
    decisionReceiptRowArtifactV1('explanation', executionExplanation),
  );
  for (const revision of revisions) {
    const content = revision['content'] as JoinedDecisionReceiptContent;
    if (content.version === 2) content.executionExplanation.canonicalHash = explanationHash;
  }
  rehashTerminalReceipt(payload);
}

describe('validateBackupData', () => {
  it('accepts a well-formed payload', () => {
    expect(validateBackupData(validPayload())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateBackupData('nope')).toContain('payload is not an object');
    expect(validateBackupData(null)).toContain('payload is not an object');
  });

  it('reports each missing required field', () => {
    const problems = validateBackupData({ schemaVersion: 1 });
    expect(problems).toContain('missing user');
    expect(problems).toContain('preferences is not an array');
    expect(problems).toContain('decisions is not an array');
    expect(problems).toContain('twinProfileVersions is not an array');
  });

  it('rejects receipt metadata whose signed linkage disagrees with its decision bundle', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', decision_id: 'decision-a', explanation_id: 'explanation-a', status: 'verified',
        receipt: { id: 'receipt-a', decisionId: 'decision-b', explanationId: 'explanation-a', status: 'verified' },
      }],
    }];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    );
  });

  it('rejects an explanation linked to a different decision than its containing bundle', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-b' }], inferenceReceipts: [],
    }];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].explanations[0] has inconsistent linkage',
    );
  });

  it('rejects malformed nested collections without throwing', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' },
      candidateActions: {}, explanations: {}, inferenceReceipts: {},
    }];
    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].candidateActions is not an array',
      'decisions[0].explanations is not an array',
      'decisions[0].inferenceReceipts is not an array',
    ]));
  });

  it('rejects malformed joined receipt nesting without throwing', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], joinedReceipt: {},
    }];
    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toContain('decisions[0].joinedReceipt is malformed');
  });

  it('validates the joined receipt owner, sequence, digest chain, and event uniqueness', () => {
    const payload = validPayload();
    const joinedDecisionId = '22222222-2222-4222-8222-222222222222';
    const joinedRootId = '33333333-3333-4333-8333-333333333333';
    const joinedUserId = '11111111-1111-4111-8111-111111111111';
    const content = {
      version: 1 as const, stage: 'decision_recorded' as const, disposition: 'pending' as const,
      policyEvaluations: [],
      decision: {
        id: joinedDecisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('decision', {
          id: joinedDecisionId, user_id: joinedUserId,
        }),
      },
      evidence: [], inference: { receipts: [] }, feedbackEvents: [], corrections: [],
    };
    payload['user'] = { ...(payload['user'] as object), id: joinedUserId };
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const receiptEventKey = buildDecisionReceiptEventKey('created', '55555555-5555-4555-8555-555555555555');
    payload['decisions'] = [{
      decision: { id: joinedDecisionId, user_id: joinedUserId }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
      joinedReceipt: {
        root: { id: joinedRootId, user_id: joinedUserId, decision_id: joinedDecisionId, created_at: new Date() },
        revisions: [{
          id: '44444444-4444-4444-8444-444444444444', receipt_id: joinedRootId, sequence: '1',
          event_key: receiptEventKey,
          previous_digest: null, content_digest: contentDigest,
          revision_digest: joinedDecisionReceiptRevisionDigest({
            revisionId: '44444444-4444-4444-8444-444444444444',
            receiptId: joinedRootId, decisionId: joinedDecisionId, userId: joinedUserId,
            sequence: 1, eventKey: receiptEventKey, previousDigest: null, contentDigest,
          }),
          stage: content.stage, disposition: content.disposition, content,
          candidate_action_id: null, barrier_id: null, explanation_id: null,
          approval_request_id: null, execution_plan_id: null, execution_result_id: null,
          execution_disposition: null,
          correction_of_revision_id: null, trusted: true,
        }],
      },
    }];
    expect(validateBackupData(payload)).toEqual([]);
    const revision = ((payload['decisions'] as Array<Record<string, unknown>>)[0]!
      ['joinedReceipt'] as { revisions: Array<Record<string, unknown>> }).revisions[0]!;
    revision['sequence'] = '1';
    expect(validateBackupData(payload)).toEqual([]);
    for (const invalidSequence of [true, [1], '01', ' 1', '1 ', 0, -1, 1.5]) {
      revision['sequence'] = invalidSequence;
      expect(validateBackupData(payload)).toContain(
        'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
      );
    }
    revision['sequence'] = 1;
    const decision = (payload['decisions'] as Array<{ decision: Record<string, unknown> }>)[0]!.decision;
    decision['domain'] = 'tampered-after-receipt';
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
    );
    delete decision['domain'];
    revision['previous_digest'] = 'f'.repeat(64);
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
    );
  });

  it('requires a v2 terminal explanation row in the exported decision bundle', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    bundle['explanations'] = (bundle['explanations'] as Array<Record<string, unknown>>)
      .filter((row) => row['id'] !== executionExplanation['id']);

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has inconsistent execution explanation snapshot',
    );
  });

  it('rejects a v2 terminal explanation whose exported canonical projection was tampered', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
    executionExplanation['what_happened'] = 'tampered after receipt creation';

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has inconsistent execution explanation snapshot',
    );
  });

  it('retains and verifies the canonical terminal result envelope', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
    expect(executionExplanation['evidence_used']).toEqual([{
      schema: 'gmail_archive_terminal_result_v1',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }]);
    (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!['code'] =
      'remote_rejected';
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has inconsistent execution explanation snapshot',
    );
  });

  it('rejects malformed Gmail terminal evidence after an internally consistent rehash', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminal = revisions.at(-1)!;
    const content = terminal['content'] as JoinedDecisionReceiptContentV2;
    delete (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!
      ['compensationAvailable'];
    content.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', executionExplanation),
    );
    terminal['content_digest'] = joinedDecisionReceiptContentDigest(content);
    terminal['revision_digest'] = joinedDecisionReceiptRevisionDigest({
      revisionId: terminal['id'] as string,
      receiptId: terminal['receipt_id'] as string,
      decisionId: (bundle['decision'] as Record<string, unknown>)['id'] as string,
      userId: ((payload['user'] as Record<string, unknown>)['id']) as string,
      sequence: terminal['sequence'] as number,
      eventKey: terminal['event_key'] as DecisionReceiptEventKey,
      previousDigest: terminal['previous_digest'] as string,
      contentDigest: terminal['content_digest'] as string,
    });

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('rejects a phase-incompatible v2 terminal envelope after an internally consistent rehash', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminal = revisions.at(-1)!;
    const content = terminal['content'] as JoinedDecisionReceiptContentV2;
    executionExplanation['evidence_used'] = [{
      schema: 'gmail_archive_terminal_result_v2',
      attemptPhase: 'pre_dispatch',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }];
    content.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', executionExplanation),
    );
    terminal['content_digest'] = joinedDecisionReceiptContentDigest(content);
    terminal['revision_digest'] = joinedDecisionReceiptRevisionDigest({
      revisionId: terminal['id'] as string,
      receiptId: terminal['receipt_id'] as string,
      decisionId: (bundle['decision'] as Record<string, unknown>)['id'] as string,
      userId: (payload['user'] as Record<string, unknown>)['id'] as string,
      sequence: terminal['sequence'] as number,
      eventKey: terminal['event_key'] as DecisionReceiptEventKey,
      previousDigest: terminal['previous_digest'] as string,
      contentDigest: terminal['content_digest'] as string,
    });

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('retains strict compatibility for a valid phase-bound legacy v2 terminal envelope', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    executionExplanation['evidence_used'] = [{
      schema: 'gmail_archive_terminal_result_v2',
      attemptPhase: 'dispatch_may_have_started',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }];
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminal = revisions.at(-1)!;
    const content = terminal['content'] as JoinedDecisionReceiptContentV2;
    content.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', executionExplanation),
    );
    rehashTerminalReceipt(payload);

    expect(validateBackupData(payload)).toEqual([]);
  });

  it('accepts a causal-unknown reconciliation envelope with exact authority and time bounds', () => {
    const { payload } = reconciliationTerminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
  });

  it.each([
    ['under grace', (envelope: Record<string, unknown>, terminalAt: string) => {
      envelope['phaseChangedAt'] = new Date(Date.parse(terminalAt) - 299_999).toISOString();
    }],
    ['future observation', (envelope: Record<string, unknown>, terminalAt: string) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      evidence['observedAt'] = new Date(Date.parse(terminalAt) + 1).toISOString();
    }],
    ['pre-phase observation', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      evidence['observedAt'] = new Date(
        Date.parse(envelope['phaseChangedAt'] as string) - 1,
      ).toISOString();
    }],
    ['wrong owner binding', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      const binding = evidence['binding'] as Record<string, unknown>;
      binding['userId'] = '99999999-9999-4999-8999-999999999999';
    }],
    ['wrong admission binding', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      const binding = evidence['binding'] as Record<string, unknown>;
      binding['admissionId'] = '99999999-9999-4999-8999-999999999999';
    }],
    ['wrong message binding', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      const binding = evidence['binding'] as Record<string, unknown>;
      binding['messageRefId'] = '99999999-9999-4999-8999-999999999999';
    }],
  ] as const)('rejects rehashed reconciliation evidence %s', (_label, tamper) => {
    const { payload, executionExplanation } = reconciliationTerminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminalContent = revisions.at(-1)!['content'] as JoinedDecisionReceiptContentV2;
    const terminalAt = terminalContent.barrier!.snapshot.updatedAt;
    const envelope = (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!;
    tamper(envelope, terminalAt);
    const parsed = buildGmailArchiveReconciliationTerminalEnvelope({
      phase: envelope['attemptPhase'] as 'dispatch_may_have_started',
      phaseChangedAt: envelope['phaseChangedAt'] as string,
      evidence: envelope['evidence'] as never,
    });
    const semantics = gmailArchiveReconciliationExplanationSemantics(parsed);
    executionExplanation['what_happened'] = semantics.whatHappened;
    executionExplanation['confidence_reasoning'] = semantics.confidenceReasoning;
    executionExplanation['escalation_rationale'] = semantics.escalationRationale;
    executionExplanation['correction_guidance'] = semantics.correctionGuidance;
    rehashReconciliationExplanation(payload, executionExplanation);

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('uses the unique execution-recorded instant despite a later continuation timestamp', () => {
    const { payload, executionExplanation } = reconciliationTerminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const r7 = revisions.at(-1)!;
    const r7Content = r7['content'] as JoinedDecisionReceiptContentV2;
    const r7At = r7Content.barrier!.snapshot.updatedAt;
    const laterAt = new Date(Date.parse(r7At) + 600_000).toISOString();
    const feedback = {
      id: '13131313-1313-4313-8313-131313131313',
      user_id: (payload['user'] as Record<string, unknown>)['id'],
      decision_id: (bundle['decision'] as Record<string, unknown>)['id'],
      type: 'approval',
      data: {},
      created_at: new Date(laterAt),
    };
    const laterBarrierSnapshot = { ...r7Content.barrier!.snapshot, updatedAt: laterAt };
    const continuation: JoinedDecisionReceiptContentV2 = {
      ...r7Content,
      stage: 'feedback_recorded',
      barrier: {
        ...r7Content.barrier!,
        snapshot: laterBarrierSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', laterBarrierSnapshot),
      },
      feedbackEvents: [decisionReceiptRowArtifactRefV1('feedback', feedback)],
    };
    revisions.push({
      id: '14141414-1414-4414-8414-141414141414',
      receipt_id: r7['receipt_id'],
      sequence: 5,
      event_key: buildDecisionReceiptEventKey('feedback_recorded', feedback.id),
      previous_digest: r7['revision_digest'],
      content_digest: '',
      revision_digest: '',
      stage: 'feedback_recorded',
      disposition: continuation.disposition,
      content: continuation,
      candidate_action_id: continuation.candidateAction?.id ?? null,
      barrier_id: continuation.barrier?.id ?? null,
      explanation_id: continuation.explanation?.id ?? null,
      approval_request_id: continuation.approvalRequest?.id ?? null,
      execution_plan_id: continuation.executionPlan?.id ?? null,
      execution_result_id: continuation.executionResult?.id ?? null,
      execution_disposition: continuation.executionDisposition ?? null,
      correction_of_revision_id: continuation.correctionOfRevision?.id ?? null,
      trusted: true,
      created_at: new Date(laterAt),
    });
    const envelope = (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!;
    envelope['phaseChangedAt'] = new Date(Date.parse(r7At) - 299_999).toISOString();
    const rebuilt = buildGmailArchiveReconciliationTerminalEnvelope({
      phase: 'dispatch_may_have_started',
      phaseChangedAt: envelope['phaseChangedAt'] as string,
      evidence: envelope['evidence'] as never,
    });
    const semantics = gmailArchiveReconciliationExplanationSemantics(rebuilt);
    executionExplanation['what_happened'] = semantics.whatHappened;
    executionExplanation['confidence_reasoning'] = semantics.confidenceReasoning;
    executionExplanation['escalation_rationale'] = semantics.escalationRationale;
    executionExplanation['correction_guidance'] = semantics.correctionGuidance;
    rehashReconciliationExplanation(payload, executionExplanation);

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('reports a malformed v2 tail with missing inference instead of throwing', () => {
    const { payload } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<{ content: Record<string, unknown> }>;
    }).revisions;
    delete revisions.at(-1)!.content['inference'];

    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].joinedReceipt failed chain verification',
      'decisions[0].joinedReceipt.revisions[3] has invalid content',
      'decisions[0].joinedReceipt.revisions[3] has inconsistent chain',
    ]));
  });

  it('reports a malformed nested policy evaluation instead of traversing it', () => {
    const { payload } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<{ content: Record<string, unknown> }>;
    }).revisions;
    revisions.at(-1)!.content['policyEvaluations'] = [{}];

    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].joinedReceipt failed chain verification',
      'decisions[0].joinedReceipt.revisions[3] has invalid content',
      'decisions[0].joinedReceipt.revisions[3] has inconsistent chain',
    ]));
  });

  it('rejects execution-plan payloads instead of exporting portable provider content', () => {
    const payload = validPayload();
    const decisionId = '22222222-2222-4222-8222-222222222222';
    payload['user'] = { ...(payload['user'] as object), id: '11111111-1111-4111-8111-111111111111' };
    payload['decisions'] = [{
      decision: { id: decisionId, user_id: '11111111-1111-4111-8111-111111111111' },
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
      executionPlans: [{
        id: '33333333-3333-4333-8333-333333333333', decision_id: decisionId,
        action_id: null, status: 'failed',
        steps: [{ accessToken: 'SECRET_MARKER', providerError: 'raw body' }],
        created_at: new Date(), updated_at: new Date(),
      }],
    }];
    expect(validateBackupData(payload)).toContain('decisions[0] has inconsistent execution linkage');
  });

  it('rejects cross-decision candidate and outcome linkage before restore', () => {
    const payload = validPayload();
    const owner = '11111111-1111-4111-8111-111111111111';
    const firstDecision = '22222222-2222-4222-8222-222222222222';
    const secondDecision = '33333333-3333-4333-8333-333333333333';
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const planId = '55555555-5555-4555-8555-555555555555';
    payload['user'] = { ...(payload['user'] as object), id: owner };
    payload['decisions'] = [{
      decision: { id: firstDecision, user_id: owner },
      candidateActions: [{ id: candidateId, decision_id: secondDecision }],
      explanations: [], inferenceReceipts: [], executionPlans: [],
      outcome: {
        id: '66666666-6666-4666-8666-666666666666', decision_id: firstDecision,
        selected_action_id: candidateId, execution_plan_id: planId,
      },
    }, {
      decision: { id: secondDecision, user_id: owner }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], executionPlans: [],
    }];
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0] has inconsistent candidate linkage',
      'decisions[0] has inconsistent outcome linkage',
    ]));
  });

  it('rejects decisions and signed receipts attributed to another archive owner', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'another-user' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', decision_id: 'decision-a', explanation_id: 'explanation-a', status: 'on_device',
        receipt: {
          id: 'receipt-a', userId: 'another-user', decisionId: 'decision-a',
          explanationId: 'explanation-a', status: 'on_device',
        },
      }],
    }];
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0] has inconsistent owner',
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    ]));
  });
});

describe('restoreBackup guards', () => {
  it('rejects an invalid payload before any DB write', async () => {
    const result = await restoreBackup({ not: 'a backup' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid_data');
  });

  it('rejects an unsupported schema version', async () => {
    const payload = { ...validPayload(), schemaVersion: 999 };
    const result = await restoreBackup(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('unsupported_schema');
  });

  it('refuses to clobber an existing user (fresh-install only)', async () => {
    userExists = true;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('user_exists');
  });

  it('restores a fresh install and reports row counts', async () => {
    userExists = false;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.counts.users).toBe(1);
      expect(result.summary.total).toBeGreaterThanOrEqual(1);
    }
  });

  it('retries a serialization failure and then restores once', async () => {
    let failOnce = true;
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('retry'), { code: '40001' });
      }
      return { rows: [], rowCount: typeof sql === 'string' && sql.includes('SELECT id FROM users') ? 0 : 1 };
    });
    await expect(restoreBackup(validPayload())).resolves.toMatchObject({ success: true });
    expect(clientQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT id FROM users'))).toHaveLength(2);
  });

  it('classifies a 23505 as user_exists only after verifying the same user id', async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unique'), { code: '23505' });
    });
    poolQuery.mockResolvedValue({ rows: [{ id: 'u1' }], rowCount: 1 });
    await expect(restoreBackup(validPayload())).resolves.toMatchObject({
      success: false, reason: 'user_exists',
    });
    expect(poolQuery).toHaveBeenCalledWith('SELECT id FROM users WHERE id = $1', ['u1']);
  });

  it('reports a non-user 23505 as invalid backup data', async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unique'), { code: '23505' });
    });
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(restoreBackup(validPayload())).resolves.toEqual({
      success: false,
      reason: 'invalid_data',
      message: 'backup restore encountered a conflicting unique artifact',
    });
  });

  it('restores joined receipt roots and revisions without an update path', async () => {
    const payload = validPayload();
    const joinedDecisionId = '22222222-2222-4222-8222-222222222222';
    const joinedRootId = '33333333-3333-4333-8333-333333333333';
    const joinedUserId = '11111111-1111-4111-8111-111111111111';
    const decisionRow = {
      id: joinedDecisionId, user_id: joinedUserId, situation_type: 'test', raw_event: {},
      interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {}, created_at: new Date(),
    };
    const content = {
      version: 1 as const, stage: 'decision_recorded' as const, disposition: 'pending' as const,
      policyEvaluations: [],
      decision: {
        id: joinedDecisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('decision', {
          id: joinedDecisionId, user_id: joinedUserId, situation_type: 'test', raw_event: {},
          interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {},
        }),
      },
      evidence: [], inference: { receipts: [] }, feedbackEvents: [], corrections: [],
    };
    payload['user'] = { ...(payload['user'] as object), id: joinedUserId };
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const receiptEventKey = buildDecisionReceiptEventKey('created', '55555555-5555-4555-8555-555555555555');
    payload['decisions'] = [{
      decision: decisionRow,
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
      joinedReceipt: {
        root: { id: joinedRootId, user_id: joinedUserId, decision_id: joinedDecisionId, created_at: new Date() },
        revisions: [{
          id: '44444444-4444-4444-8444-444444444444', receipt_id: joinedRootId, sequence: '1',
          event_key: receiptEventKey,
          previous_digest: null, content_digest: contentDigest,
          revision_digest: joinedDecisionReceiptRevisionDigest({
            revisionId: '44444444-4444-4444-8444-444444444444',
            receiptId: joinedRootId, decisionId: joinedDecisionId, userId: joinedUserId,
            sequence: 1, eventKey: receiptEventKey, previousDigest: null, contentDigest,
          }),
          stage: content.stage, disposition: content.disposition, content,
          candidate_action_id: null, barrier_id: null, explanation_id: null,
          approval_request_id: null, execution_plan_id: null, execution_result_id: null,
          execution_disposition: null,
          correction_of_revision_id: null, created_at: new Date(),
          trusted: true,
        }],
      },
    }];
    const result = await restoreBackup(payload);
    expect(result).toMatchObject({ success: true, summary: { counts: {
      decision_receipts: 1, decision_receipt_revisions: 1,
    } } });
    expect(clientQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && /UPDATE\s+decision_receipt/iu.test(sql))).toBe(false);
    const revisionInsert = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO decision_receipt_revisions'));
    const revisionParams = revisionInsert?.[1] as unknown[] | undefined;
    expect(revisionParams?.[2]).toBe(1);
  });

  it('aborts instead of reporting a receipt whose linkage insert affected no row', async () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' },
      candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', version: 1, decision_id: 'decision-a', explanation_id: 'explanation-a',
        status: 'on_device', receipt: {
          id: 'receipt-a', userId: 'u1', decisionId: 'decision-a', explanationId: 'explanation-a', status: 'on_device',
        }, created_at: new Date(),
      }],
    }];
    clientQuery.mockImplementation(async (sql: unknown) => ({
      rows: [], rowCount: typeof sql === 'string' && sql.includes('INSERT INTO inference_receipts') ? 0 : 1,
    }));
    await expect(restoreBackup(payload)).rejects.toThrow('could not be linked during restore');
  });
});
