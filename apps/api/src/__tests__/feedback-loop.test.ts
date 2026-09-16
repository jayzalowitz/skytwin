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
import { NoRequestExecutionError } from '@skytwin/execution-router';

const {
  fakeApprovalRepo,
  fakeDecisionRepo,
  fakeFeedbackRepo,
  fakeMempalaceRepo,
  fakeMemoryActionOpportunityRepo,
  fakeUserRepo,
  fakeOauthRepo,
  fakeExecutionRouter,
  fakeExecutionAdmissionRepo,
  fakeExecutionRepo,
  fakeWithTransaction,
  fakeBarrierRepo,
  fakeExplanationRepo,
  fakePolicyGetAll,
  fakeTransactionQuery,
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
  fakeExecutionAdmissionRepo: {
    admitApprovalExecution: vi.fn(),
    isDispatchable: vi.fn(),
    findByScope: vi.fn(),
    observeTerminal: vi.fn(),
    failBeforeDispatch: vi.fn(),
    recordPolicyDenial: vi.fn(),
  },
  fakeExecutionRepo: {
    finalizeAdmittedPlan: vi.fn(),
  },
  fakeWithTransaction: vi.fn(),
  fakeBarrierRepo: {
    reserve: vi.fn(),
    markPrepared: vi.fn(),
    claimPrepared: vi.fn(),
    markTerminal: vi.fn(),
  },
  fakeExplanationRepo: { save: vi.fn() },
  fakePolicyGetAll: vi.fn().mockResolvedValue([]),
  fakeTransactionQuery: vi.fn(),
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
        relationship_sensitivity: {
          tier: 'low',
          score: 0.2,
          reasoning: 'test',
        },
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
  executionAdmissionRepository: fakeExecutionAdmissionRepo,
  executionRepository: fakeExecutionRepo,
  oauthRepository: fakeOauthRepo,
  userRepository: fakeUserRepo,
  TwinRepositoryAdapter: vi.fn(function TwinRepositoryAdapter() {
    return {
      getProfile: vi.fn().mockResolvedValue({
        id: 'p',
        userId: 'u',
        version: 1,
        preferences: [],
        inferences: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
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
  getPolicyAuthorityRevision: vi.fn().mockResolvedValue('policy-authority-revision-1'),
  withTransaction: fakeWithTransaction,
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
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

import { createApprovalsRouter } from '../routes/approvals.js';

const USER_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authenticatedUserId = USER_ID;
    next();
  });
  app.use('/api/approvals', createApprovalsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function postJson(app: Express, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
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
  fakeTransactionQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  fakeApprovalRepo.findById.mockResolvedValue({
    id: 'app-1',
    user_id: USER_ID,
    decision_id: 'dec-1',
    candidate_action: {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'label_email',
      description: 'Label',
      domain: 'email',
      parameters: {},
      reversible: true,
    },
    status: 'pending',
  });
  fakeApprovalRepo.respond.mockResolvedValue({
    id: 'app-1',
    user_id: USER_ID,
    decision_id: 'dec-1',
    candidate_action: {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'label_email',
      description: 'Label',
      domain: 'email',
      parameters: {},
      reversible: true,
    },
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
    interpreted_situation: { summary: 'label newsletter from sender X' },
    domain: 'email',
    urgency: 'low',
    metadata: {},
    signal_id: null,
    created_at: new Date(),
  });
  fakeUserRepo.findById.mockResolvedValue({
    id: USER_ID,
    trust_tier: 'moderate_autonomy',
    ironclaw_channel: 'skytwin',
    execution_authority_revision: 'authority-revision-1',
  });
  fakeOauthRepo.getToken.mockResolvedValue(null);
  fakeExecutionRouter.executeWithRouting.mockResolvedValue({
    planId: 'plan-1',
    status: 'failed',
    startedAt: new Date(),
    completedAt: new Date(),
    error: 'no execution in test',
    output: {},
  });
  fakeExecutionRouter.prepareExecution.mockImplementation(async (_action: unknown, risk: Record<string, unknown>) => ({
    handle: {},
    adapterName: 'direct',
    planId: '44444444-4444-4444-8444-444444444444',
    riskAssessment: risk,
    streaming: false,
    routingDecision: {
      selectedAdapter: 'direct',
      reasoning: 'Direct prepared.',
    },
  }));
  fakeExecutionRouter.executePrepared.mockImplementation(async (_prepared: unknown, ...args: unknown[]) =>
    fakeExecutionRouter.executeWithRouting(...args),
  );
  fakeExecutionAdmissionRepo.admitApprovalExecution.mockResolvedValue({
    created: true,
    barrier: {
      id: '55555555-5555-4555-8555-555555555555',
      status: 'in_progress',
      observed_result: {},
      updated_at: new Date('2026-09-13T00:00:00.000Z'),
    },
    plan: { id: '44444444-4444-4444-8444-444444444444' },
  });
  fakeExecutionAdmissionRepo.observeTerminal.mockResolvedValue({});
  fakeExecutionAdmissionRepo.findByScope.mockResolvedValue(null);
  fakeExecutionAdmissionRepo.isDispatchable.mockResolvedValue(true);
  fakeExecutionAdmissionRepo.failBeforeDispatch.mockResolvedValue({
    status: 'failed',
  });
  fakeExecutionAdmissionRepo.recordPolicyDenial.mockResolvedValue({
    explanationId: 'policy-denial-explanation-1',
    evidence: { kind: 'execution_policy_denial' },
  });
  fakeExecutionRepo.finalizeAdmittedPlan.mockResolvedValue({});
  fakeWithTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: fakeTransactionQuery }),
  );
});

describe('feedback loop — approval records an episode for memory boost', () => {
  it.each(['approve', 'reject'] as const)(
    'keeps a %s response for the bounded Gmail Inbox proposal out of the generic responder',
    async (action) => {
      fakeApprovalRepo.findById.mockResolvedValueOnce({
        id: 'app-1',
        user_id: USER_ID,
        decision_id: 'dec-1',
        candidate_action: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000abc',
          actionType: 'archive_email',
          description: 'Archive this email',
          domain: 'email',
          parameters: {
            schema: 'gmail_inbox_mutation_v1',
            messageRefId: '11111111-1111-4111-8111-111111111111',
            operation: 'archive',
          },
          estimatedCostCents: 0,
          costZeroIntent: 'verified_zero',
          provenance: 'untrusted_external',
          reversible: true,
        },
        status: 'pending',
      });
      const app = buildApp();

      const response = await postJson(app, '/api/approvals/app-1/respond', {
        action,
        userId: USER_ID,
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'GMAIL_ARCHIVE_APPROVAL_INVALID_STATE',
      });
      expect(fakeApprovalRepo.respond).not.toHaveBeenCalled();
      expect(fakeFeedbackRepo.create).not.toHaveBeenCalled();
      expect(fakeOauthRepo.getToken).not.toHaveBeenCalled();
      expect(fakeExecutionRouter.route).not.toHaveBeenCalled();
      expect(fakeExecutionRouter.prepareExecution).not.toHaveBeenCalled();
      expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
      expect(fakeExecutionRouter.executePrepared).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'parameter-free', action: { actionType: 'archive_email' } },
    {
      label: 'legacy',
      action: {
        actionType: 'archive_email',
        parameters: { emailId: 'provider-id', folder: 'archive' },
      },
    },
    { label: 'empty', action: { actionType: 'archive_email', parameters: {} } },
    {
      label: 'mixed',
      action: {
        actionType: 'archive_email',
        parameters: { schema: 'other', operation: 'restore' },
      },
    },
  ])('quarantines a $label archive approval before every generic side effect', async ({ action }) => {
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: action,
      status: 'pending',
    });
    const response = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'GMAIL_ARCHIVE_APPROVAL_INVALID_STATE',
    });
    expect(fakeApprovalRepo.respond).not.toHaveBeenCalled();
    expect(fakeFeedbackRepo.create).not.toHaveBeenCalled();
    expect(fakeMempalaceRepo.createEpisode).not.toHaveBeenCalled();
    expect(fakeOauthRepo.getToken).not.toHaveBeenCalled();
    expect(fakePolicyGetAll).not.toHaveBeenCalled();
    expect(fakeBarrierRepo.reserve).not.toHaveBeenCalled();
    expect(fakeExplanationRepo.save).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.route).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.prepareExecution).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executePrepared).not.toHaveBeenCalled();
  });

  it('fails closed on a hostile stored action without invoking its accessor', async () => {
    const getter = vi.fn(() => 'archive_email');
    const candidateAction = Object.defineProperty({}, 'actionType', {
      enumerable: true,
      get: getter,
    });
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: candidateAction,
      status: 'pending',
    });

    const response = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'GMAIL_ARCHIVE_APPROVAL_INVALID_STATE' });
    expect(getter).not.toHaveBeenCalled();
    expect(fakeApprovalRepo.respond).not.toHaveBeenCalled();
    expect(fakeOauthRepo.getToken).not.toHaveBeenCalled();
    expect(fakeBarrierRepo.reserve).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.route).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
  });

  it('approve → mempalaceRepository.createEpisode is called with utility 0.9', async () => {
    const app = buildApp();
    await postJson(app, '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });
    expect(fakeMempalaceRepo.createEpisode).toHaveBeenCalledTimes(1);
    const call = fakeMempalaceRepo.createEpisode.mock.calls[0]![0];
    expect(call.userId).toBe(USER_ID);
    expect(call.actionTaken).toBe('label_email');
    expect(call.feedbackType).toBe('approve');
    expect(call.utilityScore).toBe(0.9);
    expect(call.decisionId).toBe('dec-1');
    expect(call.domain).toBe('email');
    expect(call.situationType).toBe('email_triage');
    expect(call.situationSummary).toBe('label newsletter from sender X');
  });

  it('reject → mempalaceRepository.createEpisode is called with utility 0.0', async () => {
    fakeApprovalRepo.respond.mockResolvedValue({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: {
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
        actionType: 'label_email',
        description: 'Label',
        domain: 'email',
        parameters: {},
        reversible: true,
      },
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
    expect(payload['actionType']).toBe('label_email');
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
    expect(call.situationSummary).toMatch(/approved.*label_email|label_email/);
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

  it('binds an edited draft conversion and its fresh irreversible risk to admission and dispatch', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'draft_email',
      description: 'Draft reply',
      domain: 'email',
      parameters: { to: 'friend@example.test', draftBody: 'old draft' },
      estimatedCostCents: 0,
      costZeroIntent: 'verified_zero',
      reversible: true,
      confidence: 'high',
      reasoning: 'draft for review',
      provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
      confirmation_level: 'single',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'approved',
      responded_at: new Date(),
      confirmation_level: 'single',
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
      editedBody: 'send exactly this body',
    });

    expect(res.status).toBe(200);
    const admission = fakeExecutionAdmissionRepo.admitApprovalExecution.mock.calls[0]![0];
    expect(admission).toMatchObject({
      sourceRiskSnapshot: { reasoning: 'test assessment' },
      actionSnapshot: {
        actionType: 'send_reply',
        reversible: false,
        parameters: {
          to: 'friend@example.test',
          draftBody: expect.stringContaining('send exactly this body'),
        },
      },
      outcomeSnapshot: {
        selectedAction: { actionType: 'send_reply', reversible: false },
        autoExecute: true,
        requiresApproval: false,
      },
      preEffectExplanation: expect.objectContaining({
        whatHappened: expect.stringContaining('exact user-approved action'),
      }),
    });
    expect(admission.riskSnapshot).not.toEqual(admission.sourceRiskSnapshot);
    const [executedAction, executedRisk] = fakeExecutionRouter.executeWithRouting.mock.calls[0]!;
    expect(executedAction).toMatchObject({
      actionType: 'send_reply',
      reversible: false,
      parameters: {
        draftBody: expect.stringContaining('send exactly this body'),
        executionPlanId: '44444444-4444-4444-8444-444444444444',
      },
    });
    expect(executedRisk).toEqual(admission.riskSnapshot);
  });

  it('rechecks current pause authority after an edited draft becomes an irreversible send', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'draft_email',
      description: 'Draft reply',
      domain: 'email',
      parameters: { to: 'outside@example.test', draftBody: 'old' },
      estimatedCostCents: 0,
      reversible: true,
      confidence: 'high',
      reasoning: 'inbound request',
      provenance: 'untrusted_external',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
      confirmation_level: 'single',
    });
    fakeUserRepo.findById.mockResolvedValue({
      id: USER_ID,
      trust_tier: 'moderate_autonomy',
      autonomy_settings: { paused: true },
      ironclaw_channel: 'skytwin',
      execution_authority_revision: 'authority-revision-paused',
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
      editedBody: 'send this externally',
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Action blocked by current policy.',
      reason: expect.stringMatching(/paused by user/i),
    });
    expect(fakeApprovalRepo.respond).not.toHaveBeenCalled();
    expect(fakeExecutionAdmissionRepo.admitApprovalExecution).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
  });

  it('leaves a single-confirmation approval pending when exact preparation now requires dual confirmation', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'delete_account',
      description: 'Delete the account',
      domain: 'account',
      parameters: { accountId: 'acct-1' },
      estimatedCostCents: 0,
      costZeroIntent: 'verified_zero',
      reversible: false,
      confidence: 'high',
      reasoning: 'Stored request requires fresh classification.',
      provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
      confirmation_level: 'single',
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'confirmation_level_changed' });
    expect(fakeExecutionRouter.prepareExecution).toHaveBeenCalledTimes(1);
    expect(fakeApprovalRepo.respond).not.toHaveBeenCalled();
    expect(fakeFeedbackRepo.create).not.toHaveBeenCalled();
    expect(fakeExecutionAdmissionRepo.admitApprovalExecution).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executePrepared).not.toHaveBeenCalled();
  });

  it('reports a known blocked result when policy changes after approval but before admission', async () => {
    const storedAction = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
      actionType: 'create_task',
      description: 'Create task from memory',
      domain: 'tasks',
      parameters: {
        opportunityId: '11111111-1111-1111-1111-111111111111',
        summary: 'Prepared task',
      },
      reversible: true,
      estimatedCostCents: 0,
      confidence: 'high',
      reasoning: 'Prepared memory action.',
      provenance: 'user_originated',
    };
    fakeApprovalRepo.findById.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'pending',
      confirmation_level: 'single',
    });
    fakeApprovalRepo.respond.mockResolvedValueOnce({
      id: 'app-1',
      user_id: USER_ID,
      decision_id: 'dec-1',
      candidate_action: storedAction,
      status: 'approved',
      responded_at: new Date(),
    });
    fakeUserRepo.findById
      .mockResolvedValueOnce({
        id: USER_ID,
        trust_tier: 'moderate_autonomy',
        autonomy_settings: {},
        ironclaw_channel: 'skytwin',
        execution_authority_revision: 'authority-revision-1',
      })
      .mockResolvedValueOnce({
        id: USER_ID,
        trust_tier: 'moderate_autonomy',
        autonomy_settings: { paused: true },
        ironclaw_channel: 'skytwin',
        execution_authority_revision: 'authority-revision-2',
      });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'blocked',
        error: 'Execution is paused by current user or operator policy.',
      },
    });
    expect(fakeApprovalRepo.respond).toHaveBeenCalledOnce();
    expect(fakeExecutionAdmissionRepo.admitApprovalExecution).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executePrepared).not.toHaveBeenCalled();
    expect(fakeExecutionAdmissionRepo.recordPolicyDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'approval',
        approvalId: 'app-1',
        adapterName: 'direct',
        riskSnapshot: expect.objectContaining({
          actionId: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
        }),
        policySnapshot: expect.objectContaining({
          allowed: false,
          dispatchDenied: true,
        }),
      }),
    );
    expect(fakeMemoryActionOpportunityRepo.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'blocked_by_policy',
        policyReason: 'Execution is paused by current user or operator policy.',
      }),
    );
  });

  it('refuses dispatch if admitted canonical parameters are tampered before the final fence', async () => {
    fakeExecutionAdmissionRepo.admitApprovalExecution.mockImplementationOnce(async (input) => {
      const snapshot = input.actionSnapshot as {
        parameters: Record<string, unknown>;
      };
      snapshot.parameters['target'] = 'tampered-after-admission';
      return {
        created: true,
        barrier: {
          id: '55555555-5555-4555-8555-555555555555',
          status: 'in_progress',
          observed_result: {},
          updated_at: new Date('2026-09-13T00:00:00.000Z'),
        },
        plan: { id: '44444444-4444-4444-8444-444444444444' },
      };
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'failed',
        error: 'Execution authority was revoked before dispatch',
      },
    });
    expect(fakeExecutionAdmissionRepo.isDispatchable).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
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
        nextStep: expect.stringContaining('Reconcile'),
      }),
    );
    expect(markInput).not.toHaveProperty('routeReason');
  });

  it('does not persist an ambiguous approved execution as failed', async () => {
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
    fakeExecutionRouter.executeWithRouting.mockResolvedValueOnce({
      planId: 'adapter-plan-unresolved',
      status: 'running',
      startedAt: new Date(),
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'ambiguous',
        error: 'Execution outcome requires reconciliation',
      },
    });
    expect(fakeExecutionRepo.finalizeAdmittedPlan).not.toHaveBeenCalled();
    expect(fakeMemoryActionOpportunityRepo.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'execution_ambiguous',
        nextStep: expect.stringContaining('Reconcile'),
      }),
    );
  });

  it('preserves a completed result and admitted plan when terminal writes lose their responses', async () => {
    fakeExecutionRouter.executeWithRouting.mockResolvedValueOnce({
      planId: 'adapter-plan-completed',
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      output: { adapter_used: 'direct' },
    });
    fakeExecutionAdmissionRepo.observeTerminal.mockRejectedValueOnce(
      new Error('terminal barrier commit response lost'),
    );
    fakeExecutionRepo.finalizeAdmittedPlan.mockRejectedValueOnce(new Error('execution ledger commit response lost'));

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'completed',
        planId: '44444444-4444-4444-8444-444444444444',
        adapterUsed: 'direct',
      },
    });
    expect(fakeExecutionAdmissionRepo.admitApprovalExecution).toHaveBeenCalledOnce();
    expect(fakeExecutionRepo.finalizeAdmittedPlan).toHaveBeenCalledOnce();
    expect(fakeExecutionRouter.executeWithRouting).toHaveBeenCalledOnce();
  });

  it('preserves an explicit failed result when terminal persistence is unavailable', async () => {
    fakeExecutionRouter.executeWithRouting.mockResolvedValueOnce({
      planId: 'adapter-plan-failed',
      status: 'failed',
      startedAt: new Date(),
      completedAt: new Date(),
      output: { adapter_used: 'direct' },
      error: 'remote rejected',
    });
    fakeExecutionAdmissionRepo.observeTerminal.mockRejectedValueOnce(new Error('terminal store unavailable'));
    fakeExecutionRepo.finalizeAdmittedPlan.mockRejectedValueOnce(new Error('result store unavailable'));

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'failed',
        planId: '44444444-4444-4444-8444-444444444444',
        error: '[redacted:execution-error]',
      },
    });
    expect(fakeExecutionAdmissionRepo.observeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('keeps credentials out of the admitted/API action and redacts echoed adapter evidence', async () => {
    const secret = 'rotated-approval-token';
    fakeExecutionRouter.executeWithRouting.mockImplementationOnce(async (candidate) => {
      expect(candidate.parameters).not.toHaveProperty('accessToken');
      return {
        planId: 'adapter-plan-failed',
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: {
          adapter_used: 'direct',
          access_token: secret,
          metadata: {
            authorization: `Bearer ${secret}`,
            responseUrl: `https://adapter.test/result?access_token=${secret}`,
            body: { echoed: secret },
          },
        },
        error: `remote echoed ${secret}`,
      };
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(fakeExecutionAdmissionRepo.isDispatchable.mock.invocationCallOrder[0]).toBeLessThan(
      fakeExecutionRouter.executeWithRouting.mock.invocationCallOrder[0]!,
    );
    expect(fakeOauthRepo.getToken).not.toHaveBeenCalled();
    const persisted = JSON.stringify({
      barrier: fakeExecutionAdmissionRepo.observeTerminal.mock.calls,
      result: fakeExecutionRepo.finalizeAdmittedPlan.mock.calls,
      response: res.body,
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('?access_token=');
    expect(persisted).not.toContain('echoed');
    expect(persisted).toContain('[redacted:unapproved-evidence]');
    expect(persisted).toContain('[redacted:execution-error]');
  });

  it('delegates final credential resolution to the adapter dispatch boundary', async () => {
    fakeExecutionRouter.executeWithRouting.mockImplementationOnce(async (candidate) => {
      expect(candidate.parameters).not.toHaveProperty('accessToken');
      return {
        planId: 'adapter-plan-completed',
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: { adapter_used: 'direct' },
      };
    });

    await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(fakeOauthRepo.getToken).not.toHaveBeenCalled();
    expect(fakeExecutionRouter.executeWithRouting).toHaveBeenCalledOnce();
  });

  it('does not dispatch when approval admission may have committed before response loss', async () => {
    fakeExecutionAdmissionRepo.admitApprovalExecution.mockRejectedValueOnce(
      new Error('admission commit response lost'),
    );
    fakeExecutionAdmissionRepo.findByScope.mockResolvedValueOnce({
      created: false,
      barrier: { status: 'in_progress' },
      plan: { id: '44444444-4444-4444-8444-444444444444' },
    });

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'ambiguous',
        planId: '44444444-4444-4444-8444-444444444444',
        error: 'Execution outcome requires reconciliation',
      },
    });
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
    expect(fakeExecutionRepo.finalizeAdmittedPlan).not.toHaveBeenCalled();
    expect(fakeExecutionAdmissionRepo.findByScope).toHaveBeenCalledWith(
      USER_ID,
      'approval',
      'app-1',
      expect.objectContaining({
        userId: USER_ID,
        decisionId: 'dec-1',
        actionId: 'aaaaaaaa-bbbb-cccc-dddd-000000000abc',
        steps: [{ type: 'label_email', status: 'pending' }],
      }),
    );
  });

  it('does not dispatch an approved action after its exact owner fence is revoked', async () => {
    fakeExecutionAdmissionRepo.isDispatchable.mockResolvedValueOnce(false);

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'failed',
        planId: '44444444-4444-4444-8444-444444444444',
        error: 'Execution authority was revoked before dispatch',
      },
    });
    expect(fakeExecutionRouter.executeWithRouting).not.toHaveBeenCalled();
    expect(fakeExecutionAdmissionRepo.failBeforeDispatch).toHaveBeenCalledWith({
      admission: expect.objectContaining({ created: true }),
      userId: USER_ID,
      error: 'Execution authority was revoked before router invocation.',
    });
  });

  it('durably records router-proven no-request refusal as failed', async () => {
    fakeExecutionRouter.executeWithRouting.mockRejectedValueOnce(
      new NoRequestExecutionError('request-start authority refused'),
    );

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'failed',
        planId: '44444444-4444-4444-8444-444444444444',
        error: 'Execution was refused before request start',
      },
    });
    expect(fakeExecutionAdmissionRepo.failBeforeDispatch).toHaveBeenCalledWith({
      admission: expect.objectContaining({ created: true }),
      userId: USER_ID,
      error: '[redacted:execution-error]',
    });
    expect(fakeExecutionAdmissionRepo.observeTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ambiguous' }),
    );
  });

  it('lets request-start refuse an approval channel revision changed during a final await', async () => {
    let channelChanged = false;
    fakeUserRepo.findById.mockResolvedValue({
      id: USER_ID,
      trust_tier: 'moderate_autonomy',
      autonomy_settings: {},
      ironclaw_channel: 'old-channel',
      execution_authority_revision: 'old-channel-revision',
    });
    fakeExecutionAdmissionRepo.isDispatchable.mockImplementationOnce(async () => {
      channelChanged = true;
      return true;
    });
    fakeExecutionRouter.executeWithRouting.mockImplementationOnce(
      async (
        action: { parameters: Record<string, unknown> },
        _risk: unknown,
        _userId: string,
        context: { ironclawChannel?: string },
      ) => {
        expect(channelChanged).toBe(true);
        expect(action.parameters['credentialAuthorityRevision']).toBe('old-channel-revision');
        expect(context.ironclawChannel).toBe('old-channel');
        throw new NoRequestExecutionError('channel authority changed before request start');
      },
    );

    const res = await postJson(buildApp(), '/api/approvals/app-1/respond', {
      action: 'approve',
      userId: USER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      execution: {
        status: 'failed',
        error: 'Execution was refused before request start',
      },
    });
    expect(fakeExecutionAdmissionRepo.failBeforeDispatch).toHaveBeenCalledOnce();
    expect(fakeExecutionAdmissionRepo.observeTerminal).not.toHaveBeenCalled();
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
