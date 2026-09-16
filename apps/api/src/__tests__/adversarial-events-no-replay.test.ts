import { it, expect, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

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
  mockFindBySignalId,
  mockGetProviders,
  mockCreateReceipts,
  mockGetIngestState,
  mockClaimExecution,
  mockIsExecutionDispatchable,
  mockMarkExecutionTerminal,
  mockMarkExecutionFailedBeforeDispatch,
  mockMarkNonEffect,
  mockRecordPolicyDenial,
  mockRecordPreparationDisposition,
  mockFindExecutionDisposition,
  mockEscalateExecutionToApproval,
  mockGetExplanation,
  mockEmitReceipt,
  mockSnapshotTrace,
  mockLlmClient,
  mockGetOAuthToken,
  mockCurrentPolicyEvaluate,
  mockGetAllPolicies,
  mockFindUser,
  mockRecordSignal,
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
  mockFindBySignalId: vi.fn(),
  mockGetProviders: vi.fn(),
  mockCreateReceipts: vi.fn(),
  mockGetIngestState: vi.fn(),
  mockClaimExecution: vi.fn(),
  mockIsExecutionDispatchable: vi.fn(),
  mockMarkExecutionTerminal: vi.fn(),
  mockMarkExecutionFailedBeforeDispatch: vi.fn(),
  mockMarkNonEffect: vi.fn(),
  mockRecordPolicyDenial: vi.fn(),
  mockRecordPreparationDisposition: vi.fn(),
  mockFindExecutionDisposition: vi.fn(),
  mockEscalateExecutionToApproval: vi.fn(),
  mockGetExplanation: vi.fn(),
  mockEmitReceipt: vi.fn(),
  mockSnapshotTrace: vi.fn((trace: unknown) => structuredClone(trace)),
  mockLlmClient: vi.fn(),
  mockGetOAuthToken: vi.fn(),
  mockCurrentPolicyEvaluate: vi.fn(),
  mockGetAllPolicies: vi.fn(),
  mockFindUser: vi.fn(),
  mockRecordSignal: vi.fn(),
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
  signalRepository: {
    persistUnboundSignal: vi.fn(async (input: Record<string, unknown>) => ({
      created: true,
      signal: { source: input['source'], type: input['type'], source_signal_id: input['sourceSignalId'], data: input['data'] },
    })),
  },
  approvalRepository: {
    create: mockApprovalCreate,
    findByDecisionId: mockApprovalFindByDecisionId,
  },
  oauthRepository: { getToken: mockGetOAuthToken },
  executionRepository: mockExecutionRepository,
  executionAdmissionRepository: {
    recordPolicyDenial: mockRecordPolicyDenial,
    recordReceiptPreparationDisposition: mockRecordPreparationDisposition,
    findReceiptExecutionDisposition: mockFindExecutionDisposition,
  },
  userRepository: { findById: mockFindUser },
  aiProviderRepository: { getEnabledForUser: mockGetProviders },
  inferenceReceiptRepository: {
    createManyForUser: mockCreateReceipts,
    getContinuationForDecision: mockGetIngestState,
    claimExecutionForDecision: mockClaimExecution,
    isExecutionDispatchableForDecision: mockIsExecutionDispatchable,
    markExecutionTerminalForDecision: mockMarkExecutionTerminal,
    markExecutionFailedBeforeDispatchForDecision: mockMarkExecutionFailedBeforeDispatch,
    markNonEffectForDecision: mockMarkNonEffect,
    escalateExecutionToApproval: mockEscalateExecutionToApproval,
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
    findBySignalId: mockFindBySignalId,
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
  getPolicyAuthorityRevision: vi.fn().mockResolvedValue('policy-authority-revision-1'),
}));

vi.mock('@skytwin/llm-client', () => ({
  LlmClient: mockLlmClient,
  emitInferenceReceipt: mockEmitReceipt,
  snapshotInferenceTrace: mockSnapshotTrace,
}));

vi.mock('../lib/user-llm-client.js', () => ({
  resolveUserLlmClient: vi.fn(async (
    userId: string,
    options: { onInferenceTrace?: (trace: unknown) => void },
  ) => {
    const providers = await mockGetProviders();
    if (providers.length === 0) {
      return { state: 'no_provider', client: null, reason: 'No provider in test' };
    }
    return {
      state: 'ready',
      client: mockLlmClient(providers, userId, options),
      mode: providers[0]?.provider === 'embedded' || providers[0]?.provider === 'ollama'
        ? 'on_device'
        : 'bring_your_own_provider',
    };
  }),
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
  getExecutionRouter: async (...args: unknown[]) => {
    const router = await mockGetExecutionRouter(...args) as Record<string, unknown>;
    if (typeof router['prepareExecution'] === 'function') return router;
    const stream = router['executeWithRoutingStreaming'] as (
      ...streamArgs: unknown[]
    ) => AsyncIterable<unknown>;
    return {
      ...router,
      prepareExecution: vi.fn(async (_action: unknown, risk: Record<string, unknown>) => ({
        handle: {}, adapterName: 'ironclaw', planId: 'plan-1',
        riskAssessment: risk, streaming: true,
        routingDecision: { selectedAdapter: 'ironclaw', reasoning: 'IronClaw prepared.' },
      })),
      executePreparedStreaming: vi.fn((
        _prepared: unknown,
        ...streamArgs: unknown[]
      ) => stream(...streamArgs)),
    };
  },
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

vi.mock('../sse.js', () => ({
  sseManager: mockSseManager,
}));

vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: vi.fn(async () => ({
    port: {
      recordSignal: mockRecordSignal,
      searchSemantic: vi.fn().mockResolvedValue([]),
    },
    hybrid: null,
  })),
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

const mappedScenario = {
  runtimeEntryPath: 'api.events_ingest',
  adapter: 'none',
  criticalShape: 'send',
  action: { actionType: 'send_email', reversible: false, parameters: {} },
  origin: { kind: 'email', source: 'gmail', authoringTier: 'inbox_automated' },
  provenance: 'untrusted_external',
} as const;

function ingestState(
  effectState: 'non_effect' | 'ready' | 'running' | 'completed' | 'failed' | 'restored_non_replay',
  continuationKind: 'auto_execute' | 'approval' | 'non_effect' =
    effectState === 'ready' || effectState === 'running' || effectState === 'completed' || effectState === 'failed'
      ? 'auto_execute'
      : 'non_effect',
) {
  const selectedAction = continuationKind === 'non_effect' ? null : {
    id: 'action-1', decisionId: 'decision-1', ...mappedScenario.action,
    description: 'Send email', domain: 'email',
    provenance: mappedScenario.provenance,
    estimatedCostCents: 0, confidence: 'high', reasoning: 'test',
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
const userId = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

it('adv-v1-events-no-replay-ambiguous never redispatches an uncertain prior execution', async () => {
  vi.clearAllMocks();
  mockFindBySignalId.mockResolvedValue({
    id: 'decision-1',
    userId,
    signalId: 'signal-1',
    situationType: 'email_triage',
    domain: 'email',
    urgency: 'medium',
    summary: 'Inbound email',
    rawData: {},
    interpretedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const priorIngestState = ingestState('running');
  const priorAction = priorIngestState.continuation.outcome.selectedAction;
  expect({
    runtimeEntryPath: mappedScenario.runtimeEntryPath,
    adapter: mappedScenario.adapter,
    criticalShape: mappedScenario.criticalShape,
    action: {
      actionType: priorAction?.actionType,
      reversible: priorAction?.reversible,
      parameters: priorAction?.parameters,
    },
    origin: mappedScenario.origin,
    provenance: priorAction?.provenance,
  }).toEqual(mappedScenario);
  mockGetIngestState.mockResolvedValue(priorIngestState);

  const response = await request(buildApp(), 'POST', '/api/events/ingest', {
    userId,
    signalId: 'signal-1',
    source: mappedScenario.origin.source,
    type: mappedScenario.origin.kind,
    data: { authoringTier: mappedScenario.origin.authoringTier },
  });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    reIngested: true,
    replaySuppressed: true,
    execution: { status: 'ambiguous', planId: null },
  });
  expect(mockInterpret).not.toHaveBeenCalled();
  expect(mockEvaluate).not.toHaveBeenCalled();
  expect(mockExecutionRepository.getByDecisionId).not.toHaveBeenCalled();
  expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
  expect(mockGetExecutionRouter).not.toHaveBeenCalled();
});
