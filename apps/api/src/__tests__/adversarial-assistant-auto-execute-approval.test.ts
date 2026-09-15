import { beforeEach, expect, it, vi } from 'vitest';
import { ConfidenceLevel, RiskTier, type DecisionContext } from '@skytwin/shared-types';

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
  boundDecisionRepository: null as null | { saveOutcome(outcome: unknown): Promise<unknown> },
  saveDecision: vi.fn(),
  saveOutcome: vi.fn(),
  generateExplanation: vi.fn(),
  createApproval: vi.fn(),
  findApproval: vi.fn(),
  findUser: vi.fn(),
  emit: vi.fn(),
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
  DecisionMaker: vi.fn(function DecisionMaker(
    _twin: unknown,
    _policy: unknown,
    repository: { saveOutcome(outcome: unknown): Promise<unknown> },
  ) {
    mocks.boundDecisionRepository = repository;
    return { evaluate: mocks.evaluate };
  }),
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
  assistantRepository: {},
  emailLabelRepository: { topLabelsForSender: vi.fn(), topLabelsForListId: vi.fn() },
  mcpServerRepository: {},
  mempalaceRepository: {},
  userRepository: { findById: mocks.findUser },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: { saveDecision: mocks.saveDecision, saveOutcome: mocks.saveOutcome },
  explanationRepositoryAdapter: {},
  policyRepositoryAdapter: {},
}));

vi.mock('@skytwin/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../sse.js', () => ({ sseManager: { emit: mocks.emit } }));

import { buildActionRouter } from '../routes/assistant.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boundDecisionRepository = null;
  mocks.saveDecision.mockImplementation(async (decision) => ({ decision, created: true }));
  mocks.saveOutcome.mockImplementation(async (outcome) => outcome);
  mocks.generateExplanation.mockResolvedValue({ id: 'explanation-1' });
  mocks.createApproval.mockResolvedValue({ row: { id: 'approval-1' }, created: true });
  mocks.findApproval.mockResolvedValue(null);
  mocks.findUser.mockResolvedValue({ trust_tier: 'high_autonomy', autonomy_settings: {} });
  mocks.twinService.getRelevantPreferences.mockResolvedValue([]);
  mocks.twinService.getPatterns.mockResolvedValue([]);
  mocks.twinService.getTraits.mockResolvedValue([]);
  mocks.twinService.getTemporalProfile.mockResolvedValue(undefined);
});

it('adv-v1-assistant-auto-execute-approval converts chat auto-execution into one approval', async () => {
  mocks.evaluate.mockImplementation(async (context: DecisionContext) => {
    const requestedAction = context.decision.rawData['requestedAction'];
    if (typeof requestedAction !== 'string') throw new Error('missing requested action in decision context');
    const action = {
      id: '22222222-2222-4222-8222-222222222222',
      decisionId: context.decision.id,
      actionType: requestedAction,
      description: 'Send the requested email',
      domain: 'email',
      parameters: {},
      estimatedCostCents: 0,
      costZeroIntent: 'unknown' as const,
      reversible: false,
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'The user requested it.',
      provenance: context.decision.provenance,
    };
    const outcome = {
      id: '33333333-3333-4333-8333-333333333333',
      decisionId: context.decision.id,
      selectedAction: action,
      allCandidates: [action],
      riskAssessment: {
        actionId: action.id,
        overallTier: RiskTier.LOW,
        dimensions: {},
        reasoning: 'Engine considered this low risk.',
        assessedAt: new Date('2026-09-14T00:00:00.000Z'),
      },
      autoExecute: true,
      requiresApproval: false,
      reasoning: 'Policy allowed automatic execution.',
      decidedAt: new Date('2026-09-14T00:00:00.000Z'),
      policyVerdicts: { [action.id]: 'allowed' as const },
    };
    await mocks.boundDecisionRepository!.saveOutcome(outcome);
    return outcome;
  });

  const result = await buildActionRouter().route(
    'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
    {
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Send an email',
      rawData: { source: 'user_request', requestedAction: 'send_email' },
      triggerMessage: 'send that email',
    },
    { idempotencyKey: 'assistant-message-1' },
  );
  const evaluatedContext = mocks.evaluate.mock.calls[0]?.[0] as DecisionContext;

  expect({
    result,
    evaluatedContext,
    saved: mocks.saveOutcome.mock.calls[0]?.[0],
    approval: mocks.createApproval.mock.calls[0]?.[0],
    calls: {
      decision: mocks.saveDecision.mock.calls.length,
      outcome: mocks.saveOutcome.mock.calls.length,
      explanation: mocks.generateExplanation.mock.calls.length,
      approval: mocks.createApproval.mock.calls.length,
    },
  })
    .toMatchObject({
      result: { kind: 'requires-approval', approvalRequestId: 'approval-1' },
      evaluatedContext: {
        decision: {
          provenance: 'user_originated',
          rawData: {
            source: 'user_request',
            requestedAction: 'send_email',
            triggerMessage: 'send that email',
            userId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
            signalId: 'assistant-message:assistant-message-1',
          },
        },
      },
      saved: {
        autoExecute: false,
        requiresApproval: true,
        reasoning: expect.stringContaining('explicit approval'),
      },
      approval: {
        confirmationLevel: 'single',
        candidateAction: {
          actionType: 'send_email',
          parameters: {},
          reversible: false,
          provenance: 'user_originated',
        },
      },
      calls: { decision: 1, outcome: 1, explanation: 1, approval: 1 },
    });
});
