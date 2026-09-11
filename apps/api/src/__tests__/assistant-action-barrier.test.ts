import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfidenceLevel, RiskTier } from '@skytwin/shared-types';

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
  generateExplanation: vi.fn(),
  saveDecision: vi.fn(),
  createApproval: vi.fn(),
  findApproval: vi.fn(),
  appendAssistantMessage: vi.fn(),
  getAssistantThread: vi.fn(),
  emit: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  reserveBarrier: vi.fn(),
  markPrepared: vi.fn(),
  updatePreparedPolicy: vi.fn(),
  claimPrepared: vi.fn(),
  markTerminal: vi.fn(),
  twinService: {
    getRelevantPreferences: vi.fn(),
    getPatterns: vi.fn(),
    getTraits: vi.fn(),
    getTemporalProfile: vi.fn(),
  },
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn(function TwinService() { return mocks.twinService; }),
}));
vi.mock('@skytwin/decision-engine', () => ({
  DecisionMaker: vi.fn(function DecisionMaker() { return { evaluate: mocks.evaluate }; }),
}));
vi.mock('@skytwin/policy-engine', () => ({ PolicyEvaluator: vi.fn() }));
vi.mock('@skytwin/explanations', () => ({
  ExplanationGenerator: vi.fn(function ExplanationGenerator() {
    return { generate: mocks.generateExplanation };
  }),
}));
vi.mock('@skytwin/db', () => ({
  aiProviderRepository: {},
  approvalRepository: { create: mocks.createApproval, findByDecisionId: mocks.findApproval },
  assistantRepository: {
    appendMessage: mocks.appendAssistantMessage,
    getThread: mocks.getAssistantThread,
  },
  emailLabelRepository: { topLabelsForSender: vi.fn(), topLabelsForListId: vi.fn() },
  mcpServerRepository: {},
  mempalaceRepository: {},
  userRepository: { findById: vi.fn().mockResolvedValue({ trust_tier: 'suggest' }) },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: { saveDecision: mocks.saveDecision },
  explanationRepositoryAdapter: {},
  policyRepositoryAdapter: {},
  preEffectBarrierRepository: {
    reserve: mocks.reserveBarrier,
    markPrepared: mocks.markPrepared,
    updatePreparedPolicy: mocks.updatePreparedPolicy,
    claimPrepared: mocks.claimPrepared,
    markTerminal: mocks.markTerminal,
  },
}));
vi.mock('@skytwin/core', () => ({
  createLogger: () => ({ warn: mocks.logWarn, info: vi.fn(), error: mocks.logError, debug: vi.fn() }),
}));
vi.mock('../sse.js', () => ({ sseManager: { emit: mocks.emit } }));

import { appendKnownApprovalMessage, buildActionRouter } from '../routes/assistant.js';

const candidate = {
  id: '22222222-2222-2222-2222-222222222222',
  decisionId: '11111111-1111-1111-1111-111111111111',
  actionType: 'archive_email',
  description: 'Archive email',
  domain: 'email',
  parameters: {},
  estimatedCostCents: 0,
  costZeroIntent: 'verified_zero' as const,
  reversible: true,
  confidence: ConfidenceLevel.MODERATE,
  reasoning: 'The user requested it.',
  provenance: 'user_originated' as const,
};

describe('assistant action pre-effect explanation barrier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveDecision.mockImplementation(async (decision) => ({ decision, created: true }));
    mocks.twinService.getRelevantPreferences.mockResolvedValue([]);
    mocks.twinService.getPatterns.mockResolvedValue([]);
    mocks.twinService.getTraits.mockResolvedValue([]);
    mocks.twinService.getTemporalProfile.mockResolvedValue(undefined);
    mocks.evaluate.mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333',
      decisionId: candidate.decisionId,
      selectedAction: candidate,
      allCandidates: [candidate],
      riskAssessment: {
        actionId: candidate.id,
        overallTier: RiskTier.LOW,
        dimensions: {},
        reasoning: 'Low risk.',
        assessedAt: new Date(),
      },
      autoExecute: false,
      requiresApproval: true,
      reasoning: 'Approval required.',
      decidedAt: new Date(),
    });
    mocks.reserveBarrier.mockResolvedValue({
      row: { id: '55555555-5555-5555-5555-555555555555', status: 'reserved', effect_result: {} },
      created: true,
    });
    mocks.markPrepared.mockResolvedValue({ status: 'prepared' });
    mocks.claimPrepared.mockResolvedValue({ status: 'in_progress' });
    mocks.markTerminal.mockResolvedValue({ status: 'succeeded' });
    mocks.generateExplanation.mockResolvedValue({ id: '66666666-6666-6666-6666-666666666666' });
    mocks.createApproval.mockResolvedValue({
      row: { id: '44444444-4444-4444-4444-444444444444' },
      created: true,
    });
    mocks.findApproval.mockResolvedValue(null);
    mocks.appendAssistantMessage.mockResolvedValue({
      id: '77777777-7777-7777-7777-777777777777',
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Approval queued.',
      createdAt: new Date(),
      metadata: null,
    });
    mocks.getAssistantThread.mockResolvedValue(null);
  });

  it('creates no approval or SSE when explanation persistence fails', async () => {
    mocks.generateExplanation.mockRejectedValueOnce(new Error('audit store unavailable'));
    const router = buildActionRouter();

    await expect(router.route('aaaaaaaa-bbbb-cccc-dddd-000000000001', {
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Archive an email',
      rawData: { intent: 'archive_email' },
      triggerMessage: 'archive that email',
    }, { idempotencyKey: 'message-1' })).rejects.toThrow('audit store unavailable');

    expect(mocks.createApproval).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('uses the durable assistant message id to deduplicate retries', async () => {
    const router = buildActionRouter();
    await router.route('aaaaaaaa-bbbb-cccc-dddd-000000000001', {
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Archive an email',
      rawData: { intent: 'archive_email' },
      triggerMessage: 'archive that email',
    }, { idempotencyKey: 'message-1' });

    expect(mocks.saveDecision).toHaveBeenCalledWith(expect.objectContaining({
      rawData: expect.objectContaining({ signalId: 'assistant-message:message-1' }),
    }));
    expect(mocks.generateExplanation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createApproval.mock.invocationCallOrder[0]!,
    );
    expect(mocks.markPrepared).toHaveBeenCalledWith(expect.objectContaining({
      explanationId: '66666666-6666-6666-6666-666666666666',
    }));
  });

  it('preserves and announces a queued approval when barrier finalization fails', async () => {
    mocks.markTerminal.mockRejectedValueOnce(new Error('SECRET_MARKER barrier write unavailable'));
    const router = buildActionRouter();

    const result = await router.route('aaaaaaaa-bbbb-cccc-dddd-000000000001', {
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Archive an email',
      rawData: { intent: 'archive_email' },
      triggerMessage: 'archive that email',
    }, { idempotencyKey: 'message-reconcile' });

    expect(result).toMatchObject({
      kind: 'requires-approval',
      approvalRequestId: '44444444-4444-4444-4444-444444444444',
    });
    expect(result.kind).toBe('requires-approval');
    if (result.kind !== 'requires-approval') throw new Error('Expected queued approval outcome');
    expect(result.reasoning).toContain('approval is queued');
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('SECRET_MARKER');
  });

  it('reloads and announces an approval when create commits but its response is lost', async () => {
    mocks.createApproval.mockRejectedValueOnce(new Error('SECRET_MARKER response lost'));
    mocks.findApproval.mockResolvedValueOnce({
      id: '44444444-4444-4444-4444-444444444444',
      decision_id: candidate.decisionId,
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
    });
    const router = buildActionRouter();

    const result = await router.route('aaaaaaaa-bbbb-cccc-dddd-000000000001', {
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Archive an email',
      rawData: { intent: 'archive_email' },
      triggerMessage: 'archive that email',
    }, { idempotencyKey: 'message-create-response-lost' });

    expect(mocks.findApproval).toHaveBeenCalledWith(
      expect.any(String),
      'aaaaaaaa-bbbb-cccc-dddd-000000000001',
    );
    expect(result).toMatchObject({
      kind: 'requires-approval',
      approvalRequestId: '44444444-4444-4444-4444-444444444444',
    });
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(JSON.stringify([...mocks.logWarn.mock.calls, ...mocks.logError.mock.calls]))
      .not.toContain('SECRET_MARKER');
  });

  it('preserves the queued outcome when approval SSE delivery throws', async () => {
    mocks.emit.mockImplementationOnce(() => {
      throw new Error('SECRET_MARKER SSE transport failed');
    });
    const router = buildActionRouter();

    const result = await router.route('aaaaaaaa-bbbb-cccc-dddd-000000000001', {
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Archive an email',
      rawData: { intent: 'archive_email' },
      triggerMessage: 'archive that email',
    }, { idempotencyKey: 'message-sse-failure' });

    expect(result).toMatchObject({
      kind: 'requires-approval',
      approvalRequestId: '44444444-4444-4444-4444-444444444444',
    });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('SECRET_MARKER');
  });

  it('recovers a committed assistant approval bubble after append response loss', async () => {
    const persisted = {
      id: '77777777-7777-7777-7777-777777777777',
      threadId: 'thread-1',
      role: 'assistant' as const,
      content: 'Approval queued.',
      createdAt: new Date(),
      metadata: { intentRoute: { approvalRequestId: 'approval-1' } },
    };
    mocks.appendAssistantMessage.mockRejectedValueOnce(new Error('SECRET_MARKER append response lost'));
    mocks.getAssistantThread
      .mockResolvedValueOnce({ thread: { id: 'thread-1' }, messages: [] })
      .mockResolvedValueOnce({ thread: { id: 'thread-1' }, messages: [persisted] });

    await expect(appendKnownApprovalMessage(
      'user-1',
      'thread-1',
      'approval-1',
      'Approval queued.',
      { intentRoute: { approvalRequestId: 'approval-1' } },
      '11111111-1111-4111-8111-111111111111',
    )).resolves.toBe(persisted);
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('SECRET_MARKER');
  });

  it('returns an explicit reconciliation bubble when approval-message persistence is unknown', async () => {
    mocks.appendAssistantMessage.mockRejectedValueOnce(new Error('SECRET_MARKER append failed'));
    mocks.getAssistantThread.mockRejectedValueOnce(new Error('SECRET_MARKER read failed'));

    const result = await appendKnownApprovalMessage(
      'user-1',
      'thread-1',
      'approval-1',
      'Approval queued.',
      { intentRoute: { approvalRequestId: 'approval-1' } },
      '11111111-1111-4111-8111-111111111111',
    );

    expect(result.metadata).toMatchObject({
      persistence: {
        status: 'reconciliation_required',
        errorCode: 'assistant_message_persistence_unknown',
      },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('SECRET_MARKER');
  });

  it('reuses the approval bubble on a full request replay instead of appending twice', async () => {
    const persisted = {
      id: '77777777-7777-7777-7777-777777777777',
      threadId: 'thread-1',
      role: 'assistant' as const,
      content: 'Approval queued.',
      createdAt: new Date(),
      metadata: { intentRoute: { approvalRequestId: 'approval-1' } },
    };
    mocks.getAssistantThread.mockResolvedValue({
      thread: { id: 'thread-1' },
      messages: [persisted],
    });

    const first = await appendKnownApprovalMessage(
      'user-1', 'thread-1', 'approval-1', 'Approval queued.', persisted.metadata,
      '11111111-1111-4111-8111-111111111111',
    );
    const second = await appendKnownApprovalMessage(
      'user-1', 'thread-1', 'approval-1', 'Approval queued.', persisted.metadata,
      '11111111-1111-4111-8111-111111111111',
    );

    expect(first).toBe(persisted);
    expect(second).toBe(persisted);
    expect(mocks.appendAssistantMessage).not.toHaveBeenCalled();
  });
});
