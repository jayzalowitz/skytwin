/**
 * End-to-end test for the feedback loop: when a user approves or rejects
 * an action via the approvals route, an Episode should be persisted into
 * the memory layer (#197). The next time a similar decision is evaluated,
 * DecisionContext.episodicMemories carries that episode and
 * DecisionMaker.calculateEpisodicBoost tilts scoring accordingly.
 *
 * This test exercises the wiring at the route boundary: it issues a real
 * `POST /api/approvals/:id/respond` request, intercepts the
 * mempalaceRepository.createEpisode call, and asserts the right episode
 * shape is recorded.
 *
 * The DecisionMaker boost behaviour itself is unit-tested in
 * packages/decision-engine/src/__tests__/decision-maker.test.ts; here we
 * just verify the route → memory hookup is intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  fakeApprovalRepo,
  fakeDecisionRepo,
  fakeFeedbackRepo,
  fakeMempalaceRepo,
  fakeUserRepo,
  fakeOauthRepo,
} = vi.hoisted(() => ({
  fakeApprovalRepo: {
    findById: vi.fn(),
    respond: vi.fn(),
    deleteStaleEscalations: vi.fn(),
  },
  fakeDecisionRepo: {
    findById: vi.fn(),
    findByIds: vi.fn(),
    getCandidateActionsForDecisions: vi.fn(),
    getOutcomesForDecisions: vi.fn(),
  },
  fakeFeedbackRepo: {
    create: vi.fn(),
  },
  fakeMempalaceRepo: {
    createEpisode: vi.fn(),
  },
  fakeUserRepo: {
    findById: vi.fn(),
  },
  fakeOauthRepo: {
    getToken: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: fakeApprovalRepo,
  decisionRepository: fakeDecisionRepo,
  // approvals.ts now looks up the persisted RiskAssessment by candidate
  // id before executing (#371). The mock echoes the requested id back as
  // assessment.actionId so the execution-router's actionId-match
  // invariant cannot be silently bypassed in tests (Copilot review on
  // PR #417).
  decisionRepositoryAdapter: {
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
  feedbackRepository: fakeFeedbackRepo,
  mempalaceRepository: fakeMempalaceRepo,
  oauthRepository: fakeOauthRepo,
  userRepository: fakeUserRepo,
  TwinRepositoryAdapter: vi.fn().mockImplementation(() => ({
    getProfile: vi.fn().mockResolvedValue({ id: 'p', userId: 'u', version: 1, preferences: [], inferences: [], createdAt: new Date(), updatedAt: new Date() }),
    createProfile: vi.fn().mockImplementation(async (p: unknown) => p),
    updateProfile: vi.fn().mockImplementation(async (p: unknown) => p),
    getPreferences: vi.fn().mockResolvedValue([]),
    getPreferencesByDomain: vi.fn().mockResolvedValue([]),
    upsertPreference: vi.fn(),
    getInferences: vi.fn().mockResolvedValue([]),
    upsertInference: vi.fn(),
    addEvidence: vi.fn(),
    getEvidence: vi.fn().mockResolvedValue([]),
    getEvidenceByIds: vi.fn().mockResolvedValue([]),
    addFeedback: vi.fn(),
    getFeedback: vi.fn().mockResolvedValue([]),
  })),
  PatternRepositoryAdapter: vi.fn().mockImplementation(() => ({
    getPatterns: vi.fn().mockResolvedValue([]),
    upsertPattern: vi.fn(),
    getTraits: vi.fn().mockResolvedValue([]),
    upsertTrait: vi.fn(),
  })),
  policyRepositoryAdapter: {
    getAllPolicies: vi.fn().mockResolvedValue([]),
    getEnabledPolicies: vi.fn().mockResolvedValue([]),
    getPolicy: vi.fn().mockResolvedValue(null),
    getPoliciesByDomain: vi.fn().mockResolvedValue([]),
    savePolicy: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
  },
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn() }),
  ),
}));

vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: vi.fn().mockResolvedValue({
    executeWithRoutingStreaming: async function* () {},
    executeWithRouting: async () => ({ success: false, error: 'no execution in test' }),
  }),
}));

vi.mock('../sse.js', () => ({
  sseManager: {
    emit: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
  },
}));

vi.mock('@skytwin/core', async () => {
  const actual: typeof import('@skytwin/core') = await vi.importActual('@skytwin/core');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { createApprovalsRouter } from '../routes/approvals.js';

const USER_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: USER_ID };
    next();
  });
  app.use('/api/approvals', createApprovalsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function postJson(
  app: Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeApprovalRepo.findById.mockResolvedValue({
    id: 'app-1',
    user_id: USER_ID,
    decision_id: 'dec-1',
    candidate_action: { id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc', actionType: 'archive_email', description: 'Archive', domain: 'email', parameters: {}, reversible: true },
    status: 'pending',
  });
  fakeApprovalRepo.respond.mockResolvedValue({
    id: 'app-1',
    user_id: USER_ID,
    decision_id: 'dec-1',
    candidate_action: { id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc', actionType: 'archive_email', description: 'Archive', domain: 'email', parameters: {}, reversible: true },
    status: 'approved',
    responded_at: new Date(),
  });
  fakeFeedbackRepo.create.mockResolvedValue({ id: 'fb-1' });
  fakeMempalaceRepo.createEpisode.mockResolvedValue({ id: 'ep-1' });
  fakeDecisionRepo.findById.mockResolvedValue({
    id: 'dec-1',
    user_id: USER_ID,
    situation_type: 'email_triage',
    raw_event: {},
    interpreted_situation: { summary: 'archive newsletter from sender X' },
    domain: 'email',
    urgency: 'low',
    metadata: {},
    signal_id: null,
    created_at: new Date(),
  });
  fakeUserRepo.findById.mockResolvedValue({ id: USER_ID, trust_tier: 'moderate_autonomy', ironclaw_channel: 'skytwin' });
  fakeOauthRepo.getToken.mockResolvedValue(null);
});

describe('feedback loop — approval records an episode for memory boost', () => {
  it('approve → mempalaceRepository.createEpisode is called with utility 0.9', async () => {
    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });
    expect(fakeMempalaceRepo.createEpisode).toHaveBeenCalledTimes(1);
    const call = fakeMempalaceRepo.createEpisode.mock.calls[0]![0];
    expect(call.userId).toBe(USER_ID);
    expect(call.actionTaken).toBe('archive_email');
    expect(call.feedbackType).toBe('approve');
    expect(call.utilityScore).toBe(0.9);
    expect(call.decisionId).toBe('dec-1');
    expect(call.domain).toBe('email');
    expect(call.situationType).toBe('email_triage');
    expect(call.situationSummary).toBe('archive newsletter from sender X');
  });

  it('reject → mempalaceRepository.createEpisode is called with utility 0.0', async () => {
    fakeApprovalRepo.respond.mockResolvedValue({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: { id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc', actionType: 'archive_email', description: 'Archive', domain: 'email', parameters: {}, reversible: true },
      status: 'rejected',
      responded_at: new Date(),
    });
    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'reject',
      userId: USER_ID,
      reason: 'Important — handle manually',
    });
    expect(fakeMempalaceRepo.createEpisode).toHaveBeenCalledTimes(1);
    const call = fakeMempalaceRepo.createEpisode.mock.calls[0]![0];
    expect(call.feedbackType).toBe('reject');
    expect(call.utilityScore).toBe(0.0);
    expect(call.feedbackDetail).toBe('Important — handle manually');
  });

  it('episode recording failure does not break the approval response', async () => {
    fakeMempalaceRepo.createEpisode.mockRejectedValueOnce(new Error('memory layer DB down'));
    const app = buildApp();
    const res = await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });
    // Approval still succeeds — episode is best-effort
    expect(res.status).toBe(200);
    expect(fakeMempalaceRepo.createEpisode).toHaveBeenCalledTimes(1);
  });

  it('approve → sseManager emits memory:episode-recorded for live dashboard refresh', async () => {
    const { sseManager } = await import('../sse.js');
    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });
    const calls = (sseManager.emit as ReturnType<typeof vi.fn>).mock.calls;
    const memoryEvent = calls.find((c) => c[1] === 'memory:episode-recorded');
    expect(memoryEvent).toBeDefined();
    const payload = memoryEvent![2] as Record<string, unknown>;
    expect(payload['actionType']).toBe('archive_email');
    expect(payload['feedbackType']).toBe('approve');
    expect(payload['decisionId']).toBe('dec-1');
  });

  it('falls back to a synthetic summary when the decision row has no interpreted summary', async () => {
    fakeDecisionRepo.findById.mockResolvedValueOnce({
      id: 'dec-1',
      user_id: USER_ID,
      situation_type: 'email_triage',
      raw_event: {},
      interpreted_situation: {}, // no summary
      domain: 'email',
      urgency: 'low',
      metadata: {},
      signal_id: null,
      created_at: new Date(),
    });
    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });
    const call = fakeMempalaceRepo.createEpisode.mock.calls[0]![0];
    // Synthetic summary mentions the user action and the action type
    expect(call.situationSummary).toMatch(/approved.*archive_email|archive_email/);
  });
});
