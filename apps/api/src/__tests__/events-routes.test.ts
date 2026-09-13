import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { InvariantViolationError } from '@skytwin/execution-router';

const {
  mockInterpret,
  mockEvaluate,
  mockReevaluate,
  mockGenerate,
  mockExecutionRepository,
  mockGetExecutionRouter,
  mockSseManager,
  mockApprovalCreate,
  mockApprovalFindByDecisionId,
  mockSaveDecision,
  mockSaveCandidates,
  mockGetOutcome,
  mockSaveOutcome,
  mockGetProviders,
  mockCreateReceipts,
  mockGetIngestState,
  mockClaimExecution,
  mockIsExecutionDispatchable,
  mockMarkExecutionTerminal,
  mockMarkNonEffect,
  mockGetExplanation,
  mockEmitReceipt,
  mockLlmClient,
  mockGetOAuthToken,
  mockCurrentPolicyEvaluate,
  mockGetAllPolicies,
} = vi.hoisted(() => ({
  mockInterpret: vi.fn(),
  mockEvaluate: vi.fn(),
  mockReevaluate: vi.fn(),
  mockGenerate: vi.fn(),
  mockExecutionRepository: {
    createPlan: vi.fn(),
    createEvent: vi.fn(),
    updatePlanStatus: vi.fn(),
    createResult: vi.fn(),
    getByDecisionId: vi.fn(),
  },
  mockGetExecutionRouter: vi.fn(),
  mockSseManager: {
    emit: vi.fn(),
  },
  mockApprovalCreate: vi.fn(),
  mockApprovalFindByDecisionId: vi.fn(),
  mockSaveDecision: vi.fn(),
  mockSaveCandidates: vi.fn(),
  mockGetOutcome: vi.fn(),
  mockSaveOutcome: vi.fn(),
  mockGetProviders: vi.fn(),
  mockCreateReceipts: vi.fn(),
  mockGetIngestState: vi.fn(),
  mockClaimExecution: vi.fn(),
  mockIsExecutionDispatchable: vi.fn(),
  mockMarkExecutionTerminal: vi.fn(),
  mockMarkNonEffect: vi.fn(),
  mockGetExplanation: vi.fn(),
  mockEmitReceipt: vi.fn(),
  mockLlmClient: vi.fn(),
  mockGetOAuthToken: vi.fn(),
  mockCurrentPolicyEvaluate: vi.fn(),
  mockGetAllPolicies: vi.fn(),
}));

vi.mock('@skytwin/decision-engine', () => ({
  SituationInterpreter: vi.fn(function SituationInterpreter() {
    return { interpret: mockInterpret };
  }),
  DecisionMaker: vi.fn(function DecisionMaker() {
    return { evaluate: mockEvaluate, reevaluatePreparedCandidates: mockReevaluate };
  }),
  LlmSituationStrategy: vi.fn(),
  LlmCandidateGenerator: vi.fn(),
  FallbackSituationStrategy: vi.fn(),
  FallbackCandidateGenerator: vi.fn(),
  RuleBasedCandidateGenerator: vi.fn(),
  SenderAwareCandidateGenerator: vi.fn(),
  CompositeCandidateGenerator: vi.fn(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn(function TwinService() {
    return {
    getOrCreateProfile: vi.fn().mockResolvedValue({}),
    getRelevantPreferences: vi.fn().mockResolvedValue([]),
    getPatterns: vi.fn().mockResolvedValue([]),
    getTraits: vi.fn().mockResolvedValue([]),
    getTemporalProfile: vi.fn().mockResolvedValue({}),
    };
  }),
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn(function PolicyEvaluator() {
    return { evaluate: mockCurrentPolicyEvaluate };
  }),
}));

vi.mock('@skytwin/explanations', () => ({
  ExplanationGenerator: vi.fn(function ExplanationGenerator() {
    return { generate: mockGenerate };
  }),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: {
    create: mockApprovalCreate,
    findByDecisionId: mockApprovalFindByDecisionId,
  },
  oauthRepository: { getToken: mockGetOAuthToken },
  executionRepository: mockExecutionRepository,
  userRepository: { findById: vi.fn().mockResolvedValue({ id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', trust_tier: 'observer', ironclaw_channel: 'skytwin' }) },
  aiProviderRepository: { getEnabledForUser: mockGetProviders },
  inferenceReceiptRepository: {
    createManyForUser: mockCreateReceipts,
    getContinuationForDecision: mockGetIngestState,
    claimExecutionForDecision: mockClaimExecution,
    isExecutionDispatchableForDecision: mockIsExecutionDispatchable,
    markExecutionTerminalForDecision: mockMarkExecutionTerminal,
    markNonEffectForDecision: mockMarkNonEffect,
  },
  emailLabelRepository: {
    topLabelsForSender: vi.fn().mockResolvedValue([]),
    topLabelsForListId: vi.fn().mockResolvedValue([]),
  },
  mempalaceRepository: {
    getEpisodes: vi.fn().mockResolvedValue([]),
  },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: {
    saveDecision: mockSaveDecision,
    saveCandidates: mockSaveCandidates,
    saveOutcome: mockSaveOutcome,
    getOutcome: mockGetOutcome,
    // Auto-execute path looks up the persisted RiskAssessment by action
    // id when outcome.riskAssessment is absent. Echo the requested id
    // back as assessment.actionId so the execution-router's
    // actionId-match invariant cannot be silently bypassed in tests
    // (Copilot review on PR #417). Individual tests can override.
    getRiskAssessment: vi.fn().mockImplementation(async (actionId: string) => ({
      actionId,
      overallTier: 'low',
      dimensions: {
        reversibility: { tier: 'low', score: 0.2, reasoning: 'test' },
        financial_impact: { tier: 'low', score: 0.2, reasoning: 'test' },
        legal_sensitivity: { tier: 'low', score: 0.2, reasoning: 'test' },
        privacy_sensitivity: { tier: 'low', score: 0.2, reasoning: 'test' },
        relationship_sensitivity: { tier: 'low', score: 0.2, reasoning: 'test' },
        operational_risk: { tier: 'low', score: 0.2, reasoning: 'test' },
      },
      reasoning: 'test assessment',
      assessedAt: new Date(),
    })),
  },
  explanationRepositoryAdapter: { getByDecisionId: mockGetExplanation },
  policyRepositoryAdapter: { getAllPolicies: mockGetAllPolicies },
}));

vi.mock('@skytwin/llm-client', () => ({
  LlmClient: mockLlmClient,
  emitInferenceReceipt: mockEmitReceipt,
}));

vi.mock('../workflows/registry.js', () => ({
  WorkflowHandlerRegistry: vi.fn(function WorkflowHandlerRegistry() {
    return { register: vi.fn() };
  }),
}));

vi.mock('../workflows/calendar-conflict.js', () => ({ processCalendarConflict: vi.fn() }));
vi.mock('../workflows/subscription-renewal.js', () => ({ processSubscriptionRenewal: vi.fn() }));
vi.mock('../workflows/grocery-reorder.js', () => ({ processGroceryReorder: vi.fn() }));
vi.mock('../workflows/travel-decision.js', () => ({ processTravelDecision: vi.fn() }));

vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: mockGetExecutionRouter,
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

vi.mock('../sse.js', () => ({
  sseManager: mockSseManager,
}));

import { createEventsRouter } from '../routes/events.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/events', createEventsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function ingestState(
  effectState: 'non_effect' | 'ready' | 'running' | 'completed' | 'failed' | 'restored_non_replay',
  continuationKind: 'auto_execute' | 'approval' | 'non_effect' =
    effectState === 'ready' || effectState === 'running' || effectState === 'completed' || effectState === 'failed'
      ? 'auto_execute'
      : 'non_effect',
) {
  const selectedAction = continuationKind === 'non_effect' ? null : {
    id: 'action-1', decisionId: 'decision-1', actionType: 'create_calendar_event',
    description: 'Create calendar event', domain: 'calendar', parameters: {},
    reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
  };
  return {
    receiptCaptureComplete: true,
    receiptExplanationId: 'explanation-1',
    continuationKind,
    confirmationLevel: continuationKind === 'approval' ? 'dual' : null,
    effectState,
    sourceEffectState: null,
    sourceExecutionStatus: effectState === 'completed' || effectState === 'failed' ? effectState : null,
    sourceExecutionPlanId: effectState === 'completed' || effectState === 'failed' ? 'plan-prev' : null,
    continuation: {
      outcome: {
        id: 'outcome-1', decisionId: 'decision-1', selectedAction,
        allCandidates: selectedAction ? [selectedAction] : [], riskAssessment: null,
        autoExecute: continuationKind === 'auto_execute',
        requiresApproval: continuationKind === 'approval',
        reasoning: continuationKind === 'non_effect' ? 'No action needed' : 'Previous run',
      },
      explanation: {
        id: 'explanation-1', decisionId: 'decision-1', summary: 'Previous explanation',
        riskTier: 'low', overallConfidence: 0.9,
      },
    },
  };
}

async function request(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => {
        const json = await res.json().catch(() => null);
        server.close();
        resolve({ status: res.status, body: json });
      }).catch((error) => {
        server.close();
        reject(error);
      });
    });
  });
}

describe('Events API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInterpret.mockResolvedValue({
      id: 'decision-1',
      situationType: 'calendar_conflict',
      domain: 'calendar',
      urgency: 'medium',
      summary: 'Schedule meeting',
    });
    mockEvaluate.mockResolvedValue({
      id: 'outcome-1',
      decisionId: 'decision-1',
      autoExecute: true,
      requiresApproval: false,
      reasoning: 'Allowed by policy',
      selectedAction: {
        id: 'action-1',
        decisionId: 'decision-1',
        actionType: 'create_calendar_event',
        description: 'Create calendar event',
        domain: 'calendar',
        parameters: {},
        reversible: true,
        estimatedCostCents: 0,
        confidence: 'high',
        reasoning: 'User prefers this',
      },
      allCandidates: [],
    });
    mockGenerate.mockResolvedValue({
      id: 'explanation-1',
      decisionId: 'decision-1',
      riskTier: 'low',
      summary: 'Low risk',
      overallConfidence: 0.9,
    });
    mockExecutionRepository.createPlan.mockResolvedValue({ id: 'plan-1' });
    mockExecutionRepository.createEvent.mockResolvedValue({});
    mockExecutionRepository.updatePlanStatus.mockResolvedValue({});
    mockExecutionRepository.createResult.mockResolvedValue({});
    // Default: every signal is a first-time ingestion. The re-ingestion
    // tests override this to return `created: false`.
    mockSaveDecision.mockImplementation(async (d: unknown) => ({
      decision: d,
      created: true,
    }));
    mockSaveCandidates.mockResolvedValue([]);
    mockSaveOutcome.mockImplementation(async (o: unknown) => o);
    mockGetOutcome.mockResolvedValue(null);
    mockApprovalFindByDecisionId.mockResolvedValue(null);
    mockExecutionRepository.getByDecisionId.mockResolvedValue(null);
    mockGetProviders.mockResolvedValue([]);
    mockGetOAuthToken.mockResolvedValue(null);
    mockGetAllPolicies.mockResolvedValue([]);
    mockCurrentPolicyEvaluate.mockResolvedValue({
      allowed: true,
      requiresApproval: false,
      reason: 'Current policy allows automatic execution.',
    });
    mockCreateReceipts.mockImplementation(async (
      _userId: unknown,
      inputs: unknown[],
      completion: { continuation: unknown },
    ) => ({ receipts: inputs, continuation: completion.continuation }));
    mockGetIngestState.mockResolvedValue(null);
    mockClaimExecution.mockResolvedValue({ id: 'plan-1' });
    mockIsExecutionDispatchable.mockResolvedValue(true);
    mockMarkExecutionTerminal.mockResolvedValue(true);
    mockMarkNonEffect.mockResolvedValue(true);
    mockGetExplanation.mockResolvedValue(null);
    mockEmitReceipt.mockReturnValue({ exportVersion: 1, receipt: { id: 'receipt-1' } });
    mockLlmClient.mockImplementation(function MockLlmClient() {
      return { hasProviders: true };
    });
  });

  it('persists every collected inference receipt before creating an approval', async () => {
    mockGetProviders.mockResolvedValue([{ provider: 'openai', api_key: 'key', model: 'model', base_url: null }]);
    mockLlmClient.mockImplementation(function MockReceiptLlmClient(
      _providers: unknown,
      _userId: unknown,
      options: { onInferenceTrace: (trace: unknown) => void },
    ) {
      options.onInferenceTrace({
        id: 'receipt-1', reasoningMode: 'conventional_cloud', status: 'conventional',
        provider: 'openai', model: 'model', endpointIdentity: 'https://api.openai.com',
        request: Buffer.from('request'), response: Buffer.from('response'),
        cost: { basis: 'unknown' }, createdAt: '2026-09-10T00:00:00.000Z',
        verifierVersion: 'boundary-v1',
      });
      return { hasProviders: true };
    });
    mockGenerate.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      riskTier: 'low', summary: 'Low risk', overallConfidence: 0.9,
    });
    mockEvaluate.mockResolvedValue({
      autoExecute: false, requiresApproval: true, reasoning: 'Needs approval',
      selectedAction: {
        id: 'action-1', decisionId: 'decision-1', actionType: 'create_calendar_event',
        description: 'Create calendar event', domain: 'calendar', parameters: {},
        reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
      },
      allCandidates: [],
    });
    mockCreateReceipts.mockImplementationOnce(async (
      _userId: unknown,
      _inputs: unknown[],
      completion: { continuation: unknown },
    ) => ({ receipts: [{ id: 'receipt-1' }], continuation: completion.continuation }));
    mockApprovalCreate.mockResolvedValue({ row: { id: 'approval-1' }, created: true });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockEmitReceipt).toHaveBeenCalledWith(expect.objectContaining({ id: 'receipt-1' }), {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      decisionId: 'decision-1', explanationId: '44444444-4444-4444-8444-444444444444',
    }, expect.objectContaining({ keyId: expect.any(String) }));
    expect(mockCreateReceipts).toHaveBeenCalledTimes(1);
    expect(mockCreateReceipts).toHaveBeenCalledWith(
      'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      expect.any(Array),
      expect.objectContaining({ continuationKind: 'approval', confirmationLevel: 'single' }),
    );
    expect(mockCreateReceipts.mock.invocationCallOrder[0]).toBeLessThan(
      mockApprovalCreate.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['calendar', 'create_calendar_event'],
    ['email', 'draft_email'],
  ] as const)('keeps credentialed %s execution separate from captured authority', async (
    _domain,
    actionType,
  ) => {
    const action = {
      id: 'action-1', decisionId: 'decision-1', actionType,
      description: actionType === 'draft_email' ? 'Draft reply' : 'Create calendar event',
      domain: actionType === 'draft_email' ? 'email' : 'calendar',
      parameters: actionType === 'draft_email' ? { draftBody: 'Hello there' } : { title: 'Planning' },
      reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
    };
    const assessment = {
      actionId: action.id,
      overallTier: 'low',
      dimensions: {
        reversibility: { tier: 'low', score: 0.2, reasoning: 'test' },
        financial_impact: { tier: 'low', score: 0.2, reasoning: 'test' },
        legal_sensitivity: { tier: 'low', score: 0.2, reasoning: 'test' },
        privacy_sensitivity: { tier: 'low', score: 0.2, reasoning: 'test' },
        relationship_sensitivity: { tier: 'low', score: 0.2, reasoning: 'test' },
        operational_risk: { tier: 'low', score: 0.2, reasoning: 'test' },
      },
      reasoning: 'test assessment', assessedAt: new Date(),
    };
    const initialOutcome = {
      id: 'outcome-1', decisionId: 'decision-1', selectedAction: action,
      allCandidates: [action], riskAssessment: assessment, allRiskAssessments: [assessment],
      autoExecute: true, requiresApproval: false, reasoning: 'Allowed by policy',
      policyVerdicts: { [action.id]: 'allowed' }, decidedAt: new Date(),
    };
    mockEvaluate.mockResolvedValue(initialOutcome);
    mockReevaluate.mockImplementation(async (_context, candidates: typeof initialOutcome.allCandidates) => {
      const selectedAction = candidates[0]!;
      const reevaluatedRisk = { ...assessment, actionId: selectedAction.id };
      return {
        ...initialOutcome,
        selectedAction,
        allCandidates: candidates,
        riskAssessment: reevaluatedRisk,
        allRiskAssessments: [reevaluatedRisk],
        policyVerdicts: { [selectedAction.id]: 'allowed' },
      };
    });
    mockGetOAuthToken.mockResolvedValue({ access_token: 'secret-token' });

    let captured: { outcome: typeof initialOutcome; explanation: unknown } | undefined;
    mockCreateReceipts.mockImplementation(async (
      _userId: unknown,
      inputs: unknown[],
      completion: { continuation: typeof captured },
    ) => {
      captured = structuredClone(completion.continuation!);
      return { receipts: inputs, continuation: structuredClone(completion.continuation!) };
    });
    let claimed: { outcome: typeof initialOutcome; explanation: unknown } | undefined;
    mockClaimExecution.mockImplementation(async (
      _userId: unknown,
      _decisionId: unknown,
      continuation: typeof claimed,
    ) => {
      claimed = structuredClone(continuation!);
      return { id: 'plan-1' };
    });
    let executed: Record<string, unknown> | undefined;
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(async function* (candidate: Record<string, unknown>) {
        executed = structuredClone(candidate);
        yield { planId: 'plan-1', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
      }),
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    const capturedAction = captured!.outcome.selectedAction!;
    const claimedAction = claimed!.outcome.selectedAction!;
    expect(capturedAction.parameters).not.toHaveProperty('accessToken');
    expect(capturedAction.parameters).not.toHaveProperty('executionPlanId');
    expect(claimedAction).toEqual(capturedAction);
    expect((executed!['parameters'] as Record<string, unknown>)).toMatchObject({
      accessToken: 'secret-token', executionPlanId: 'plan-1',
    });
    expect(mockIsExecutionDispatchable.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetOAuthToken.mock.invocationCallOrder[0]!,
    );
    if (actionType === 'draft_email') {
      expect(mockReevaluate).toHaveBeenCalledTimes(1);
      expect(capturedAction.actionType).toBe('send_reply');
      expect(capturedAction.reversible).toBe(false);
      expect(capturedAction.description).toBe('Send reply');
      expect(capturedAction.parameters['draftBody']).not.toBe('Hello there');
    } else {
      expect(mockReevaluate).not.toHaveBeenCalled();
      expect(capturedAction.actionType).toBe('create_calendar_event');
    }
  });

  it('stops before approval when the atomic receipt finalization fails', async () => {
    mockGetProviders.mockResolvedValue([{ provider: 'openai', api_key: 'key', model: 'model', base_url: null }]);
    mockCreateReceipts.mockResolvedValue(null);
    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });
    expect(res.status).toBe(500);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
    expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
  });

  it('resumes from the persisted continuation after a capture commit response is lost', async () => {
    let saveCount = 0;
    mockSaveDecision.mockImplementation(async (d: unknown) => ({
      decision: d,
      created: saveCount++ === 0,
    }));
    mockEvaluate.mockResolvedValue({
      id: 'outcome-1', decisionId: 'decision-1', autoExecute: false, requiresApproval: true,
      reasoning: 'Needs approval', selectedAction: {
        id: 'action-1', decisionId: 'decision-1', actionType: 'create_calendar_event',
        description: 'Create calendar event', domain: 'calendar', parameters: {},
        reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
      }, allCandidates: [], riskAssessment: null,
    });
    mockCreateReceipts.mockRejectedValueOnce(new Error('commit response lost'));
    mockGetIngestState.mockResolvedValue(ingestState('non_effect', 'approval'));
    mockApprovalCreate.mockResolvedValue({ row: { id: 'approval-1', status: 'pending' }, created: true });
    const app = buildApp();
    const body = {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    };

    expect((await request(app, 'POST', '/api/events/ingest', body)).status).toBe(500);
    const retry = await request(app, 'POST', '/api/events/ingest', body);

    expect(retry.status).toBe(200);
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockCreateReceipts).toHaveBeenCalledTimes(1);
    expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
  });

  it('allows only the finalized continuation to proceed when concurrent routes evaluate distinct outcomes', async () => {
    let saveCount = 0;
    mockSaveDecision.mockImplementation(async (decision: unknown) => ({
      decision,
      created: saveCount++ === 0,
    }));
    const outcome = (suffix: string) => ({
      id: `outcome-${suffix}`,
      decisionId: 'decision-1',
      autoExecute: false,
      requiresApproval: true,
      reasoning: `Needs approval ${suffix}`,
      selectedAction: {
        id: `action-${suffix}`, decisionId: 'decision-1', actionType: 'create_calendar_event',
        description: `Create calendar event ${suffix}`, domain: 'calendar', parameters: {},
        reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
      },
      allCandidates: [],
      riskAssessment: null,
    });
    mockEvaluate
      .mockResolvedValueOnce(outcome('first'))
      .mockResolvedValueOnce(outcome('second'));
    mockGenerate
      .mockResolvedValueOnce({
        id: 'explanation-first', decisionId: 'decision-1', summary: 'First explanation',
        riskTier: 'low', overallConfidence: 'high',
      })
      .mockResolvedValueOnce({
        id: 'explanation-second', decisionId: 'decision-1', summary: 'Second explanation',
        riskTier: 'low', overallConfidence: 'high',
      });
    let releaseFirstCapture!: () => void;
    let signalFirstCapture!: () => void;
    const firstCaptureStarted = new Promise<void>((resolve) => { signalFirstCapture = resolve; });
    const secondCaptureStarted = new Promise<void>((resolve) => { releaseFirstCapture = resolve; });
    let captureCount = 0;
    mockCreateReceipts.mockImplementation(async (
      _userId: unknown,
      inputs: unknown[],
      completion: { continuation: unknown },
    ) => {
      if (captureCount++ === 0) {
        signalFirstCapture();
        await secondCaptureStarted;
        return { receipts: inputs, continuation: completion.continuation };
      }
      releaseFirstCapture();
      return null;
    });
    mockApprovalCreate.mockResolvedValue({ row: { id: 'approval-first' }, created: true });
    const app = buildApp();
    const body = {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    };

    const firstRequest = request(app, 'POST', '/api/events/ingest', body);
    await firstCaptureStarted;
    const secondRequest = request(app, 'POST', '/api/events/ingest', body);
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(500);
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
    expect(mockCreateReceipts.mock.calls.map((call) =>
      (call[2] as { continuation: { outcome: { reasoning: string } } }).continuation.outcome.reasoning,
    )).toEqual(['Needs approval first', 'Needs approval second']);
    expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
    expect(mockApprovalCreate).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'Needs approval first',
    }));
  });

  // ---------------------------------------------------------------------
  // awareness disposition gate (#601)
  // ---------------------------------------------------------------------
  describe('awareness disposition gate', () => {
    const prevFlag = process.env['AWARENESS_DISPOSITION_GATE'];
    afterEach(() => {
      if (prevFlag === undefined) delete process.env['AWARENESS_DISPOSITION_GATE'];
      else process.env['AWARENESS_DISPOSITION_GATE'] = prevFlag;
    });

    function setupNewsletter() {
      mockInterpret.mockResolvedValue({
        id: 'decision-1',
        situationType: 'email_triage',
        domain: 'email',
        urgency: 'low',
        summary: 'Newsletter from Acme',
        rawData: { authoringTier: 'inbox_newsletter' },
      });
      mockEvaluate.mockResolvedValue({
        autoExecute: false,
        requiresApproval: true,
        reasoning: 'observer tier forces approval',
        selectedAction: {
          id: 'action-1',
          decisionId: 'decision-1',
          actionType: 'archive_email',
          description: 'Archive this email',
          domain: 'email',
          parameters: {},
          reversible: true,
          estimatedCostCents: 0,
          confidence: 'low',
          reasoning: 'low-risk',
        },
        allCandidates: [],
      });
    }

    it('suppresses the approval row and flips requires_approval=false when the flag is on', async () => {
      process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
      setupNewsletter();

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'newsletter',
      });

      expect(res.status).toBe(200);
      // No approval row, no approval:new SSE.
      expect(mockApprovalCreate).not.toHaveBeenCalled();
      expect(mockSseManager.emit).not.toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'approval:new',
        expect.anything(),
      );
      // Outcome re-saved with requires_approval flipped to false (digest FYI).
      expect(mockSaveOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ requiresApproval: false }),
      );
      expect((res.body as { approval: unknown }).approval).toBeNull();
    });

    it('still creates the approval row when the flag is off (Phase 0 no-op)', async () => {
      delete process.env['AWARENESS_DISPOSITION_GATE'];
      setupNewsletter();
      mockApprovalCreate.mockResolvedValue({ row: { id: 'ar-1', status: 'pending' }, created: true });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'newsletter',
      });

      expect(res.status).toBe(200);
      expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
      // The gate didn't fire — no requires_approval flip.
      expect(mockSaveOutcome).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // #372: the approval serializer must round-trip costZeroIntent + provenance
  // ---------------------------------------------------------------------
  describe('approval payload round-trips the safety flags', () => {
    it('persists costZeroIntent and provenance so they are not lost on approve', async () => {
      mockEvaluate.mockResolvedValue({
        autoExecute: false,
        requiresApproval: true,
        reasoning: 'Requires approval',
        selectedAction: {
          id: 'action-1',
          decisionId: 'decision-1',
          actionType: 'send_email',
          description: 'Send',
          domain: 'email',
          parameters: {},
          reversible: false,
          estimatedCostCents: 0,
          // An unverified zero cost — must NOT degrade to verified_zero on reload.
          costZeroIntent: 'unknown',
          provenance: 'untrusted_external',
          confidence: 'medium',
          reasoning: 'r',
        },
        allCandidates: [],
      });
      mockApprovalCreate.mockResolvedValue({ row: { id: 'ar-1', status: 'pending' }, created: true });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'test',
        type: 'email_received',
      });

      expect(res.status).toBe(200);
      expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
      const payload = mockApprovalCreate.mock.calls[0]?.[0] as {
        candidateAction: { costZeroIntent?: string; provenance?: string };
      };
      expect(payload.candidateAction.costZeroIntent).toBe('unknown');
      expect(payload.candidateAction.provenance).toBe('untrusted_external');
    });
  });

  // ---------------------------------------------------------------------
  // approval:new SSE gating (re-ingestion suppression)
  // ---------------------------------------------------------------------
  //
  // The unique index on approval_requests(decision_id) (migration 046)
  // plus ON CONFLICT DO NOTHING in approvalRepository.create make a
  // re-ingested signal a DB-level no-op — no duplicate row. But the
  // route used to emit `approval:new` on every create() return, including
  // the ON-CONFLICT path, so a duplicate ingestion re-flashed the
  // dashboard badge and re-played the toast for an approval the user had
  // already seen (or already resolved). The repository now signals
  // newly-inserted vs returned-from-conflict via `{ row, created }`, and
  // the route only emits when `created` is true.
  describe('approval:new SSE emission gating', () => {
    const approvalRow = {
      id: 'ar-1',
      user_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      decision_id: 'decision-1',
      status: 'pending',
    };

    function setupApprovalFlow() {
      mockEvaluate.mockResolvedValue({
        autoExecute: false,
        requiresApproval: true,
        reasoning: 'Requires approval (high cost)',
        selectedAction: {
          id: 'action-1',
          decisionId: 'decision-1',
          actionType: 'send_email',
          description: 'Send a draft email',
          domain: 'email',
          parameters: {},
          reversible: false,
          estimatedCostCents: 0,
          confidence: 'medium',
          reasoning: 'User pattern matches',
        },
        allCandidates: [],
      });
    }

    it('emits approval:new when create reports created=true (first-time approval)', async () => {
      setupApprovalFlow();
      mockApprovalCreate.mockResolvedValue({ row: approvalRow, created: true });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'test',
        type: 'email_received',
      });

      expect(res.status).toBe(200);
      expect(mockSseManager.emit).toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'approval:new',
        expect.objectContaining({ id: 'ar-1', decisionId: 'decision-1' }),
      );
    });

    it('does NOT emit approval:new when create reports created=false (re-ingestion)', async () => {
      // Regression: the route used to emit on every create() return,
      // including ON CONFLICT DO NOTHING. A re-ingested signal would
      // re-flash the badge for an approval the user has already seen.
      setupApprovalFlow();
      mockApprovalCreate.mockResolvedValue({ row: approvalRow, created: false });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'test',
        type: 'email_received',
      });

      expect(res.status).toBe(200);
      // The route response still surfaces the (existing) approval so the
      // API caller's bookkeeping is consistent — only the SSE emit is
      // suppressed.
      const body = res.body as { approval: { id: string; status: string } | null };
      expect(body.approval).toEqual({ id: 'ar-1', status: 'pending' });
      // No approval:new emission.
      expect(mockSseManager.emit).not.toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'approval:new',
        expect.anything(),
      );
    });
  });

  it('emits decision:blocked-by-policy when no action was selected (Safety Invariant #1)', async () => {
    mockEvaluate.mockResolvedValue({
      autoExecute: false,
      requiresApproval: false,
      reasoning: 'All candidates blocked by policy "No travel auto-bookings".',
      selectedAction: null,
      allCandidates: [],
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'travel_decision',
    });

    expect(res.status).toBe(200);
    expect(mockSseManager.emit).toHaveBeenCalledWith(
      'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      'decision:blocked-by-policy',
      expect.objectContaining({
        decisionId: 'decision-1',
        reason: expect.stringContaining('blocked by policy'),
      }),
    );
    // Must not have emitted execution events
    expect(mockSseManager.emit).not.toHaveBeenCalledWith(
      'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      'decision:executed',
      expect.anything(),
    );
    expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Re-ingestion pipeline short-circuit
  // ---------------------------------------------------------------------
  //
  // When decisionRepository.create reports `created: false` AND a previous
  // decision_outcome row is recoverable, the route short-circuits the rest
  // of the pipeline. Without this, a re-ingested signal would stack new
  // candidate_actions rows, overwrite the prior decision_outcomes row via
  // its ON CONFLICT (decision_id) DO UPDATE, and on the auto-execute path
  // would run the action a SECOND time (real send-the-email-twice bug for
  // users at trust tiers that auto-execute).
  describe('re-ingestion pipeline short-circuit', () => {
    it('reruns an otherwise persisted decision when receipt finalization is incomplete', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1', selectedAction: null, autoExecute: false,
        requiresApproval: false, reasoning: 'Previous partial run',
      });
      mockGetIngestState.mockResolvedValue(null);
      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
      });
      expect(res.status).toBe(200);
      expect(mockEvaluate).toHaveBeenCalled();
      expect(mockCreateReceipts).toHaveBeenCalled();
    });

    it('resumes approval creation after committed receipt capture without repeating inference', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1', selectedAction: {
          id: 'action-1', decisionId: 'decision-1', actionType: 'label_email',
          description: 'Label', parameters: {}, reversible: true,
        },
        autoExecute: false, requiresApproval: true, reasoning: 'Previous partial run',
        allCandidates: [],
      });
      mockApprovalFindByDecisionId.mockResolvedValue(null);
      mockGetIngestState.mockResolvedValue(ingestState('non_effect', 'approval'));
      mockGetExplanation.mockResolvedValue({
        id: 'explanation-1', summary: 'Previous explanation', riskTier: 'low', overallConfidence: 0.9,
      });
      mockApprovalCreate.mockResolvedValue({ row: { id: 'approval-1', status: 'pending' }, created: true });
      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
      });
      expect(res.status).toBe(200);
      expect(mockEvaluate).not.toHaveBeenCalled();
      expect(mockCreateReceipts).not.toHaveBeenCalled();
      expect(mockGetOutcome).not.toHaveBeenCalled();
      expect(mockGetExplanation).not.toHaveBeenCalled();
      expect(mockApprovalCreate).toHaveBeenCalledWith(expect.objectContaining({
        decisionId: 'decision-1', confirmationLevel: 'dual',
      }));
    });

    it('skips evaluate / saveCandidates / approvalCreate when a previous outcome is recoverable', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({
        decision: d,
        created: false,
      }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1',
        selectedAction: {
          actionType: 'label_email',
          description: 'Apply label',
        },
        autoExecute: false,
        requiresApproval: true,
        reasoning: 'Previous run — requires approval',
      });
      mockApprovalFindByDecisionId.mockResolvedValue({
        id: 'ar-existing',
        status: 'pending',
      });
      mockGetIngestState.mockResolvedValue(ingestState('non_effect', 'approval'));

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'email',
      });

      expect(res.status).toBe(200);
      const body = res.body as {
        reIngested: boolean;
        approval: { id: string; status: string } | null;
        outcome: { requiresApproval: boolean };
      };
      expect(body.reIngested).toBe(true);
      expect(body.approval).toEqual({ id: 'ar-existing', status: 'pending' });
      expect(body.outcome.requiresApproval).toBe(true);

      // The downstream pipeline must not have run.
      expect(mockEvaluate).not.toHaveBeenCalled();
      expect(mockSaveCandidates).not.toHaveBeenCalled();
      expect(mockApprovalCreate).not.toHaveBeenCalled();
      expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
      // No SSE emits — neither approval:new nor decision:blocked-by-policy
      // — because the user already saw whatever the first ingest emitted.
      expect(mockSseManager.emit).not.toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'approval:new',
        expect.anything(),
      );
      expect(mockSseManager.emit).not.toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'decision:blocked-by-policy',
        expect.anything(),
      );
    });

    it('resumes committed informational work without repeating inference or receipt capture', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1', selectedAction: null, autoExecute: false,
        requiresApproval: false, reasoning: 'No action needed', allCandidates: [],
      });
      mockGetExplanation.mockResolvedValue({
        id: 'explanation-1', summary: 'No action needed', riskTier: 'low', overallConfidence: 0.9,
      });
      mockGetIngestState.mockResolvedValue(ingestState('non_effect'));

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'travel_decision',
      });

      expect(res.status).toBe(200);
      expect(mockEvaluate).not.toHaveBeenCalled();
      expect(mockCreateReceipts).not.toHaveBeenCalled();
      expect(mockSseManager.emit).toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'decision:blocked-by-policy',
        expect.objectContaining({ decisionId: 'decision-1' }),
      );
    });

    it('short-circuits an auto-executed re-ingest without re-running the action when a terminal execution_result exists', async () => {
      // The high-impact case the PR exists to fix: a previously-auto-
      // executed signal must NOT execute its action a second time.
      mockSaveDecision.mockImplementation(async (d: unknown) => ({
        decision: d,
        created: false,
      }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1',
        selectedAction: { actionType: 'send_email', description: 'Send draft' },
        autoExecute: true,
        requiresApproval: false,
        reasoning: 'Auto-executed on first ingest',
      });
      mockExecutionRepository.getByDecisionId.mockResolvedValue({
        plan: { id: 'plan-prev', decision_id: 'decision-1', status: 'completed' },
        result: { plan_id: 'plan-prev', success: true },
      });
      mockGetIngestState.mockResolvedValue(ingestState('completed'));

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'email',
      });

      expect(res.status).toBe(200);
      const body = res.body as {
        reIngested: boolean;
        execution: { status: string; planId: string } | null;
      };
      expect(body.reIngested).toBe(true);
      expect(body.execution).toEqual({ status: 'completed', planId: 'plan-prev' });

      // The action MUST NOT have run a second time.
      expect(mockEvaluate).not.toHaveBeenCalled();
      expect(mockSaveCandidates).not.toHaveBeenCalled();
      expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
      expect(mockSseManager.emit).not.toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        'decision:executed',
        expect.anything(),
      );
    });

    it('suppresses replay and terminal truth while the guard remains running', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({
        decision: d,
        created: false,
      }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1',
        selectedAction: { actionType: 'send_email', description: 'Send draft' },
        autoExecute: true,
        requiresApproval: false,
        reasoning: 'Auto-executed on first ingest',
      });
      // Plan was created, but no result row yet — the first attempt
      // didn't finish.
      mockExecutionRepository.getByDecisionId.mockResolvedValue({
        plan: { id: 'plan-prev', decision_id: 'decision-1', status: 'running' },
        result: { plan_id: 'plan-prev', success: true },
      });
      mockGetIngestState.mockResolvedValue(ingestState('running'));

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'email',
      });

      expect(res.status).toBe(200);
      const body = res.body as {
        reIngested?: boolean;
        replaySuppressed?: boolean;
        execution?: { status: string };
      };
      expect(body.reIngested).toBe(true);
      expect(body.replaySuppressed).toBe(true);
      expect(body.execution?.status).toBe('ambiguous');
      expect(mockEvaluate).not.toHaveBeenCalled();
      expect(mockExecutionRepository.getByDecisionId).not.toHaveBeenCalled();
      expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
    });

    it('resumes a committed ready execution with one claim and no repeated inference', async () => {
      async function* completedStream() {
        yield { planId: 'plan-1', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
      }
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1',
        selectedAction: {
          id: 'action-1', decisionId: 'decision-1', actionType: 'create_calendar_event',
          description: 'Create calendar event', domain: 'calendar', parameters: {},
          reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
        },
        autoExecute: true, requiresApproval: false, reasoning: 'Previous ready run', allCandidates: [],
      });
      mockGetExplanation.mockResolvedValue({
        id: 'explanation-1', summary: 'Previous explanation', riskTier: 'low', overallConfidence: 0.9,
      });
      mockGetIngestState.mockResolvedValue(ingestState('ready'));
      mockGetExecutionRouter.mockResolvedValue({
        executeWithRoutingStreaming: vi.fn(() => completedStream()),
      });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'gmail', type: 'email',
      });

      expect(res.status).toBe(200);
      expect(mockEvaluate).not.toHaveBeenCalled();
      expect(mockCreateReceipts).not.toHaveBeenCalled();
      expect(mockClaimExecution).toHaveBeenCalledTimes(1);
      expect(mockClaimExecution.mock.invocationCallOrder[0]).toBeLessThan(
        mockGetExecutionRouter.mock.invocationCallOrder[0]!,
      );
      expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
      expect(mockGetExecutionRouter).toHaveBeenCalledTimes(1);
      expect(mockMarkExecutionTerminal).toHaveBeenCalledWith(
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'decision-1', 'completed', 'plan-1',
      );
    });

    it('does not claim recovered ready work after a user or operator pause', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1',
        selectedAction: {
          id: 'action-1', decisionId: 'decision-1', actionType: 'create_calendar_event',
          description: 'Create calendar event', domain: 'calendar', parameters: {},
          reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
        },
        autoExecute: true, requiresApproval: false, reasoning: 'Previous ready run', allCandidates: [],
      });
      mockGetExplanation.mockResolvedValue({
        id: 'explanation-1', summary: 'Previous explanation', riskTier: 'low', overallConfidence: 0.9,
      });
      mockGetIngestState.mockResolvedValue(ingestState('ready'));
      mockCurrentPolicyEvaluate.mockResolvedValueOnce({
        allowed: false, requiresApproval: true, reason: 'Auto-execution paused by user.',
      });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'gmail', type: 'email',
      });

      expect(res.status).toBe(200);
      expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
      expect(mockClaimExecution).not.toHaveBeenCalled();
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
    });

    it('fences a policy change after recovered work is claimed but before dispatch', async () => {
      const stream = vi.fn(async function* () {
        yield { planId: 'plan-1', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
      });
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1',
        selectedAction: {
          id: 'action-1', decisionId: 'decision-1', actionType: 'create_calendar_event',
          description: 'Create calendar event', domain: 'calendar', parameters: {},
          reversible: true, estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
        },
        autoExecute: true, requiresApproval: false, reasoning: 'Previous ready run', allCandidates: [],
      });
      mockGetExplanation.mockResolvedValue({
        id: 'explanation-1', summary: 'Previous explanation', riskTier: 'low', overallConfidence: 0.9,
      });
      mockGetIngestState.mockResolvedValue(ingestState('ready'));
      mockGetExecutionRouter.mockResolvedValue({ executeWithRoutingStreaming: stream });
      mockCurrentPolicyEvaluate
        .mockResolvedValueOnce({ allowed: true, requiresApproval: false, reason: 'Allowed at claim.' })
        .mockResolvedValueOnce({ allowed: false, requiresApproval: true, reason: 'Operator paused.' });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'gmail', type: 'email',
      });

      expect(res.status).toBe(200);
      expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
      expect(mockClaimExecution).toHaveBeenCalledOnce();
      expect(mockIsExecutionDispatchable).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(mockMarkExecutionTerminal).not.toHaveBeenCalled();
    });

    it('never resumes a ready execution after a fail-closed approval exists', async () => {
      mockSaveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: false }));
      mockGetOutcome.mockResolvedValue({
        decisionId: 'decision-1', selectedAction: {
          id: 'action-1', actionType: 'create_calendar_event', description: 'Create event',
        },
        autoExecute: true, requiresApproval: false, reasoning: 'Originally automatic',
      });
      mockApprovalFindByDecisionId.mockResolvedValue({ id: 'approval-1', status: 'pending' });
      mockGetExplanation.mockResolvedValue({
        id: 'explanation-1', summary: 'Previous explanation', riskTier: 'low', overallConfidence: 0.9,
      });
      mockGetIngestState.mockResolvedValue(ingestState('ready'));

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
      });

      expect(res.status).toBe(200);
      expect(mockClaimExecution).not.toHaveBeenCalled();
      expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
    });

    it('falls through to the normal pipeline when no previous outcome is recoverable (first attempt crashed before saving)', async () => {
      // `created: false` means the decision row exists, but if the prior
      // attempt died between saveDecision and saveOutcome the recovery
      // can't reconstruct the result — running the pipeline to completion
      // is the correct fallback so the work eventually finishes.
      mockSaveDecision.mockImplementation(async (d: unknown) => ({
        decision: d,
        created: false,
      }));
      mockGetOutcome.mockResolvedValue(null);

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'email',
      });

      expect(res.status).toBe(200);
      const body = res.body as { reIngested?: boolean };
      // The pipeline ran — no `reIngested` marker.
      expect(body.reIngested).toBeUndefined();
      // mockEvaluate is what runs in the normal pipeline; it must have
      // fired since we fell through.
      expect(mockEvaluate).toHaveBeenCalled();
    });
  });

  it('does not dispatch when the ready execution claim is ambiguous or already consumed', async () => {
    mockClaimExecution.mockResolvedValue(null);
    mockGetIngestState.mockResolvedValue(ingestState('running'));

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
    expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
    expect(mockGetExecutionRouter).not.toHaveBeenCalled();
  });

  it('does not dispatch when an execution claim commits but its response is lost', async () => {
    mockClaimExecution.mockRejectedValue(new Error('claim response lost'));
    mockGetIngestState.mockResolvedValue(ingestState('running'));

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
    expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
    expect(mockGetExecutionRouter).not.toHaveBeenCalled();
  });

  it.each([
    ['false response', false],
    ['throw after commit', new Error('terminal response lost')],
  ] as const)('does not surface terminal truth after a %s', async (_label, terminalResponse) => {
    async function* completedStream() {
      yield { planId: 'plan-1', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
    }
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(() => completedStream()),
    });
    if (terminalResponse instanceof Error) {
      mockMarkExecutionTerminal.mockRejectedValue(terminalResponse);
    } else {
      mockMarkExecutionTerminal.mockResolvedValue(terminalResponse);
    }

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createResult).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1', success: true,
    }));
    expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
    expect(mockSseManager.emit).not.toHaveBeenCalledWith(
      expect.anything(), 'decision:executed', expect.anything(),
    );
  });

  it('re-emits decision:blocked-by-policy when re-ingestion falls through (previous outcome missing)', async () => {
    // After PR B's short-circuit, a re-ingestion only silences
    // `decision:blocked-by-policy` when the prior outcome row is
    // recoverable (the suppression test in the
    // "re-ingestion pipeline short-circuit" block covers that). When
    // the prior attempt crashed before saving its outcome,
    // getOutcome returns null and the route falls through to the
    // normal pipeline — at which point the SSE MUST fire because the
    // user never saw it on the failed first attempt.
    mockEvaluate.mockResolvedValue({
      autoExecute: false,
      requiresApproval: false,
      reasoning: 'All candidates blocked by policy "No travel auto-bookings".',
      selectedAction: null,
      allCandidates: [],
    });
    mockSaveDecision.mockImplementation(async (d: unknown) => ({
      decision: d,
      created: false,
    }));
    mockGetOutcome.mockResolvedValue(null);

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'travel_decision',
    });

    expect(res.status).toBe(200);
    expect(mockSseManager.emit).toHaveBeenCalledWith(
      'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      'decision:blocked-by-policy',
      expect.objectContaining({ decisionId: 'decision-1' }),
    );
  });

  it('leaves execution ambiguous when the stream throws without a typed no-effect result', async () => {
    async function* throwingStream() {
      throw new Error('No adapter can handle action type "create_calendar_event"');
    }
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(() => throwingStream()),
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createEvent).not.toHaveBeenCalled();
    expect(mockExecutionRepository.updatePlanStatus).not.toHaveBeenCalled();
    expect(mockExecutionRepository.createResult).not.toHaveBeenCalled();
    expect(mockMarkExecutionTerminal).not.toHaveBeenCalled();
    expect(mockClaimExecution.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetExecutionRouter.mock.invocationCallOrder[0]!,
    );
    expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
    const body = res.body as { execution: { status: string; planId: string } };
    expect(body.execution).toMatchObject({ status: 'ambiguous', planId: 'plan-1' });
  });

  it('redacts echoed credentials and arbitrary adapter bodies from event, result, and SSE evidence', async () => {
    const secret = 'rotated-event-token';
    mockGetOAuthToken.mockResolvedValueOnce({ access_token: secret });
    const stream = vi.fn(async function* (candidate: Record<string, unknown>) {
      expect((candidate['parameters'] as Record<string, unknown>)['accessToken']).toBe(secret);
      yield {
        planId: 'plan-1',
        eventType: 'plan_completed',
        timestamp: new Date(),
        payload: {
          status: 'completed',
          accessToken: secret,
          headers: { authorization: `Bearer ${secret}` },
          responseUrl: `https://adapter.test/result?access_token=${secret}`,
          body: { echoed: secret },
          summary: `opaque ${secret}`,
        },
      };
    });
    mockGetExecutionRouter.mockResolvedValue({ executeWithRoutingStreaming: stream });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockIsExecutionDispatchable.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetOAuthToken.mock.invocationCallOrder[0]!,
    );
    expect(mockGetOAuthToken.mock.invocationCallOrder[0]).toBeLessThan(
      stream.mock.invocationCallOrder[0]!,
    );
    const stepSse = mockSseManager.emit.mock.calls.find((call) => call[1] === 'decision:step');
    const evidence = JSON.stringify({
      events: mockExecutionRepository.createEvent.mock.calls,
      results: mockExecutionRepository.createResult.mock.calls,
      stepSse,
      response: res.body,
    });
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain('?access_token=');
    expect(evidence).not.toContain('echoed');
    expect(evidence).toContain('[redacted:credential]');
    expect(evidence).toContain('[redacted:unapproved-field]');
  });

  it('does not carry a credential through a disconnect that completes at the final lookup', async () => {
    mockGetOAuthToken.mockResolvedValueOnce(null);
    const stream = vi.fn(async function* (candidate: Record<string, unknown>) {
      expect(candidate['parameters']).not.toHaveProperty('accessToken');
      yield { planId: 'plan-1', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
    });
    mockGetExecutionRouter.mockResolvedValue({ executeWithRoutingStreaming: stream });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockIsExecutionDispatchable.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetOAuthToken.mock.invocationCallOrder[0]!,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('rejects a terminal event from a different execution plan', async () => {
    async function* stalePlanStream() {
      yield { planId: 'stale-plan', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
    }
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(() => stalePlanStream()),
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createEvent).not.toHaveBeenCalled();
    expect(mockExecutionRepository.createResult).not.toHaveBeenCalled();
    expect(mockMarkExecutionTerminal).not.toHaveBeenCalled();
    expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
  });

  it('does not terminalize a stream with conflicting terminal events', async () => {
    async function* conflictingStream() {
      yield { planId: 'plan-1', eventType: 'plan_completed', timestamp: new Date(), payload: {} };
      yield { planId: 'plan-1', eventType: 'plan_failed', timestamp: new Date(), payload: {} };
    }
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(() => conflictingStream()),
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createResult).not.toHaveBeenCalled();
    expect(mockExecutionRepository.updatePlanStatus).not.toHaveBeenCalled();
    expect(mockMarkExecutionTerminal).not.toHaveBeenCalled();
    expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
  });

  it('does not trust an exported error class as proof that no effect occurred', async () => {
    async function* rejectedBeforeDispatch() {
      throw new InvariantViolationError('risk binding failed before dispatch');
    }
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(() => rejectedBeforeDispatch()),
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createResult).not.toHaveBeenCalled();
    expect(mockMarkExecutionTerminal).not.toHaveBeenCalled();
    expect((res.body as { execution: { status: string } }).execution.status).toBe('ambiguous');
  });
});
