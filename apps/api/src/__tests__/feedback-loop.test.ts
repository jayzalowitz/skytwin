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
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { AmbiguousExecutionError } from '@skytwin/execution-router';

const {
  fakeApprovalRepo,
  fakeDecisionRepo,
  fakeFeedbackRepo,
  fakeMempalaceRepo,
  fakeMemoryActionOpportunityRepo,
  fakeUserRepo,
  fakeOauthRepo,
  fakeExecutionRouter,
  fakeBarrierRepo,
  fakeExplanationRepo,
  fakePolicyGetAll,
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
  fakeMemoryActionOpportunityRepo: {
    markStatus: vi.fn(),
  },
  fakeUserRepo: {
    findById: vi.fn(),
  },
  fakeOauthRepo: {
    getToken: vi.fn(),
  },
  fakeExecutionRouter: {
    executeWithRoutingStreaming: vi.fn(async function* () {}),
    executeWithRouting: vi.fn(),
    route: vi.fn(),
    prepareExecution: vi.fn(),
    executePrepared: vi.fn(),
  },
  fakeBarrierRepo: {
    reserve: vi.fn(), markPrepared: vi.fn(), claimPrepared: vi.fn(), markTerminal: vi.fn(),
  },
  fakeExplanationRepo: { save: vi.fn() },
  fakePolicyGetAll: vi.fn().mockResolvedValue([]),
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
    saveRiskAssessment: vi.fn().mockImplementation(async (risk: unknown) => risk),
    saveOutcome: vi.fn().mockImplementation(async (outcome: unknown) => outcome),
  },
  explanationRepositoryAdapter: fakeExplanationRepo,
  preEffectBarrierRepository: fakeBarrierRepo,
  feedbackRepository: fakeFeedbackRepo,
  mempalaceRepository: fakeMempalaceRepo,
  memoryActionOpportunityRepository: fakeMemoryActionOpportunityRepo,
  oauthRepository: fakeOauthRepo,
  userRepository: fakeUserRepo,
  TwinRepositoryAdapter: vi.fn(function TwinRepositoryAdapter() {
    return {
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
    };
  }),
  PatternRepositoryAdapter: vi.fn(function PatternRepositoryAdapter() {
    return {
    getPatterns: vi.fn().mockResolvedValue([]),
    upsertPattern: vi.fn(),
    getTraits: vi.fn().mockResolvedValue([]),
    upsertTrait: vi.fn(),
    };
  }),
  policyRepositoryAdapter: {
    getAllPolicies: fakePolicyGetAll,
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
  getExecutionRouter: vi.fn().mockResolvedValue(fakeExecutionRouter),
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
  fakeMemoryActionOpportunityRepo.markStatus.mockResolvedValue(null);
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
  fakeExecutionRouter.executeWithRouting.mockResolvedValue({
    planId: 'plan-1',
    status: 'failed',
    startedAt: new Date(),
    completedAt: new Date(),
    error: 'no execution in test',
    output: {},
  });
  fakeExecutionRouter.route.mockImplementation(async (_action, risk) => ({
    selectedAdapter: 'direct', fallbackChain: [], attemptedAdapters: [],
    adapterTrustProfile: { adapterName: 'direct', trustLevel: 'local', riskModifier: 0 },
    riskModifierApplied: 0, modifiedRiskAssessment: risk, reasoning: 'test route',
  }));
  fakeExecutionRouter.prepareExecution.mockImplementation(async (action, routing) => ({
    selectedAdapter: routing.selectedAdapter,
    routingDecision: routing,
    plan: { id: 'prepared-plan', decisionId: action.decisionId, action, steps: [], rollbackSteps: [], createdAt: new Date() },
  }));
  fakeExecutionRouter.executePrepared.mockResolvedValue({
    planId: 'plan-1', status: 'failed', startedAt: new Date(), completedAt: new Date(),
    error: 'no execution in test', output: { adapter_used: 'direct' },
  });
  fakeBarrierRepo.reserve.mockResolvedValue({
    row: { id: 'barrier-1', status: 'reserved', effect_result: {} }, created: true,
  });
  fakeBarrierRepo.markPrepared.mockResolvedValue({ status: 'prepared' });
  fakeBarrierRepo.claimPrepared.mockResolvedValue({ status: 'in_progress' });
  fakeBarrierRepo.markTerminal.mockResolvedValue({ status: 'failed' });
  fakeExplanationRepo.save.mockImplementation(async (record) => ({
    ...record,
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  }));
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
    expect(fakePolicyGetAll).toHaveBeenCalledWith(USER_ID);
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

  it('approve preserves stored cost intent and provenance when reconstructing the candidate', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'create_task',
      description: 'Create task from memory',
      domain: 'tasks',
      parameters: {},
      estimatedCostCents: 0,
      costZeroIntent: 'unknown',
      reversible: true,
      confidence: 'moderate',
      reasoning: 'memory action loop',
      provenance: 'untrusted_external',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'approved',
      responded_at: new Date(),
    });

    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    const candidate = fakeExecutionRouter.executeWithRouting.mock.calls[0]![0] as Record<string, unknown>;
    expect(candidate['costZeroIntent']).toBe('unknown');
    expect(candidate['provenance']).toBe('untrusted_external');
  });

  it('approve treats malformed stored cost intent as unknown', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'create_task',
      description: 'Create task from memory',
      domain: 'tasks',
      parameters: {},
      estimatedCostCents: 0,
      costZeroIntent: 'tampered_zero',
      reversible: true,
      confidence: 'moderate',
      reasoning: 'memory action loop',
      provenance: 'trusted_context',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'approved',
      responded_at: new Date(),
    });

    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    const candidate = fakeExecutionRouter.executeWithRouting.mock.calls[0]![0] as Record<string, unknown>;
    expect(candidate['costZeroIntent']).toBe('unknown');
  });

  it('approve updates memory action opportunity status after execution attempt', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'create_task',
      description: 'Create task from memory',
      domain: 'tasks',
      parameters: {
        opportunityId: '11111111-1111-1111-1111-111111111111',
        summary: 'Madrid launch checklist',
      },
      estimatedCostCents: 0,
      costZeroIntent: 'unknown',
      reversible: true,
      confidence: 'moderate',
      reasoning: 'memory action loop',
      provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'approved',
      responded_at: new Date(),
    });

    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    const markInput = fakeMemoryActionOpportunityRepo.markStatus.mock.calls[0]![0] as Record<string, unknown>;
    expect(markInput).toEqual(
      expect.objectContaining({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'execution_failed',
        decisionId: 'dec-1',
        approvalRequestId: 'app-1',
        nextStep: expect.stringContaining('retry'),
      }),
    );
    expect(markInput).not.toHaveProperty('routeReason');
  });

  it('policy-checks and persists the exact adapter-adjusted risk before memory dispatch', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc', actionType: 'create_task',
      description: 'Create task from memory', domain: 'tasks',
      parameters: { opportunityId: '11111111-1111-1111-1111-111111111111' },
      estimatedCostCents: 0, costZeroIntent: 'verified_zero', reversible: true,
      confidence: 'moderate', reasoning: 'memory action loop', provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1', user_id: USER_ID, decision_id: 'dec-1', candidate_action: storedAction, status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1', user_id: USER_ID, decision_id: 'dec-1', candidate_action: storedAction,
      status: 'approved', responded_at: new Date(),
    });
    fakeExecutionRouter.route.mockImplementationOnce(async (_action, risk) => ({
      selectedAdapter: 'ironclaw', fallbackChain: [], attemptedAdapters: [],
      adapterTrustProfile: { adapterName: 'ironclaw', trustLevel: 'verified', riskModifier: 2 },
      riskModifierApplied: 2,
      modifiedRiskAssessment: { ...risk, overallTier: 'high', reasoning: 'adapter-adjusted high risk' },
      reasoning: 'selected exact adapter',
    }));
    const evaluate = vi.spyOn(PolicyEvaluator.prototype, 'evaluate').mockResolvedValueOnce({
      allowed: true, requiresApproval: true, reason: 'Human approval satisfies escalation.',
    });

    await postJson(buildApp(), '/api/approvals/app-1/respond', { action: 'approve', userId: USER_ID });

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ id: storedAction.id }),
      expect.any(Array),
      expect.any(String),
      expect.objectContaining({ overallTier: 'high', reasoning: 'adapter-adjusted high risk' }),
      expect.anything(),
    );
    expect(fakeBarrierRepo.markPrepared).toHaveBeenCalledBefore(fakeBarrierRepo.claimPrepared);
    expect(fakeBarrierRepo.markPrepared).toHaveBeenCalledWith(expect.objectContaining({
      explanationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }));
    expect(fakeBarrierRepo.claimPrepared).toHaveBeenCalledBefore(fakeExecutionRouter.executePrepared);
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
  });

  it('records an adapter throw as unknown and does not fabricate a failed dispatch result', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc', actionType: 'create_task',
      description: 'Create task from memory', domain: 'tasks',
      parameters: { opportunityId: '11111111-1111-1111-1111-111111111111' },
      estimatedCostCents: 0, costZeroIntent: 'verified_zero', reversible: true,
      confidence: 'moderate', reasoning: 'memory action loop', provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1', user_id: USER_ID, decision_id: 'dec-1', candidate_action: storedAction, status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1', user_id: USER_ID, decision_id: 'dec-1', candidate_action: storedAction,
      status: 'approved', responded_at: new Date(),
    });
    fakeExecutionRouter.executePrepared.mockRejectedValueOnce(
      new AmbiguousExecutionError('direct', new Error('SECRET_MARKER socket closed after dispatch')),
    );

    const response = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve', userId: USER_ID,
    });

    expect(response.status).toBe(200);
    expect(fakeBarrierRepo.markTerminal).toHaveBeenCalledWith(
      USER_ID, 'barrier-1', 'unknown', {}, 'adapter_dispatch_ambiguous',
    );
    expect(fakeMemoryActionOpportunityRepo.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'execution_unknown' }),
    );
    expect(JSON.stringify([
      fakeBarrierRepo.markTerminal.mock.calls,
      fakeMemoryActionOpportunityRepo.markStatus.mock.calls,
      fakeExplanationRepo.save.mock.calls,
    ])).not.toContain('SECRET_MARKER');
  });

  it('does not dispatch a memory approval when admission explanation persistence fails', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc', actionType: 'create_task',
      description: 'Create task from memory', domain: 'tasks',
      parameters: { opportunityId: '11111111-1111-1111-1111-111111111111' },
      estimatedCostCents: 0, costZeroIntent: 'verified_zero', reversible: true,
      confidence: 'moderate', reasoning: 'memory action loop', provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1', user_id: USER_ID, decision_id: 'dec-1', candidate_action: storedAction, status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1', user_id: USER_ID, decision_id: 'dec-1', candidate_action: storedAction,
      status: 'approved', responded_at: new Date(),
    });
    fakeExplanationRepo.save.mockRejectedValueOnce(new Error('explanation store unavailable'));

    const response = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve', userId: USER_ID,
    });

    expect(response.status).toBe(500);
    expect(fakeBarrierRepo.claimPrepared).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executePrepared).not.toHaveBeenCalled();
  });

  it('reject marks the memory action opportunity skipped', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'create_task',
      description: 'Create task from memory',
      domain: 'tasks',
      parameters: {
        opportunityId: '11111111-1111-1111-1111-111111111111',
        summary: 'Madrid launch checklist',
      },
      reversible: true,
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'rejected',
      responded_at: new Date(),
    });

    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'reject',
      userId: USER_ID,
      reason: 'not useful',
    });

    expect(fakeMemoryActionOpportunityRepo.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'skipped',
        decisionId: 'dec-1',
        approvalRequestId: 'app-1',
      }),
    );
  });
});
