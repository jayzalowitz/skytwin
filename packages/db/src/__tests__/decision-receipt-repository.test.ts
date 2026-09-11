import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  type JoinedDecisionReceiptContentV1,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';

const { queryMock, withTransactionMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  return {
    queryMock,
    withTransactionMock: vi.fn(async (fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock })),
  };
});
vi.mock('../connection.js', () => ({
  withTransaction: withTransactionMock,
}));

import { decisionReceiptRepository } from '../repositories/decision-receipt-repository.js';
import {
  decisionReceiptRowArtifactRefV1,
  decisionReceiptRowArtifactV1,
  decisionReceiptRowEvidenceRefV1,
} from '../repositories/decision-receipt-artifacts.js';

const userId = '11111111-1111-4111-8111-111111111111';
const decisionId = '22222222-2222-4222-8222-222222222222';
const rootId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const actionId = '66666666-6666-4666-8666-666666666666';
const explanationId = '77777777-7777-4777-8777-777777777777';
const barrierId = '88888888-8888-4888-8888-888888888888';
const approvalId = '99999999-9999-4999-8999-999999999999';
const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instant = new Date('2026-01-01T00:00:00.000Z');
const eventKey = (kind: string) => buildDecisionReceiptEventKey(kind, eventId);
const decisionRow = {
  id: decisionId, user_id: userId, situation_type: 'test', raw_event: {},
  interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {}, signal_id: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};
const decisionHash = joinedDecisionReceiptArtifactDigest('decision', {
  id: decisionId, user_id: userId, situation_type: 'test', raw_event: {},
  interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {}, signal_id: null,
});

function baseContent(): JoinedDecisionReceiptContentV1 {
  return {
    version: 1,
    stage: 'decision_recorded',
    disposition: 'pending',
    decision: { id: decisionId, canonicalHash: decisionHash },
    policyEvaluations: [],
    evidence: [],
    inference: { receipts: [] },
    feedbackEvents: [],
    corrections: [],
  };
}

function installHappyQueries(options: {
  completion?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  executionPlan?: Record<string, unknown>;
  inference?: Array<{ id: string; receipt: unknown }>;
  candidate?: Record<string, unknown>;
  explanation?: Record<string, unknown>;
  barrier?: Record<string, unknown>;
  existingRoot?: Record<string, unknown>;
  existingRevisions?: Record<string, unknown>[];
  decision?: Record<string, unknown>;
  signal?: Record<string, unknown>;
} = {}): void {
  queryMock.mockImplementation(async (rawSql: string, params: unknown[] = []) => {
    const sql = String(rawSql);
    if (sql.includes('FROM decisions WHERE')) return { rows: [options.decision ?? decisionRow] };
    if (sql.includes('SELECT risk_assessment FROM candidate_actions')) {
      return { rows: options.candidate ? [{ risk_assessment: options.candidate['risk_assessment'] }] : [] };
    }
    if (sql.includes('SELECT * FROM candidate_actions')) return { rows: options.candidate ? [options.candidate] : [] };
    if (sql.includes('FROM explanation_records')) return { rows: options.explanation ? [options.explanation] : [] };
    if (sql.includes('FROM pre_effect_barriers')) return { rows: options.barrier ? [options.barrier] : [] };
    if (sql.includes('FROM inference_receipt_completions')) {
      return { rows: options.completion ? [options.completion] : [] };
    }
    if (sql.includes('FROM inference_receipts')) return { rows: options.inference ?? [] };
    if (sql.includes('FROM approval_requests')) {
      return { rows: options.approval ? [options.approval] : [] };
    }
    if (sql.includes('FROM execution_plans')) {
      return { rows: options.executionPlan ? [options.executionPlan] : [] };
    }
    if (sql.includes('count(*)') && sql.includes('FROM signals')) {
      return { rows: [{ count: options.signal ? '1' : '0' }] };
    }
    if (sql.includes('FROM signals WHERE')) {
      return { rows: options.signal ? [options.signal] : [] };
    }
    if (sql.includes('FROM decision_receipts receipt')) {
      return { rows: options.existingRoot ? [options.existingRoot] : [] };
    }
    if (sql.includes('INSERT INTO decision_receipts')) {
      return { rows: [{ id: rootId, user_id: userId, decision_id: decisionId, created_at: new Date() }] };
    }
    if (sql.includes('SELECT id FROM decision_receipts')) return { rows: [{ id: rootId }] };
    if (sql.includes('event_key = $2')) return { rows: [] };
    if (sql.includes('ORDER BY sequence ASC')) return { rows: options.existingRevisions ?? [] };
    if (sql.includes('ORDER BY sequence DESC')) return { rows: [] };
    if (sql.includes('INSERT INTO decision_receipt_revisions')) {
      return { rows: [{
        id: params[0], receipt_id: rootId, sequence: params[2], event_key: params[3],
        previous_digest: params[4], content_digest: params[5], revision_digest: params[6], stage: params[7],
        disposition: params[8], content: JSON.parse(params[9] as string),
        candidate_action_id: params[10], barrier_id: params[11], explanation_id: params[12],
        approval_request_id: params[13], execution_plan_id: params[14], execution_result_id: params[15],
        execution_disposition: params[16], correction_of_revision_id: params[17], trusted: true,
        created_at: new Date(),
      }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

function chainRows(policySnapshot: Record<string, unknown>, barrierStatus: string): {
  candidate: Record<string, unknown>;
  explanation: Record<string, unknown>;
  barrier: Record<string, unknown>;
} {
  return {
    candidate: {
      id: actionId, decision_id: decisionId, action_type: 'test', description: 'test',
      parameters: {}, predicted_user_preference: 'neutral', risk_assessment: {},
      reversible: true, estimated_cost: null, created_at: instant,
    },
    explanation: {
      id: explanationId, decision_id: decisionId, what_happened: 'test', evidence_used: [],
      preferences_invoked: [], confidence_reasoning: 'test', action_rationale: 'test',
      escalation_rationale: null, correction_guidance: 'test',
      capability_provenance_node_id: null, created_at: instant,
    },
    barrier: {
      id: barrierId, user_id: userId, effect_type: 'event_execution', idempotency_key: 'opaque',
      status: barrierStatus, decision_id: decisionId, action_id: actionId,
      explanation_id: explanationId, policy_snapshot: policySnapshot, effect_result: {},
      failure_reason: null, created_at: instant, updated_at: instant,
    },
  };
}

function actionableContent(
  stage: 'approval_recorded' | 'execution_admitted',
  policySnapshot: Record<string, unknown>,
  barrierStatus: 'blocked' | 'prepared',
): JoinedDecisionReceiptContentV1 {
  const rows = chainRows(policySnapshot, barrierStatus);
  const candidateProjection = { ...rows.candidate };
  delete candidateProjection['created_at'];
  const explanationProjection = { ...rows.explanation };
  delete explanationProjection['created_at'];
  const barrierSnapshot = {
    version: 1 as const, status: barrierStatus, effectType: 'event_execution' as const,
    decisionId, candidateActionId: actionId, explanationId,
    policyHash: joinedDecisionReceiptArtifactDigest('policy', policySnapshot),
    createdAt: instant.toISOString(), updatedAt: instant.toISOString(),
  };
  const candidateAction = {
    id: actionId, canonicalHash: joinedDecisionReceiptArtifactDigest('candidate_action', candidateProjection),
  };
  const risk = { candidateActionId: actionId, canonicalHash: joinedDecisionReceiptArtifactDigest('risk', {}) };
  const policy = { barrierId, policyIds: [], canonicalHash: joinedDecisionReceiptArtifactDigest('policy', policySnapshot) };
  const barrier = { id: barrierId, canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot), snapshot: barrierSnapshot };
  const explanation = {
    id: explanationId, canonicalHash: joinedDecisionReceiptArtifactDigest('explanation', explanationProjection),
  };
  return {
    ...baseContent(), stage, disposition: stage === 'approval_recorded' ? 'approved' : 'pending',
    policyEvaluations: [{
      version: 1, phase: 'pre_effect',
      disposition: stage === 'approval_recorded' ? 'requires_approval' : 'allowed',
      candidateAction, risk, policy, barrier, explanation, evidence: [],
    }],
    candidateAction, risk, policy, barrier, explanation,
    ...(stage === 'approval_recorded' ? {
      approvalRequest: (() => {
        const snapshot = {
          version: 1 as const, status: 'approved' as const, candidateActionId: actionId,
          requestedAt: instant.toISOString(), expiresAt: new Date('2026-01-02T00:00:00.000Z').toISOString(),
          respondedAt: instant.toISOString(),
        };
        return { id: approvalId, canonicalHash: joinedDecisionReceiptArtifactDigest('approval', snapshot), snapshot };
      })(),
    } : {
      executionPlan: {
        id: planId, snapshot: {
          version: 1 as const, status: 'pending' as const, decisionId,
          candidateActionId: actionId, createdAt: instant.toISOString(), updatedAt: instant.toISOString(),
        },
        canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', {
          version: 1, status: 'pending', decisionId, candidateActionId: actionId,
          createdAt: instant.toISOString(), updatedAt: instant.toISOString(),
        }),
      },
    }),
  };
}

function gmailPolicyScenario(
  signalOverrides: Record<string, unknown> = {},
  decisionOverrides: Record<string, unknown> = {},
): {
  content: JoinedDecisionReceiptContentV1;
  decision: Record<string, unknown>;
  signal: Record<string, unknown>;
  rows: ReturnType<typeof chainRows>;
  root: Record<string, unknown>;
  previous: Record<string, unknown>;
  previousDigest: string;
} {
  const sourceSignalId = 'sig_gmail_opaque_source';
  const messageRefId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const decision = {
    ...decisionRow,
    signal_id: sourceSignalId,
    raw_event: { messageRefId },
    ...decisionOverrides,
  };
  const policySnapshot = { allowed: true, requiresApproval: false, policyIds: [] };
  const rows = chainRows(policySnapshot, 'prepared');
  rows.explanation['evidence_used'] = [{ evidenceId: `raw_${decisionId}` }];
  const signal = {
    id: eventId, user_id: userId, source: 'gmail', type: 'email', domain: 'email', data: {},
    timestamp: instant, retention_until: instant,
    source_signal_id: sourceSignalId,
    connector_account_id: planId,
    resource_ref_id: messageRefId,
    ...signalOverrides,
  };
  const content = actionableContent('execution_admitted', policySnapshot, 'prepared');
  content.stage = 'policy_evaluated';
  content.disposition = 'allowed';
  delete content.executionPlan;
  const evidenceRef = decisionReceiptRowEvidenceRefV1('signal', signal);
  const explanationRef = decisionReceiptRowArtifactRefV1('explanation', rows.explanation);
  content.decision = decisionReceiptRowArtifactRefV1('decision', decision);
  content.explanation = explanationRef;
  content.evidence = [evidenceRef];
  content.policyEvaluations = [{
    ...content.policyEvaluations[0]!, explanation: explanationRef, evidence: [evidenceRef],
  }];

  const previousContent = baseContent();
  previousContent.decision = content.decision;
  const previousContentDigest = joinedDecisionReceiptContentDigest(previousContent);
  const previousEventKey = eventKey('gmail_decision_recorded');
  const previousDigest = joinedDecisionReceiptRevisionDigest({
    revisionId,
    receiptId: rootId,
    decisionId,
    userId,
    sequence: 1,
    eventKey: previousEventKey,
    previousDigest: null,
    contentDigest: previousContentDigest,
  });
  return {
    content,
    decision,
    signal,
    rows,
    root: { id: rootId, user_id: userId, decision_id: decisionId, created_at: instant },
    previous: {
      id: revisionId, receipt_id: rootId, sequence: 1, event_key: previousEventKey,
      previous_digest: null, content_digest: previousContentDigest, revision_digest: previousDigest,
      stage: 'decision_recorded', disposition: 'pending', content: previousContent, trusted: true,
      candidate_action_id: null, barrier_id: null, explanation_id: null,
      approval_request_id: null, execution_plan_id: null, execution_result_id: null,
      execution_disposition: null, correction_of_revision_id: null, created_at: instant,
    },
    previousDigest,
  };
}

describe('decisionReceiptRepository', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withTransactionMock.mockClear();
  });

  it('creates the owned root and first immutable revision atomically', async () => {
    installHappyQueries();
    const content = baseContent();
    const result = await decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('decision_created'), expectedPreviousDigest: null, content,
    });
    expect(result).toMatchObject({ success: true, created: true, revision: { sequence: 1 } });
    expect(result.success && result.revision.content_digest).toBe(joinedDecisionReceiptContentDigest(content));
  });

  it('uses valid caller-owned root and revision IDs', async () => {
    installHappyQueries();
    const callerReceiptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const callerRevisionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const result = await decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('decision_created'),
      expectedPreviousDigest: null,
      content: baseContent(),
      receiptId: callerReceiptId,
      revisionId: callerRevisionId,
    });

    expect(result).toMatchObject({ success: true, revision: { id: callerRevisionId } });
    const rootInsert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO decision_receipts'));
    const revisionInsert = queryMock.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO decision_receipt_revisions'),
    );
    expect(rootInsert?.[1]).toEqual([userId, decisionId, callerReceiptId]);
    expect(revisionInsert?.[1]?.[0]).toBe(callerRevisionId);
  });

  it('appends on a caller-owned transaction without opening a nested transaction', async () => {
    installHappyQueries();
    const client = { query: queryMock } as unknown as PoolClient;
    const result = await decisionReceiptRepository.appendForUserInTransaction(client, userId, {
      eventKey: eventKey('decision_created'), expectedPreviousDigest: null, content: baseContent(),
    });
    expect(result).toMatchObject({ success: true, created: true, revision: { sequence: 1 } });
    expect(queryMock).toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('propagates serialization failures to the caller transaction without an internal retry', async () => {
    const serializationFailure = Object.assign(new Error('retry caller transaction'), { code: '40001' });
    const clientQuery = vi.fn().mockRejectedValue(serializationFailure);
    await expect(decisionReceiptRepository.appendForUserInTransaction(
      { query: clientQuery } as unknown as PoolClient,
      userId,
      { eventKey: eventKey('transaction_retry'), expectedPreviousDigest: null, content: baseContent() },
    )).rejects.toBe(serializationFailure);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('replays an immutable event without revalidating mutable source rows', async () => {
    const content = baseContent();
    const digest = joinedDecisionReceiptContentDigest(content);
    const root = { id: rootId, user_id: userId, decision_id: decisionId, created_at: new Date() };
    const key = eventKey('decision_created');
    const revision = {
      id: revisionId, receipt_id: rootId, sequence: 1, event_key: key,
      previous_digest: null, content_digest: digest, stage: content.stage,
      revision_digest: joinedDecisionReceiptRevisionDigest({
        revisionId, receiptId: rootId, decisionId, userId, sequence: 1,
        eventKey: key, previousDigest: null, contentDigest: digest,
      }),
      disposition: content.disposition, content, trusted: true,
      candidate_action_id: null as string | null, barrier_id: null, explanation_id: null,
      approval_request_id: null, execution_plan_id: null, execution_result_id: null,
      execution_disposition: null, correction_of_revision_id: null,
    };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM decision_receipts receipt')) return { rows: [root] };
      if (sql.includes('ORDER BY sequence ASC')) return { rows: [revision] };
      throw new Error(`source linkage should not be revisited: ${sql}`);
    });
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('decision_created'), expectedPreviousDigest: null, content,
    })).resolves.toMatchObject({ success: true, created: false, revision: { id: revisionId } });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('FROM decisions WHERE'))).toBe(false);
  });

  it.each(['untrusted', 'tampered-content'] as const)(
    'rejects an %s retained row on idempotent replay',
    async (tamper) => {
      const original = baseContent();
      const contentDigest = joinedDecisionReceiptContentDigest(original);
      const key = eventKey('replay_integrity');
      const root = { id: rootId, user_id: userId, decision_id: decisionId, created_at: instant };
      const revision = {
        id: revisionId, receipt_id: rootId, sequence: '1', event_key: key,
        previous_digest: null, content_digest: contentDigest,
        revision_digest: joinedDecisionReceiptRevisionDigest({
          revisionId, receiptId: rootId, decisionId, userId, sequence: 1,
          eventKey: key, previousDigest: null, contentDigest,
        }),
        stage: original.stage, disposition: original.disposition,
        content: tamper === 'tampered-content'
          ? { ...original, decision: { ...original.decision, canonicalHash: 'f'.repeat(64) } }
          : original,
        trusted: tamper !== 'untrusted',
        candidate_action_id: null, barrier_id: null, explanation_id: null,
        approval_request_id: null, execution_plan_id: null, execution_result_id: null,
        execution_disposition: null, correction_of_revision_id: null,
      };
      queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM decision_receipts receipt')) return { rows: [root] };
        if (sql.includes('ORDER BY sequence ASC')) return { rows: [revision] };
        throw new Error(`Unexpected SQL: ${sql}`);
      });
      await expect(decisionReceiptRepository.appendForUser(userId, {
        eventKey: key, expectedPreviousDigest: null, content: original,
      })).resolves.toEqual({ success: false, code: 'chain_conflict' });
    },
  );

  it('rejects a corrupted retained prefix before a new append', async () => {
    const content = baseContent();
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const root = { id: rootId, user_id: userId, decision_id: decisionId, created_at: instant };
    const revision = {
      id: revisionId, receipt_id: rootId, sequence: 1, event_key: eventKey('prefix'),
      previous_digest: null, content_digest: contentDigest, revision_digest: 'f'.repeat(64),
      stage: content.stage, disposition: content.disposition, content, trusted: true,
      candidate_action_id: null as string | null, barrier_id: null, explanation_id: null,
      approval_request_id: null, execution_plan_id: null, execution_result_id: null,
      execution_disposition: null, correction_of_revision_id: null,
    };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM decision_receipts receipt')) return { rows: [root] };
      if (sql.includes('ORDER BY sequence ASC')) return { rows: [revision] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('new_event'), expectedPreviousDigest: revision.revision_digest, content,
    })).resolves.toEqual({ success: false, code: 'chain_conflict' });
  });

  it('verifies a retained chain before returning it from the read path', async () => {
    const content = baseContent();
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const key = eventKey('read_chain');
    const revisionDigest = joinedDecisionReceiptRevisionDigest({
      revisionId, receiptId: rootId, decisionId, userId, sequence: 1,
      eventKey: key, previousDigest: null, contentDigest,
    });
    const root = { id: rootId, user_id: userId, decision_id: decisionId, created_at: instant };
    const revision = {
      id: revisionId, receipt_id: rootId, sequence: '1', event_key: key,
      previous_digest: null, content_digest: contentDigest, revision_digest: revisionDigest,
      stage: content.stage, disposition: content.disposition, content, trusted: true,
      candidate_action_id: null as string | null, barrier_id: null, explanation_id: null,
      approval_request_id: null, execution_plan_id: null, execution_result_id: null,
      execution_disposition: null, correction_of_revision_id: null,
    };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM decision_receipts receipt')) return { rows: [root] };
      if (sql.includes('FROM decision_receipt_revisions')) return { rows: [revision] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(decisionReceiptRepository.findByDecisionForUser(userId, decisionId))
      .resolves.toMatchObject({ success: true, revisions: [{ id: revisionId, sequence: 1 }] });
    revision.revision_digest = '0'.repeat(64);
    await expect(decisionReceiptRepository.findByDecisionForUser(userId, decisionId))
      .resolves.toEqual({ success: false, code: 'verification_failed' });
    revision.revision_digest = revisionDigest;
    revision.trusted = false;
    await expect(decisionReceiptRepository.findByDecisionForUser(userId, decisionId))
      .resolves.toEqual({ success: false, code: 'verification_failed' });
    revision.trusted = true;
    revision.candidate_action_id = actionId;
    await expect(decisionReceiptRepository.findByDecisionForUser(userId, decisionId))
      .resolves.toEqual({ success: false, code: 'verification_failed' });
  });

  it('rejects a false canonical hash before inserting a root or revision', async () => {
    installHappyQueries();
    const content = baseContent();
    content.decision = { ...content.decision, canonicalHash: 'f'.repeat(64) };
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('false_hash'), expectedPreviousDigest: null, content,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
  });

  it('rejects a completed-inference omission before insert', async () => {
    installHappyQueries({ completion: { decision_id: decisionId, explanation_id: revisionId } });
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('stale_inference'), expectedPreviousDigest: null, content: baseContent(),
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
  });

  it('requires the inference set to equal all durable receipts at completion', async () => {
    const completedAt = new Date('2026-01-02T00:00:00.000Z');
    const completion = { decision_id: decisionId, explanation_id: revisionId, completed_at: completedAt };
    installHappyQueries({
      completion,
      inference: [{ id: revisionId, receipt: { version: 1, status: 'on_device' } }],
    });
    const content = baseContent();
    content.inference = {
      receipts: [],
      completion: {
        id: decisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('inference_completion', {
          decision_id: decisionId,
          explanation_id: revisionId,
          completed_at: completedAt.toISOString(),
        }),
      },
    };
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('omitted_inference'), expectedPreviousDigest: null, content,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
  });

  it('rejects newly durable inference receipts after a prior completion', async () => {
    const completion = {
      id: decisionId,
      canonicalHash: joinedDecisionReceiptArtifactDigest('inference_completion', {
        decision_id: decisionId, explanation_id: explanationId,
        completed_at: instant.toISOString(),
      }),
    };
    const previousContent = baseContent();
    previousContent.inference = { receipts: [], completion };
    const previousEventKey = eventKey('completed_set');
    const previousContentDigest = joinedDecisionReceiptContentDigest(previousContent);
    const priorDigest = joinedDecisionReceiptRevisionDigest({
      revisionId, receiptId: rootId, decisionId, userId, sequence: 1,
      eventKey: previousEventKey, previousDigest: null, contentDigest: previousContentDigest,
    });
    const root = { id: rootId, user_id: userId, decision_id: decisionId, created_at: instant };
    const previous = {
      id: revisionId, receipt_id: rootId, sequence: '1', event_key: previousEventKey,
      previous_digest: null, content_digest: previousContentDigest,
      revision_digest: priorDigest, stage: previousContent.stage,
      disposition: previousContent.disposition, content: previousContent, trusted: true,
      candidate_action_id: null, barrier_id: null, explanation_id: null,
      approval_request_id: null, execution_plan_id: null, execution_result_id: null,
      execution_disposition: null, correction_of_revision_id: null,
    };
    const durableReceipt = { id: eventId, receipt: { version: 1, status: 'on_device' } };
    const nextContent = baseContent();
    nextContent.inference = {
      completion,
      receipts: [{
        id: eventId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('inference_receipt', durableReceipt.receipt),
      }],
    };
    queryMock.mockImplementation(async (rawSql: string) => {
      const sql = String(rawSql);
      if (sql.includes('FROM decision_receipts receipt')) return { rows: [root] };
      if (sql.includes('event_key = $2')) return { rows: [] };
      if (sql.includes('ORDER BY sequence ASC')) return { rows: [previous] };
      if (sql.includes('FROM decisions WHERE')) return { rows: [decisionRow] };
      if (sql.includes('FROM inference_receipts')) return { rows: [durableReceipt] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('late_inference'), expectedPreviousDigest: priorDigest, content: nextContent,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO decision_receipt_revisions'))).toBe(false);
  });

  it('rejects semantically impossible stage/disposition before opening SQL', async () => {
    const content = { ...baseContent(), stage: 'execution_recorded', disposition: 'succeeded' } as JoinedDecisionReceiptContentV1;
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('impossible'), expectedPreviousDigest: null, content,
    })).resolves.toEqual({ success: false, code: 'invalid_content' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('cannot seed a pre-existing shell root with a later lifecycle stage', async () => {
    const policySnapshot = { allowed: true, requiresApproval: false, policyIds: [] };
    const rows = chainRows(policySnapshot, 'prepared');
    const plan = {
      id: planId, decision_id: decisionId, action_id: actionId,
      status: 'pending', steps: [], created_at: instant, updated_at: instant,
    };
    installHappyQueries({
      ...rows,
      executionPlan: plan,
      existingRoot: { id: rootId, user_id: userId, decision_id: decisionId, created_at: instant },
    });
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('shell_root'), expectedPreviousDigest: null,
      content: actionableContent('execution_admitted', policySnapshot, 'prepared'),
    })).resolves.toEqual({ success: false, code: 'chain_conflict' });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO decision_receipt_revisions')))
      .toBe(false);
  });

  it('rejects malformed UUIDs through typed results without issuing SQL', async () => {
    const content = baseContent();
    content.decision = { ...content.decision, id: 'not-a-uuid' };
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('garbage_id'), expectedPreviousDigest: null, content,
    })).resolves.toEqual({ success: false, code: 'invalid_content' });
    await expect(decisionReceiptRepository.findByDecisionForUser(userId, 'not-a-uuid'))
      .resolves.toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('binds approval status into the server-derived artifact hash', async () => {
    const policySnapshot = { allowed: true, requiresApproval: true, policyIds: [] };
    const rows = chainRows(policySnapshot, 'blocked');
    const approval = {
      id: approvalId, user_id: userId, decision_id: decisionId, candidate_action: { id: actionId },
      reason: 'test', urgency: 'normal', status: 'pending', response: null,
      requested_at: instant, expires_at: new Date('2026-01-02T00:00:00.000Z'), responded_at: null,
    };
    installHappyQueries({ approval, ...rows });
    const content = actionableContent('approval_recorded', policySnapshot, 'blocked');
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('stale_approval'), expectedPreviousDigest: null, content,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
  });

  it('binds Gmail source IDs to the owned signal UUID used by receipt evidence', async () => {
    const scenario = gmailPolicyScenario();
    installHappyQueries({
      ...scenario.rows,
      decision: scenario.decision,
      signal: scenario.signal,
      existingRoot: scenario.root,
      existingRevisions: [scenario.previous],
    });

    await expect(decisionReceiptRepository.appendForUserInTransaction(
      { query: queryMock } as unknown as PoolClient,
      userId,
      {
        eventKey: eventKey('gmail_signal'),
        expectedPreviousDigest: scenario.previousDigest,
        content: scenario.content,
      },
    )).resolves.toMatchObject({ success: true, created: true, revision: { sequence: 2 } });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('FROM signals WHERE'))).toBe(true);
  });

  it('binds opaque Gmail signal UUID decisions to their owned receipt evidence', async () => {
    const scenario = gmailPolicyScenario({}, { signal_id: eventId });
    installHappyQueries({
      ...scenario.rows,
      decision: scenario.decision,
      signal: scenario.signal,
      existingRoot: scenario.root,
      existingRevisions: [scenario.previous],
    });

    await expect(decisionReceiptRepository.appendForUserInTransaction(
      { query: queryMock } as unknown as PoolClient,
      userId,
      {
        eventKey: eventKey('gmail_opaque_signal'),
        expectedPreviousDigest: scenario.previousDigest,
        content: scenario.content,
      },
    )).resolves.toMatchObject({ success: true, created: true, revision: { sequence: 2 } });
  });

  it.each([
    ['cross-account signal with the same source ID', {
      connector_account_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resource_ref_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }, {}],
    ['wrong opaque resource', { resource_ref_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, {}],
    ['wrong signal source type', { source: 'google_calendar' }, {}],
    ['wrong connector source ID', { source_signal_id: 'sig_gmail_other_source' }, {}],
    ['missing connector source ID', { source_signal_id: null }, {}],
    ['missing signal resource', { resource_ref_id: null }, {}],
    ['missing decision resource', {}, { raw_event: {} }],
    ['mismatched decision resource', {}, {
      raw_event: { messageRefId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    }],
  ] as const)('rejects Gmail receipt evidence with %s', async (_label, signalOverrides, decisionOverrides) => {
    const scenario = gmailPolicyScenario(signalOverrides, decisionOverrides);
    installHappyQueries({
      ...scenario.rows,
      decision: scenario.decision,
      signal: scenario.signal,
      existingRoot: scenario.root,
      existingRevisions: [scenario.previous],
    });
    await expect(decisionReceiptRepository.appendForUserInTransaction(
      { query: queryMock } as unknown as PoolClient,
      userId,
      {
        eventKey: eventKey('gmail_signal_invalid'),
        expectedPreviousDigest: scenario.previousDigest,
        content: scenario.content,
      },
    )).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
  });

  it('preserves legacy receipt evidence that directly names the signal UUID', async () => {
    const scenario = gmailPolicyScenario({
      source: 'legacy',
      source_signal_id: null,
      connector_account_id: null,
      resource_ref_id: null,
    }, {
      signal_id: eventId,
      raw_event: {},
    });
    installHappyQueries({
      ...scenario.rows,
      decision: scenario.decision,
      signal: scenario.signal,
      existingRoot: scenario.root,
      existingRevisions: [scenario.previous],
    });
    await expect(decisionReceiptRepository.appendForUserInTransaction(
      { query: queryMock } as unknown as PoolClient,
      userId,
      {
        eventKey: eventKey('legacy_signal'),
        expectedPreviousDigest: scenario.previousDigest,
        content: scenario.content,
      },
    )).resolves.toMatchObject({ success: true, created: true, revision: { sequence: 2 } });
  });

  it('binds execution status into the server-derived artifact hash', async () => {
    const policySnapshot = { allowed: true, requiresApproval: false, policyIds: [] };
    const rows = chainRows(policySnapshot, 'prepared');
    const plan = {
      id: planId, decision_id: decisionId, action_id: actionId,
      status: 'running', steps: [], created_at: instant, updated_at: instant,
    };
    installHappyQueries({ executionPlan: plan, ...rows });
    const content = actionableContent('execution_admitted', policySnapshot, 'prepared');
    await expect(decisionReceiptRepository.appendForUser(userId, {
      eventKey: eventKey('stale_execution'), expectedPreviousDigest: null, content,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
  });
});

describe('decision receipt artifact v1 projections', () => {
  it('ignores future columns but binds committed fields with stable normalization', () => {
    const row = {
      ...decisionRow,
      metadata: { bytes: Buffer.from('safe') },
      future_nullable_column: 'must-not-change-v1',
    };
    const projected = decisionReceiptRowArtifactV1('decision', row);
    const withAnotherFutureColumn = decisionReceiptRowArtifactV1('decision', {
      ...row, future_nullable_column: 'changed', another_future_column: 42,
    });
    expect(joinedDecisionReceiptArtifactDigest('decision', projected)).toBe(
      joinedDecisionReceiptArtifactDigest('decision', withAnotherFutureColumn),
    );
    expect(joinedDecisionReceiptArtifactDigest('decision', projected)).not.toBe(
      joinedDecisionReceiptArtifactDigest('decision', decisionReceiptRowArtifactV1('decision', {
        ...row, urgency: 'urgent',
      })),
    );
    expect(projected).not.toHaveProperty('created_at');
    expect(projected).toMatchObject({ metadata: { bytes: Buffer.from('safe').toString('base64') } });
    expect(decisionReceiptRowArtifactV1('signal', {
      id: actionId, user_id: userId, source: 'test', type: 'test', domain: 'test', data: {},
      timestamp: instant, retention_until: instant,
    })).toEqual(decisionReceiptRowArtifactV1('signal', {
      id: actionId, user_id: userId, source: 'test', type: 'test', domain: 'test', data: {},
      timestamp: instant.toISOString(), retention_until: instant.toISOString(),
    }));
  });

  it('keeps connector linkage outside the immutable v1 signal projection', () => {
    const base = {
      id: eventId, user_id: userId, source: 'gmail', type: 'email', domain: 'email', data: {},
      timestamp: instant, retention_until: instant, source_signal_id: 'sig_gmail_source',
      connector_account_id: actionId, resource_ref_id: barrierId,
    };
    const original = joinedDecisionReceiptArtifactDigest(
      'signal', decisionReceiptRowArtifactV1('signal', base),
    );
    expect(original).toBe(joinedDecisionReceiptArtifactDigest(
      'signal', decisionReceiptRowArtifactV1('signal', { ...base, resource_ref_id: approvalId }),
    ));
    expect(decisionReceiptRowEvidenceRefV1('signal', base)).toMatchObject({
      id: eventId, kind: 'signal', canonicalHash: original,
    });
    expect(decisionReceiptRowArtifactRefV1('inference_completion', {
      decision_id: decisionId, explanation_id: explanationId, completed_at: instant,
    })).toMatchObject({ id: decisionId, canonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
