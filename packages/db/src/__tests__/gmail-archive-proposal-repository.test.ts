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
let legacyDecisionExists: boolean;

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
    if (sql.includes('FROM decisions AS legacy')) {
      expect(sql).toContain("legacy.raw_event->>'messageRefId' = $3::STRING");
      expect(sql).toContain('legacy.signal_id != $4::STRING');
      expect(params).toEqual([userId, signal.source_signal_id, messageRefId, signalId]);
      return { rows: legacyDecisionExists ? [{ id: userId }] : [] };
    }
    if (sql.includes('INSERT INTO decisions')) {
      decisionInsertIds.push(String(params[0]));
      if (store.decision) return { rows: [] };
      store.decision = {
        id: String(params[0]), user_id: String(params[1]), situation_type: 'email_triage',
        raw_event: JSON.parse(String(params[2])), interpreted_situation: JSON.parse(String(params[3])),
        domain: 'email', urgency: 'medium', metadata: JSON.parse(String(params[4])),
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
        candidate_action: JSON.parse(String(params[3])), reason: String(params[4]), urgency: 'medium',
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

const candidate = buildGmailArchiveProposalCandidate(userId, accountId, messageRefId);
const assessed = new RiskAssessor().assess(candidate);
const riskAssessment = {
  actionId: assessed.actionId,
  overallTier: assessed.overallTier,
  dimensions: assessed.dimensions,
  reasoning: assessed.reasoning,
  assessedAt: observedAt,
};
const input = {
  userId,
  connectorAccountId: accountId,
  messageRefId,
  signalId,
  proposal: { candidate, riskAssessment },
};

describe('gmailArchiveProposalRepository', () => {
  beforeEach(() => {
    store = { revisions: [] };
    decisionInsertIds = [];
    signalIsInInbox = true;
    legacyDecisionExists = false;
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
      id: candidate.decisionId,
      urgency: 'medium',
      signal_id: signalId,
      raw_event: { signalId, messageRefId },
    });
    expect(store.candidate).toMatchObject({
      id: candidate.id,
      description: candidate.description,
      predicted_user_preference: candidate.confidence,
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
    expect(store.approval).toMatchObject({
      status: 'pending', urgency: 'medium', confirmation_level: 'single',
    });
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

  it('uses one canonical snapshot when the submitted proposal is mutated in flight', async () => {
    const mutableCandidate = {
      ...candidate,
      parameters: { ...candidate.parameters },
    };
    const mutableRisk = {
      ...riskAssessment,
      dimensions: Object.fromEntries(Object.entries(riskAssessment.dimensions).map(
        ([key, value]) => [key, { ...value }],
      )) as typeof riskAssessment.dimensions,
      assessedAt: new Date(riskAssessment.assessedAt),
    };
    const mutableInput = {
      ...input,
      proposal: { candidate: mutableCandidate, riskAssessment: mutableRisk },
    };
    let releaseTransaction!: () => void;
    const gate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    withTransactionMock.mockImplementationOnce(async (
      fn: (client: PoolClient) => Promise<unknown>,
    ) => {
      await gate;
      return fn({ query: queryMock } as unknown as PoolClient);
    });

    const pending = gmailArchiveProposalRepository.persist(mutableInput);
    mutableCandidate.description = 'Mutated description';
    mutableCandidate.reasoning = 'Mutated reasoning';
    mutableCandidate.parameters['messageRefId'] = signalId;
    mutableRisk.reasoning = 'Mutated risk';
    mutableRisk.dimensions.reversibility.score = 1;
    mutableRisk.assessedAt.setTime(0);
    releaseTransaction();

    await expect(pending).resolves.toMatchObject({ ok: true, created: true });
    expect(store.candidate).toMatchObject({
      description: candidate.description,
      risk_assessment: {
        reasoning: riskAssessment.reasoning,
        assessedAt: riskAssessment.assessedAt.toISOString(),
      },
    });
    expect(store.candidate?.parameters['messageRefId']).toBe(messageRefId);
    expect(
      (store.candidate?.risk_assessment['dimensions'] as typeof riskAssessment.dimensions)
        .reversibility.score,
    ).toBe(riskAssessment.dimensions.reversibility.score);
  });

  it('returns the exact committed graph on replay without inserting another candidate or receipt', async () => {
    const first = await gmailArchiveProposalRepository.persist(input);
    expect(first).toMatchObject({ ok: true, created: true });
    appendMock.mockClear();
    queryMock.mockClear();

    const replayCandidate = {
      ...candidate,
      id: '77777777-7777-4777-8777-777777777777',
      decisionId: '88888888-8888-4888-8888-888888888888',
    };
    const replay = await gmailArchiveProposalRepository.persist({
      ...input,
      proposal: {
        candidate: replayCandidate,
        riskAssessment: {
          ...riskAssessment,
          actionId: replayCandidate.id,
          assessedAt: new Date('2026-09-11T12:05:00.000Z'),
        },
      },
    });

    expect(replay).toMatchObject({ ok: true, created: false });
    expect(appendMock).not.toHaveBeenCalled();
    expect(store.revisions).toHaveLength(3);
    expect(queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO candidate_actions'))).toHaveLength(0);
    if (first.ok && replay.ok) {
      expect(replay.proposal.candidate.id).toBe(first.proposal.candidate.id);
      expect(replay.proposal.approval.id).toBe(first.proposal.approval.id);
      expect(replay.proposal.decision.urgency).toBe('medium');
      expect(replay.proposal.approval.urgency).toBe('medium');
    }
  });

  it('rejects a semantically changed incoming risk assessment on replay', async () => {
    await gmailArchiveProposalRepository.persist(input);
    appendMock.mockClear();

    const changed = await gmailArchiveProposalRepository.persist({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: {
          ...riskAssessment,
          reasoning: `${riskAssessment.reasoning} changed`,
          assessedAt: new Date('2026-09-11T12:05:00.000Z'),
        },
      },
    });

    expect(changed).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('rejects changed builder candidate semantics on replay', async () => {
    await gmailArchiveProposalRepository.persist(input);
    appendMock.mockClear();

    const changed = await gmailArchiveProposalRepository.persist({
      ...input,
      proposal: {
        ...input.proposal,
        candidate: {
          ...candidate,
          description: `${candidate.description} after review`,
        },
      },
    });

    expect(changed).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(appendMock).not.toHaveBeenCalled();
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

  it('retries the whole transaction on 40001 with stable builder-owned and preallocated IDs', async () => {
    const serializationFailure = Object.assign(new Error('restart transaction'), { code: '40001' });
    const baseQueryImplementation = queryMock.getMockImplementation()!;
    const baseAppendImplementation = appendMock.getMockImplementation()!;
    const artifactIds = new Map<string, string[]>();
    queryMock.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      for (const table of [
        'candidate_actions', 'decision_outcomes', 'explanation_records',
        'pre_effect_barriers', 'approval_requests',
      ]) {
        if (sql.includes(`INSERT INTO ${table}`)) {
          const values = artifactIds.get(table) ?? [];
          values.push(String((args[1] as unknown[])[0]));
          artifactIds.set(table, values);
        }
      }
      return baseQueryImplementation(...args);
    });
    const appendIds: Array<[string, string]> = [];
    let failed = false;
    appendMock.mockImplementation(async (...args: unknown[]) => {
      const appendInput = args[2] as { receiptId: string; revisionId: string };
      appendIds.push([appendInput.receiptId, appendInput.revisionId]);
      if (!failed && appendIds.length === 3) {
        failed = true;
        throw serializationFailure;
      }
      return baseAppendImplementation(...args);
    });

    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    expect(withTransactionMock).toHaveBeenCalledTimes(2);
    expect(decisionInsertIds).toHaveLength(2);
    expect(new Set(decisionInsertIds)).toEqual(new Set([candidate.decisionId]));
    for (const [table, ids] of artifactIds) {
      expect(ids, table).toHaveLength(2);
      expect(new Set(ids).size, table).toBe(1);
    }
    expect(appendIds).toHaveLength(6);
    expect(new Set(appendIds.map(([id]) => id)).size).toBe(1);
    expect(appendIds.slice(0, 3).map(([, id]) => id)).toEqual(
      appendIds.slice(3).map(([, id]) => id),
    );
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
      proposal: {
        ...input.proposal,
        riskAssessment: {
          ...riskAssessment,
          dimensions: incompleteDimensions,
        } as typeof riskAssessment,
      },
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

  it('rejects an owner- and reference-bound legacy decision before proposal writes', async () => {
    legacyDecisionExists = true;

    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(decisionInsertIds).toEqual([]);
    expect(store).toEqual({ revisions: [] });
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
    ['null proposal', () => ({ ...input, proposal: null })],
    ['proposal extra key', () => ({ ...input, proposal: { ...input.proposal, extra: true } })],
    ['proposal symbol', () => ({
      ...input,
      proposal: Object.assign({ ...input.proposal }, { [Symbol('hidden')]: true }),
    })],
    ['proposal accessor', () => ({
      ...input,
      proposal: Object.defineProperty({ ...input.proposal }, 'candidate', {
        enumerable: true,
        get: () => candidate,
      }),
    })],
    ['revoked proposal', () => {
      const revoked = Proxy.revocable({ ...input.proposal }, {});
      revoked.revoke();
      return { ...input, proposal: revoked.proxy };
    }],
    ['candidate extra key', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, extra: true } },
    })],
    ['candidate accessor', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        candidate: Object.defineProperty({ ...candidate }, 'description', {
          enumerable: true,
          get: () => candidate.description,
        }),
      },
    })],
    ['candidate symbol', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        candidate: Object.assign({ ...candidate }, { [Symbol('hidden')]: true }),
      },
    })],
    ['candidate invalid decision ID', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, decisionId: 'not-a-uuid' } },
    })],
    ['candidate wrong action', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, actionType: 'delete_email' } },
    })],
    ['candidate wrong domain', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, domain: 'calendar' } },
    })],
    ['candidate blank description', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, description: '  ' } },
    })],
    ['candidate blank reasoning', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, reasoning: '\n' } },
    })],
    ['candidate nonzero cost', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, estimatedCostCents: 1 } },
    })],
    ['candidate unverified cost', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, costZeroIntent: 'unknown' } },
    })],
    ['candidate irreversible', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, reversible: false } },
    })],
    ['candidate wrong confidence', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, confidence: 'high' } },
    })],
    ['candidate trusted provenance', () => ({
      ...input,
      proposal: { ...input.proposal, candidate: { ...candidate, provenance: 'user_authored' } },
    })],
    ['command extra key', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        candidate: { ...candidate, parameters: { ...candidate.parameters, extra: true } },
      },
    })],
    ['command wrong message ref', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        candidate: { ...candidate, parameters: { ...candidate.parameters, messageRefId: signalId } },
      },
    })],
    ['command wrong operation', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        candidate: { ...candidate, parameters: { ...candidate.parameters, operation: 'restore' } },
      },
    })],
    ['null risk', () => ({ ...input, proposal: { ...input.proposal, riskAssessment: null } })],
    ['risk extra key', () => ({
      ...input,
      proposal: { ...input.proposal, riskAssessment: { ...riskAssessment, extra: true } },
    })],
    ['risk symbol', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: Object.assign({ ...riskAssessment }, { [Symbol('hidden')]: true }),
      },
    })],
    ['risk accessor', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: Object.defineProperty({ ...riskAssessment }, 'reasoning', {
          enumerable: true,
          get: () => riskAssessment.reasoning,
        }),
      },
    })],
    ['risk action mismatch', () => ({
      ...input,
      proposal: { ...input.proposal, riskAssessment: { ...riskAssessment, actionId: signalId } },
    })],
    ['risk blank reasoning', () => ({
      ...input,
      proposal: { ...input.proposal, riskAssessment: { ...riskAssessment, reasoning: ' ' } },
    })],
    ['dimensions symbol', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: {
          ...riskAssessment,
          dimensions: Object.assign({ ...riskAssessment.dimensions }, { [Symbol('hidden')]: true }),
        },
      },
    })],
    ['dimensions extra key', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: {
          ...riskAssessment,
          dimensions: { ...riskAssessment.dimensions, extra: riskAssessment.dimensions.reversibility },
        },
      },
    })],
    ['dimension accessor', () => ({
      ...input,
      proposal: {
        ...input.proposal,
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
      },
    })],
    ['dimension symbol', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: {
          ...riskAssessment,
          dimensions: {
            ...riskAssessment.dimensions,
            reversibility: Object.assign(
              { ...riskAssessment.dimensions.reversibility },
              { [Symbol('hidden')]: true },
            ),
          },
        },
      },
    })],
    ['bad date', () => ({
      ...input,
      proposal: {
        ...input.proposal,
        riskAssessment: { ...riskAssessment, assessedAt: new Date(Number.NaN) },
      },
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
