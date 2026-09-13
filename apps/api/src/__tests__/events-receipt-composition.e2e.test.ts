import { randomUUID } from 'node:crypto';
import express from 'express';
import type { CandidateAction, DecisionOutcome, RiskAssessment } from '@skytwin/shared-types';
import { ConfidenceLevel, RiskDimension, RiskTier } from '@skytwin/shared-types';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const E2E = process.env['E2E'] === 'true';
const {
  mockInterpret,
  mockEvaluate,
  mockReevaluate,
  mockExecute,
  mockGetToken,
} = vi.hoisted(() => ({
  mockInterpret: vi.fn(),
  mockEvaluate: vi.fn(),
  mockReevaluate: vi.fn(),
  mockExecute: vi.fn(),
  mockGetToken: vi.fn(),
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

vi.mock('@skytwin/policy-engine', () => ({ PolicyEvaluator: vi.fn() }));
vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: vi.fn(async () => ({ executeWithRoutingStreaming: mockExecute })),
}));
vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: vi.fn(async () => ({
    port: { recordSignal: vi.fn().mockResolvedValue(undefined) },
    hybrid: null,
  })),
}));
vi.mock('@skytwin/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skytwin/db')>();
  return {
    ...actual,
    oauthRepository: { ...actual.oauthRepository, getToken: mockGetToken },
  };
});

const { createEventsRouter } = await import('../routes/events.js');
const {
  closePool,
  decisionRepositoryAdapter,
  query,
} = await import('@skytwin/db');

const createdUsers: string[] = [];
const createdDecisions: string[] = [];

function riskFor(action: CandidateAction): RiskAssessment {
  return {
    actionId: action.id,
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'test' },
      [RiskDimension.FINANCIAL_IMPACT]: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      [RiskDimension.LEGAL_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      [RiskDimension.PRIVACY_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'test' },
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'test' },
      [RiskDimension.OPERATIONAL_RISK]: { tier: RiskTier.LOW, score: 0.2, reasoning: 'test' },
    },
    reasoning: 'test risk',
    assessedAt: new Date(),
  };
}

async function persistOutcome(action: CandidateAction): Promise<DecisionOutcome> {
  const assessment = riskFor(action);
  await decisionRepositoryAdapter.saveCandidates([action]);
  await decisionRepositoryAdapter.saveRiskAssessment(assessment);
  const outcome: DecisionOutcome = {
    id: randomUUID(),
    decisionId: action.decisionId,
    selectedAction: action,
    allCandidates: [action],
    riskAssessment: assessment,
    allRiskAssessments: [assessment],
    autoExecute: true,
    requiresApproval: false,
    reasoning: 'Allowed by final policy evaluation',
    decidedAt: new Date(),
    policyVerdicts: { [action.id]: 'allowed' },
  };
  const saved = await decisionRepositoryAdapter.saveOutcome(outcome);
  return { ...outcome, id: saved.id };
}

async function postIngest(userId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/events', createEventsRouter());
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing test address');
        const response = await fetch(`http://127.0.0.1:${address.port}/api/events/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId, source: 'test', type: 'calendar_event' }),
        });
        resolve({ status: response.status, body: await response.json() as Record<string, unknown> });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

describe.skipIf(!E2E)('E2E: event receipt authority composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue({ access_token: 'credential-secret' });
  });

  afterEach(async () => {
    for (const decisionId of createdDecisions) {
      await query('DELETE FROM execution_admission_barriers WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM decision_ingest_guards WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM inference_receipts WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM inference_receipt_completions WHERE decision_id = $1', [decisionId]);
      await query(
        `DELETE FROM execution_results WHERE plan_id IN (
          SELECT id FROM execution_plans WHERE decision_id = $1
        )`,
        [decisionId],
      );
      await query(
        `DELETE FROM execution_events WHERE plan_id IN (
          SELECT id FROM execution_plans WHERE decision_id = $1
        )`,
        [decisionId],
      );
      await query('DELETE FROM decision_outcomes WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM execution_plans WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM explanation_records WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM candidate_actions WHERE decision_id = $1', [decisionId]);
      await query('DELETE FROM decisions WHERE id = $1', [decisionId]);
    }
    for (const userId of createdUsers) await query('DELETE FROM users WHERE id = $1', [userId]);
    createdDecisions.length = 0;
    createdUsers.length = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  it.each([
    ['calendar', 'create_calendar_event'],
    ['email', 'draft_email'],
  ] as const)('keeps %s credentials outside the real captured continuation', async (_kind, actionType) => {
    const userId = randomUUID();
    const decisionId = randomUUID();
    const actionId = randomUUID();
    createdUsers.push(userId);
    createdDecisions.push(decisionId);
    await query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
       VALUES ($1, $2, 'Receipt composition', 'high_autonomy', '{}')`,
      [userId, `receipt-composition-${userId}@example.test`],
    );
    mockInterpret.mockResolvedValue({
      id: decisionId, situationType: 'generic', domain: actionType === 'draft_email' ? 'email' : 'calendar',
      urgency: 'medium', summary: 'Composition test',
      rawData: { userId, signalId: randomUUID() }, provenance: 'user_originated', interpretedAt: new Date(),
    });
    const initialAction: CandidateAction = {
      id: actionId, decisionId, actionType,
      description: actionType === 'draft_email' ? 'Draft reply' : 'Create calendar event',
      domain: actionType === 'draft_email' ? 'email' : 'calendar',
      parameters: actionType === 'draft_email' ? { draftBody: 'Hello' } : { title: 'Planning' },
      estimatedCostCents: 0, reversible: true, confidence: ConfidenceLevel.HIGH,
      reasoning: 'test', provenance: 'user_originated',
    };
    mockEvaluate.mockImplementation(async () => persistOutcome(initialAction));
    mockReevaluate.mockImplementation(async (_context, candidates: CandidateAction[]) =>
      persistOutcome(candidates[0]!));
    let executed: CandidateAction | null = null;
    mockExecute.mockImplementation(async function* (action: CandidateAction) {
      executed = structuredClone(action);
      yield {
        planId: action.parameters['executionPlanId'] as string,
        eventType: 'plan_completed', timestamp: new Date(), payload: {},
      };
    });

    const response = await postIngest(userId);

    expect(response.status).toBe(200);
    const stored = await query<{ continuation_snapshot: { outcome: DecisionOutcome } }>(
      'SELECT continuation_snapshot FROM decision_ingest_guards WHERE decision_id = $1',
      [decisionId],
    );
    const capturedAction = stored.rows[0]!.continuation_snapshot.outcome.selectedAction!;
    expect(capturedAction.parameters).not.toHaveProperty('accessToken');
    expect(capturedAction.parameters).not.toHaveProperty('executionPlanId');
    expect(executed!.parameters).toMatchObject({
      accessToken: 'credential-secret',
      executionPlanId: expect.any(String),
    });
    if (actionType === 'draft_email') {
      expect(mockReevaluate).toHaveBeenCalledTimes(1);
      expect(capturedAction).toMatchObject({ actionType: 'send_reply', reversible: false });
    } else {
      expect(mockReevaluate).not.toHaveBeenCalled();
      expect(capturedAction.actionType).toBe('create_calendar_event');
    }
  });
});
