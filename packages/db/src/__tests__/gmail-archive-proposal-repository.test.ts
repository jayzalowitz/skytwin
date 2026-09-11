import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  RiskDimension,
} from '@skytwin/shared-types';
import { RiskAssessor } from '@skytwin/decision-engine';
import type { PoolClient } from 'pg';
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
import type { PreEffectBarrierRow } from '../repositories/pre-effect-barrier-repository.js';
import type { PersistGmailArchiveProposalInput } from '../repositories/gmail-archive-proposal-repository.js';

const { appendMock, queryMock, withTransactionMock } = vi.hoisted(() => ({
  appendMock: vi.fn(),
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  withTransaction: withTransactionMock,
}));

vi.mock('../repositories/decision-receipt-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/decision-receipt-lifecycle.js')>();
  return {
    ...actual,
    decisionReceiptLifecycleRepository: { appendForUser: appendMock },
  };
});

const {
  buildGmailArchiveProposalCandidate,
  GmailArchiveProposalReceiptError,
  gmailArchiveProposalRepository,
} = await import('../repositories/gmail-archive-proposal-repository.js');

const userId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const messageRefId = '33333333-3333-4333-8333-333333333333';
const signalId = '44444444-4444-4444-8444-444444444444';
const receiptId = '55555555-5555-4555-8555-555555555555';
const observedAt = new Date('2026-09-11T12:00:00.000Z');
const requestedAt = new Date('2026-09-11T12:00:01.000Z');
const expiresAt = new Date('2026-09-12T12:00:01.000Z');

interface Store {
  decision?: DecisionRow;
  candidate?: CandidateActionRow;
  outcome?: DecisionOutcomeRow;
  explanation?: ExplanationRecordRow;
  barrier?: PreEffectBarrierRow;
  approval?: ApprovalRequestRow;
  receipt?: DecisionReceiptRow;
  revisions: DecisionReceiptRevisionRow[];
}

let store: Store;
let decisionInsertIds: string[];
let signalIsInInbox: boolean;

const signal: SignalRow & { authoring_tier: string } = {
  id: signalId,
  user_id: userId,
  source: 'gmail',
  type: 'email',
  domain: 'email',
  data: {},
  timestamp: observedAt,
  retention_until: new Date('2026-10-11T12:00:00.000Z'),
  created_at: observedAt,
  source_signal_id: 'gmail-source-1',
  connector_account_id: accountId,
  resource_ref_id: messageRefId,
  authoring_tier: 'inbox_automated',
};

function installQueryStore(): void {
  queryMock.mockImplementation(async (rawSql: string, params: unknown[] = []) => {
    const sql = String(rawSql);
    if (sql.includes('FROM signals AS signal')) {
      expect(sql).toContain('ref.last_observed_inbox = true');
      return { rows: signalIsInInbox ? [signal] : [] };
    }
    if (sql.includes('INSERT INTO decisions')) {
      decisionInsertIds.push(String(params[0]));
      if (store.decision) return { rows: [] };
      store.decision = {
        id: String(params[0]), user_id: String(params[1]), situation_type: 'email_triage',
        raw_event: JSON.parse(String(params[2])), interpreted_situation: JSON.parse(String(params[3])),
        domain: 'email', urgency: 'normal', metadata: JSON.parse(String(params[4])),
        signal_id: String(params[5]), created_at: observedAt,
      };
      return { rows: [store.decision] };
    }
    if (sql.includes('FROM decisions WHERE')) return { rows: store.decision ? [store.decision] : [] };
    if (sql.includes('INSERT INTO candidate_actions')) {
      store.candidate = {
        id: String(params[0]), decision_id: String(params[1]), action_type: 'archive_email',
        description: String(params[2]), parameters: JSON.parse(String(params[3])),
        predicted_user_preference: String(params[4]), risk_assessment: JSON.parse(String(params[5])),
        reversible: true, estimated_cost: null, created_at: observedAt,
      };
      return { rows: [store.candidate] };
    }
    if (sql.includes('FROM candidate_actions')) return { rows: store.candidate ? [store.candidate] : [] };
    if (sql.includes('INSERT INTO decision_outcomes')) {
      store.outcome = {
        id: String(params[0]), decision_id: String(params[1]), selected_action_id: String(params[2]),
        auto_executed: false, requires_approval: true, escalation_reason: String(params[3]),
        explanation: String(params[3]), confidence: Number(params[4]), created_at: observedAt,
        execution_plan_id: null,
      };
      return { rows: [store.outcome] };
    }
    if (sql.includes('FROM decision_outcomes')) return { rows: store.outcome ? [store.outcome] : [] };
    if (sql.includes('INSERT INTO explanation_records')) {
      store.explanation = {
        id: String(params[0]), decision_id: String(params[1]), what_happened: String(params[2]),
        evidence_used: JSON.parse(String(params[3])), preferences_invoked: [],
        confidence_reasoning: String(params[4]), action_rationale: String(params[5]),
        escalation_rationale: String(params[6]), correction_guidance: String(params[7]),
        capability_provenance_node_id: null, created_at: observedAt,
      };
      return { rows: [store.explanation] };
    }
    if (sql.includes('FROM explanation_records')) return { rows: store.explanation ? [store.explanation] : [] };
    if (sql.includes('INSERT INTO pre_effect_barriers')) {
      store.barrier = {
        id: String(params[0]), user_id: String(params[1]), effect_type: 'event_execution',
        idempotency_key: String(params[2]), status: 'blocked', decision_id: String(params[3]),
        action_id: String(params[4]), explanation_id: String(params[5]),
        policy_snapshot: JSON.parse(String(params[6])), effect_result: JSON.parse(String(params[7])),
        failure_reason: String(params[8]), created_at: observedAt, updated_at: observedAt,
      };
      return { rows: [store.barrier] };
    }
    if (sql.includes('FROM pre_effect_barriers')) return { rows: store.barrier ? [store.barrier] : [] };
    if (sql.includes('INSERT INTO approval_requests')) {
      store.approval = {
        id: String(params[0]), user_id: String(params[1]), decision_id: String(params[2]),
        candidate_action: JSON.parse(String(params[3])), reason: String(params[4]), urgency: 'normal',
        status: 'pending', requested_at: requestedAt, expires_at: expiresAt, responded_at: null,
        response: null, batch_id: null, confirmation_level: 'single', first_confirmed_at: null,
        confirmation_token: null,
      };
      return { rows: [store.approval] };
    }
    if (sql.includes('FROM approval_requests')) return { rows: store.approval ? [store.approval] : [] };
    if (sql.includes('FROM decision_receipts')) return { rows: store.receipt ? [store.receipt] : [] };
    if (sql.includes('FROM decision_receipt_revisions')) return { rows: store.revisions };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

function installReceiptAppender(): void {
  appendMock.mockImplementation(async (_client, appendUserId: string, input) => {
    if (!store.decision) throw new Error('decision missing');
    store.receipt ??= {
      id: input.receiptId ?? receiptId,
      user_id: appendUserId,
      decision_id: store.decision.id,
      created_at: observedAt,
    };
    const revisionId = input.revisionId ??
      `66666666-6666-4666-8666-66666666666${store.revisions.length + 1}`;
    const contentDigest = joinedDecisionReceiptContentDigest(input.content);
    const revisionDigest = joinedDecisionReceiptRevisionDigest({
      revisionId,
      receiptId: store.receipt.id,
      decisionId: store.decision.id,
      userId: appendUserId,
      sequence: store.revisions.length + 1,
      eventKey: buildDecisionReceiptEventKey(input.eventKind, input.eventId),
      previousDigest: input.expectedPreviousDigest,
      contentDigest,
    });
    const revision: DecisionReceiptRevisionRow = {
      id: revisionId,
      receipt_id: store.receipt.id,
      sequence: store.revisions.length + 1,
      event_key: buildDecisionReceiptEventKey(input.eventKind, input.eventId),
      previous_digest: input.expectedPreviousDigest,
      content_digest: contentDigest,
      revision_digest: revisionDigest,
      stage: input.content.stage,
      disposition: input.content.disposition,
      content: input.content,
      trusted: true,
      candidate_action_id: input.content.candidateAction?.id ?? null,
      barrier_id: input.content.barrier?.id ?? null,
      explanation_id: input.content.explanation?.id ?? null,
      approval_request_id: input.content.approvalRequest?.id ?? null,
      execution_plan_id: null,
      execution_result_id: null,
      execution_disposition: null,
      correction_of_revision_id: null,
      created_at: observedAt,
    };
    store.revisions.push(revision);
    return { success: true, created: true, receipt: store.receipt, revision };
  });
}

const assessed = new RiskAssessor().assess(
  buildGmailArchiveProposalCandidate(userId, accountId, messageRefId),
);
const riskAssessment = {
  overallTier: assessed.overallTier,
  dimensions: assessed.dimensions,
  reasoning: assessed.reasoning,
  assessedAt: observedAt,
};
const input = { userId, connectorAccountId: accountId, messageRefId, signalId, riskAssessment };

describe('gmailArchiveProposalRepository', () => {
  beforeEach(() => {
    store = { revisions: [] };
    decisionInsertIds = [];
    signalIsInInbox = true;
    vi.clearAllMocks();
    withTransactionMock.mockImplementation(async (fn: (client: PoolClient) => Promise<unknown>) => {
      try {
        return await fn({ query: queryMock } as unknown as PoolClient);
      } catch (error) {
        // Mirror the production wrapper's all-or-nothing rollback for this
        // in-memory SQL model.
        store = { revisions: [] };
        throw error;
      }
    });
    installQueryStore();
    installReceiptAppender();
  });

  it('persists the exact proposal graph and three cumulative receipt stages', async () => {
    const result = await gmailArchiveProposalRepository.persist(input);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(store.candidate?.parameters).toEqual({
      schema: 'gmail_inbox_mutation_v1',
      messageRefId,
      operation: 'archive',
      domain: 'email',
      costZeroIntent: 'verified_zero',
      provenance: 'untrusted_external',
    });
    expect(Object.keys(store.candidate?.parameters ?? {})).toHaveLength(6);
    expect(store.decision).toMatchObject({
      signal_id: signalId,
      raw_event: { signalId, messageRefId },
    });
    expect(store.candidate).toMatchObject({
      action_type: 'archive_email', reversible: true, estimated_cost: null,
    });
    const persistedCandidate = store.candidate!;
    expect(persistedCandidate.risk_assessment).toMatchObject({
      actionId: persistedCandidate.id,
      overallTier: expect.any(String),
      reasoning: expect.any(String),
      assessedAt: observedAt.toISOString(),
    });
    expect(persistedCandidate.risk_assessment).toEqual({
      actionId: persistedCandidate.id,
      overallTier: riskAssessment.overallTier,
      dimensions: riskAssessment.dimensions,
      reasoning: riskAssessment.reasoning,
      assessedAt: observedAt.toISOString(),
    });
    expect(Object.keys(persistedCandidate.risk_assessment['dimensions'] as object)).toEqual(
      Object.values(RiskDimension),
    );
    expect(store.outcome).toMatchObject({ auto_executed: false, requires_approval: true });
    expect(store.barrier).toMatchObject({
      status: 'blocked', effect_type: 'event_execution', idempotency_key: store.decision?.id,
      effect_result: { proposalOnly: true, dispatched: false },
    });
    expect(store.approval).toMatchObject({ status: 'pending', confirmation_level: 'single' });
    expect(store.revisions.map((revision) => [revision.stage, revision.disposition])).toEqual([
      ['decision_recorded', 'pending'],
      ['policy_evaluated', 'requires_approval'],
      ['approval_recorded', 'requires_approval'],
    ]);
    expect(store.revisions[1]?.previous_digest).toBe(store.revisions[0]?.revision_digest);
    expect(store.revisions[2]?.previous_digest).toBe(store.revisions[1]?.revision_digest);
    expect(new Set(appendMock.mock.calls.map(([, , appendInput]) => appendInput.receiptId)).size).toBe(1);
    expect(new Set(appendMock.mock.calls.map(([, , appendInput]) => appendInput.revisionId)).size).toBe(3);
    expect(JSON.stringify(store)).not.toMatch(/provider_message|provider_thread|access_token|refresh_token/);
  });

  it('returns the exact committed graph on replay without inserting another candidate or receipt', async () => {
    const first = await gmailArchiveProposalRepository.persist(input);
    expect(first).toMatchObject({ ok: true, created: true });
    appendMock.mockClear();
    queryMock.mockClear();

    const replay = await gmailArchiveProposalRepository.persist(input);

    expect(replay).toMatchObject({ ok: true, created: false });
    expect(appendMock).not.toHaveBeenCalled();
    expect(store.revisions).toHaveLength(3);
    expect(queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO candidate_actions'))).toHaveLength(0);
    if (first.ok && replay.ok) {
      expect(replay.proposal.candidate.id).toBe(first.proposal.candidate.id);
      expect(replay.proposal.approval.id).toBe(first.proposal.approval.id);
    }
  });

  it('rejects a changed existing graph instead of repairing or appending it', async () => {
    await gmailArchiveProposalRepository.persist(input);
    store.candidate!.parameters['extra'] = true;
    appendMock.mockClear();

    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    expect(appendMock).not.toHaveBeenCalled();
    expect(store.revisions).toHaveLength(3);
  });

  it('turns a typed receipt failure into a transaction failure', async () => {
    appendMock.mockResolvedValueOnce({ success: false, code: 'linkage_mismatch' });

    await expect(gmailArchiveProposalRepository.persist(input)).rejects.toEqual(
      new GmailArchiveProposalReceiptError('linkage_mismatch'),
    );
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(store).toEqual({ revisions: [] });
  });

  it('retries the whole transaction on 40001 with the same preallocated IDs', async () => {
    const serializationFailure = Object.assign(new Error('restart transaction'), { code: '40001' });
    const baseImplementation = queryMock.getMockImplementation()!;
    let failed = false;
    queryMock.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (!failed && sql.includes('INSERT INTO decisions')) {
        failed = true;
        decisionInsertIds.push(String((args[1] as unknown[])[0]));
        throw serializationFailure;
      }
      return baseImplementation(...args);
    });

    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    expect(withTransactionMock).toHaveBeenCalledTimes(2);
    expect(decisionInsertIds).toHaveLength(2);
    expect(new Set(decisionInsertIds).size).toBe(1);
  });

  it('rejects malformed IDs and missing bound evidence before artifact inserts', async () => {
    await expect(gmailArchiveProposalRepository.persist({ ...input, userId: ' ' })).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(withTransactionMock).not.toHaveBeenCalled();

    const incompleteDimensions = { ...riskAssessment.dimensions } as Record<string, unknown>;
    delete incompleteDimensions['operational_risk'];
    await expect(gmailArchiveProposalRepository.persist({
      ...input,
      riskAssessment: { ...riskAssessment, dimensions: incompleteDimensions } as typeof riskAssessment,
    })).resolves.toEqual({ ok: false, error: 'invalid_input' });
    expect(withTransactionMock).not.toHaveBeenCalled();

    queryMock.mockImplementationOnce(async () => ({ rows: [] }));
    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toEqual({
      ok: false,
      error: 'evidence_not_found',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects evidence whose latest owned observation is outside Inbox', async () => {
    signalIsInInbox = false;

    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toEqual({
      ok: false,
      error: 'evidence_not_found',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown]>([
    ['null input', () => null],
    ['top-level extra key', () => ({ ...input, extra: true })],
    ['top-level symbol', () => Object.assign({ ...input }, { [Symbol('hidden')]: true })],
    ['top-level accessor', () => Object.defineProperty({ ...input }, 'userId', {
      enumerable: true,
      get: () => { throw new Error('accessor must not be invoked'); },
    })],
    ['null risk', () => ({ ...input, riskAssessment: null })],
    ['risk extra key', () => ({ ...input, riskAssessment: { ...riskAssessment, extra: true } })],
    ['risk accessor', () => ({
      ...input,
      riskAssessment: Object.defineProperty({ ...riskAssessment }, 'reasoning', {
        enumerable: true,
        get: () => riskAssessment.reasoning,
      }),
    })],
    ['dimensions symbol', () => ({
      ...input,
      riskAssessment: {
        ...riskAssessment,
        dimensions: Object.assign({ ...riskAssessment.dimensions }, { [Symbol('hidden')]: true }),
      },
    })],
    ['dimensions extra key', () => ({
      ...input,
      riskAssessment: {
        ...riskAssessment,
        dimensions: { ...riskAssessment.dimensions, extra: riskAssessment.dimensions.reversibility },
      },
    })],
    ['dimension accessor', () => ({
      ...input,
      riskAssessment: {
        ...riskAssessment,
        dimensions: {
          ...riskAssessment.dimensions,
          reversibility: Object.defineProperty(
            { ...riskAssessment.dimensions.reversibility },
            'score',
            { enumerable: true, get: () => 0.1 },
          ),
        },
      },
    })],
    ['bad date', () => ({
      ...input,
      riskAssessment: { ...riskAssessment, assessedAt: new Date(Number.NaN) },
    })],
    ['throwing proxy', () => new Proxy({ ...input }, {
      ownKeys: () => { throw new Error('hostile reflection'); },
    })],
    ['revoked proxy', () => {
      const revoked = Proxy.revocable({ ...input }, {});
      revoked.revoke();
      return revoked.proxy;
    }],
  ])('rejects %s without opening a transaction', async (_label, factory) => {
    const invalid = factory();

    await expect(gmailArchiveProposalRepository.persist(
      invalid as PersistGmailArchiveProposalInput,
    )).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
