import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockInterpret,
  mockEvaluate,
  mockGenerate,
  mockExecutionRepository,
  mockGetExecutionRouter,
  mockSseManager,
} = vi.hoisted(() => ({
  mockInterpret: vi.fn(),
  mockEvaluate: vi.fn(),
  mockGenerate: vi.fn(),
  mockExecutionRepository: {
    createPlan: vi.fn(),
    createEvent: vi.fn(),
    updatePlanStatus: vi.fn(),
    createResult: vi.fn(),
  },
  mockGetExecutionRouter: vi.fn(),
  mockSseManager: {
    emit: vi.fn(),
  },
}));

vi.mock('@skytwin/decision-engine', () => ({
  SituationInterpreter: vi.fn().mockImplementation(() => ({ interpret: mockInterpret })),
  DecisionMaker: vi.fn().mockImplementation(() => ({ evaluate: mockEvaluate })),
  LlmSituationStrategy: vi.fn(),
  LlmCandidateGenerator: vi.fn(),
  FallbackSituationStrategy: vi.fn(),
  FallbackCandidateGenerator: vi.fn(),
  RuleBasedCandidateGenerator: vi.fn(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn().mockImplementation(() => ({
    getOrCreateProfile: vi.fn().mockResolvedValue({}),
    getRelevantPreferences: vi.fn().mockResolvedValue([]),
    getPatterns: vi.fn().mockResolvedValue([]),
    getTraits: vi.fn().mockResolvedValue([]),
    getTemporalProfile: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn(),
}));

vi.mock('@skytwin/explanations', () => ({
  ExplanationGenerator: vi.fn().mockImplementation(() => ({ generate: mockGenerate })),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: { create: vi.fn() },
  oauthRepository: { getToken: vi.fn().mockResolvedValue(null) },
  executionRepository: mockExecutionRepository,
  userRepository: { findById: vi.fn().mockResolvedValue({ id: 'user-1', trust_tier: 'observer', ironclaw_channel: 'skytwin' }) },
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([]) },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: { saveDecision: vi.fn(), saveCandidates: vi.fn() },
  explanationRepositoryAdapter: {},
  policyRepositoryAdapter: {},
}));

vi.mock('@skytwin/llm-client', () => ({
  LlmClient: vi.fn(),
}));

vi.mock('../workflows/registry.js', () => ({
  WorkflowHandlerRegistry: vi.fn().mockImplementation(() => ({ register: vi.fn() })),
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
      riskTier: 'low',
      summary: 'Low risk',
      overallConfidence: 0.9,
    });
    mockExecutionRepository.createPlan.mockResolvedValue({ id: 'plan-1' });
    mockExecutionRepository.createEvent.mockResolvedValue({});
    mockExecutionRepository.updatePlanStatus.mockResolvedValue({});
    mockExecutionRepository.createResult.mockResolvedValue({});
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
      userId: 'user-1',
      source: 'test',
      type: 'travel_decision',
    });

    expect(res.status).toBe(200);
    expect(mockSseManager.emit).toHaveBeenCalledWith(
      'user-1',
      'decision:blocked-by-policy',
      expect.objectContaining({
        decisionId: 'decision-1',
        reason: expect.stringContaining('blocked by policy'),
      }),
    );
    // Must not have emitted execution events
    expect(mockSseManager.emit).not.toHaveBeenCalledWith(
      'user-1',
      'decision:executed',
      expect.anything(),
    );
    expect(mockExecutionRepository.createPlan).not.toHaveBeenCalled();
  });

  it('marks the execution plan failed when streaming execution throws before a terminal event', async () => {
    async function* throwingStream() {
      throw new Error('No adapter can handle action type "create_calendar_event"');
    }
    mockGetExecutionRouter.mockResolvedValue({
      executeWithRoutingStreaming: vi.fn(() => throwingStream()),
    });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'user-1',
      source: 'test',
      type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1',
      eventType: 'plan_failed',
      payload: expect.objectContaining({
        error: 'No adapter can handle action type "create_calendar_event"',
      }),
    }));
    expect(mockExecutionRepository.updatePlanStatus).toHaveBeenCalledWith('plan-1', 'failed');
    expect(mockExecutionRepository.createResult).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1',
      success: false,
      error: 'No adapter can handle action type "create_calendar_event"',
    }));
    const body = res.body as { execution: { status: string; planId: string } };
    expect(body.execution).toMatchObject({ status: 'failed', planId: 'plan-1' });
  });
});
