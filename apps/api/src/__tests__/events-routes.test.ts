import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockInterpret,
  mockEvaluate,
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
  mockSaveRiskAssessment,
  mockPolicyEvaluate,
  mockOauthGet,
  mockPreEffectBarrier,
} = vi.hoisted(() => ({
  mockInterpret: vi.fn(),
  mockEvaluate: vi.fn(),
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
  mockSaveRiskAssessment: vi.fn(),
  mockPolicyEvaluate: vi.fn(),
  mockOauthGet: vi.fn(),
  mockPreEffectBarrier: {
    reserve: vi.fn(),
    markPrepared: vi.fn(),
    claimPrepared: vi.fn(),
    markTerminal: vi.fn(),
    markTerminalWithExplanation: vi.fn(),
  },
}));

vi.mock('@skytwin/decision-engine', () => ({
  SituationInterpreter: vi.fn(function SituationInterpreter() {
    return { interpret: mockInterpret };
  }),
  DecisionMaker: vi.fn(function DecisionMaker() {
    return { evaluate: mockEvaluate };
  }),
  LlmSituationStrategy: vi.fn(),
  LlmCandidateGenerator: vi.fn(),
  FallbackSituationStrategy: vi.fn(),
  FallbackCandidateGenerator: vi.fn(),
  RuleBasedCandidateGenerator: vi.fn(),
  SenderAwareCandidateGenerator: vi.fn(),
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
    return { evaluate: mockPolicyEvaluate };
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
  oauthRepository: { getToken: mockOauthGet },
  executionRepository: mockExecutionRepository,
  userRepository: { findById: vi.fn().mockResolvedValue({ id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', trust_tier: 'observer', ironclaw_channel: 'skytwin' }) },
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([]) },
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
    saveRiskAssessment: mockSaveRiskAssessment,
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
  explanationRepositoryAdapter: { getByDecisionId: vi.fn().mockResolvedValue(null) },
  policyRepositoryAdapter: { getEnabledPolicies: vi.fn().mockResolvedValue([]) },
  preEffectBarrierRepository: mockPreEffectBarrier,
}));

vi.mock('@skytwin/llm-client', () => ({
  LlmClient: vi.fn(),
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
import { AmbiguousExecutionError, EXECUTION_FAILURE_CODES } from '@skytwin/execution-router';

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
      id: '99999999-9999-4999-8999-999999999999',
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
    mockSaveRiskAssessment.mockResolvedValue(undefined);
    mockPolicyEvaluate.mockResolvedValue({
      allowed: true,
      requiresApproval: false,
      reason: 'Allowed by fresh policy',
    });
    mockOauthGet.mockResolvedValue(null);
    mockPreEffectBarrier.reserve.mockResolvedValue({
      created: true,
      row: { id: 'barrier-1', status: 'reserved', effect_result: {} },
    });
    mockPreEffectBarrier.markPrepared.mockResolvedValue({ id: 'barrier-1', status: 'prepared' });
    mockPreEffectBarrier.claimPrepared.mockResolvedValue({ id: 'barrier-1', status: 'in_progress' });
    mockPreEffectBarrier.markTerminal.mockResolvedValue({ id: 'barrier-1', status: 'succeeded' });
    mockPreEffectBarrier.markTerminalWithExplanation.mockResolvedValue({
      id: 'barrier-1', status: 'failed', explanation_id: '99999999-9999-4999-8999-999999999999',
    });
    mockGetExecutionRouter.mockResolvedValue({
      route: vi.fn().mockImplementation(async (_action, risk) => ({
        selectedAdapter: 'Direct',
        modifiedRiskAssessment: risk,
      })),
      prepareExecution: vi.fn().mockImplementation(async (action, route) => ({
        selectedAdapter: route.selectedAdapter,
        routingDecision: route,
        plan: { action: { ...action, parameters: { ...action.parameters, userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' } } },
      })),
      executePrepared: vi.fn().mockResolvedValue({
        planId: 'adapter-plan-1',
        status: 'completed',
        output: { secret: 'must-not-persist' },
      }),
    });
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

    it('never replays a previous auto-execute outcome with no known execution result', async () => {
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
        result: null,
      });

      const res = await request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        source: 'gmail',
        type: 'email',
      });

      expect(res.status).toBe(200);
      const body = res.body as { reIngested?: boolean; execution?: { status: string; planId: string } };
      expect(body.reIngested).toBe(true);
      expect(body.execution).toEqual({ status: 'unknown', planId: 'plan-prev' });
      expect(mockEvaluate).not.toHaveBeenCalled();
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

  it('marks post-dispatch uncertainty terminal unknown with only a public code', async () => {
    const defaultRouter = await mockGetExecutionRouter();
    defaultRouter.executePrepared.mockRejectedValue(
      new AmbiguousExecutionError('Direct', new Error('SECRET_PROVIDER_RESPONSE')),
    );

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockExecutionRepository.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1',
      eventType: 'plan_failed',
      payload: { code: EXECUTION_FAILURE_CODES.dispatchAmbiguous },
    }));
    expect(mockExecutionRepository.updatePlanStatus).toHaveBeenCalledWith('plan-1', 'failed');
    expect(mockExecutionRepository.createResult).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1',
      success: false,
      error: EXECUTION_FAILURE_CODES.dispatchAmbiguous,
    }));
    const body = res.body as { execution: { status: string; planId: string } };
    expect(body.execution).toMatchObject({ status: 'unknown', planId: 'plan-1' });
    expect(JSON.stringify(mockExecutionRepository.createEvent.mock.calls)).not.toContain('SECRET_PROVIDER_RESPONSE');
    expect(JSON.stringify(mockSseManager.emit.mock.calls)).not.toContain('SECRET_PROVIDER_RESPONSE');
  });

  it('rechecks fresh policy after routing and never dispatches when it changes', async () => {
    mockPolicyEvaluate.mockResolvedValue({
      allowed: false,
      requiresApproval: false,
      reason: 'Fresh policy denied this action',
    });
    const executionRouter = await mockGetExecutionRouter();

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(executionRouter.executePrepared).not.toHaveBeenCalled();
    expect(mockPreEffectBarrier.markPrepared).toHaveBeenCalledOnce();
    expect(mockPreEffectBarrier.markPrepared).toHaveBeenCalledWith(expect.objectContaining({
      explanationId: '99999999-9999-4999-8999-999999999999',
    }));
    expect(mockPreEffectBarrier.markTerminal).toHaveBeenCalledWith(
      'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      'barrier-1',
      'blocked',
      expect.anything(),
      'final_policy_blocked',
    );
  });

  it('allows only one concurrent request to claim and dispatch the same event effect', async () => {
    mockPreEffectBarrier.reserve
      .mockResolvedValueOnce({ created: true, row: { id: 'barrier-1', status: 'reserved', effect_result: {} } })
      .mockResolvedValueOnce({ created: false, row: { id: 'barrier-1', status: 'in_progress', effect_result: {} } });
    const executionRouter = await mockGetExecutionRouter();

    const responses = await Promise.all([
      request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
      }),
      request(buildApp(), 'POST', '/api/events/ingest', {
        userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executionRouter.executePrepared).toHaveBeenCalledTimes(1);
    expect(mockPreEffectBarrier.claimPrepared).toHaveBeenCalledTimes(1);
  });

  it('never persists or streams adapter-controlled result fields', async () => {
    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(mockExecutionRepository.createEvent.mock.calls)).not.toContain('must-not-persist');
    expect(JSON.stringify(mockExecutionRepository.createResult.mock.calls)).not.toContain('must-not-persist');
    expect(JSON.stringify(mockSseManager.emit.mock.calls)).not.toContain('must-not-persist');
  });

  it.each([
    ['token read', async () => {
      mockOauthGet.mockRejectedValueOnce(new Error('SECRET_TOKEN_READ'));
    }],
    ['plan persistence', async () => {
      mockExecutionRepository.createPlan.mockRejectedValueOnce(new Error('SECRET_PLAN_WRITE'));
    }],
    ['route selection', async () => {
      const executionRouter = await mockGetExecutionRouter();
      executionRouter.route.mockRejectedValueOnce(new Error('SECRET_ROUTE'));
    }],
    ['fresh policy', async () => {
      mockPolicyEvaluate.mockRejectedValueOnce(new Error('SECRET_POLICY'));
    }],
  ])('terminalizes a pre-dispatch %s failure only with its owned explanation', async (
    _failure,
    inject,
  ) => {
    await inject();

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      source: 'test',
      type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockPreEffectBarrier.markTerminalWithExplanation).toHaveBeenCalledWith({
      id: 'barrier-1',
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      explanationId: '99999999-9999-4999-8999-999999999999',
      decisionId: 'decision-1',
      actionId: 'action-1',
      status: 'failed',
      effectResult: expect.any(Object),
      failureReason: EXECUTION_FAILURE_CODES.pipelineFailed,
    });
    expect(JSON.stringify(mockPreEffectBarrier.markTerminalWithExplanation.mock.calls))
      .not.toContain('SECRET_');
  });

  it('recovers a final-explanation failure with a persisted deliberate non-action explanation', async () => {
    mockGenerate
      .mockResolvedValueOnce({ id: '11111111-1111-4111-8111-111111111111' })
      .mockRejectedValueOnce(new Error('SECRET_FINAL_EXPLANATION'))
      .mockResolvedValueOnce({ id: '22222222-2222-4222-8222-222222222222' });

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(200);
    expect(mockPreEffectBarrier.markTerminalWithExplanation).toHaveBeenCalledWith(
      expect.objectContaining({
        explanationId: '22222222-2222-4222-8222-222222222222',
        decisionId: 'decision-1',
        actionId: 'action-1',
        status: 'failed',
      }),
    );
  });

  it('leaves the reservation non-terminal when the failure explanation cannot persist', async () => {
    mockOauthGet.mockRejectedValueOnce(new Error('SECRET_TOKEN_READ'));
    mockGenerate
      .mockResolvedValueOnce({ id: '11111111-1111-4111-8111-111111111111' })
      .mockRejectedValueOnce(new Error('SECRET_EXPLANATION_STORE'));

    const res = await request(buildApp(), 'POST', '/api/events/ingest', {
      userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', source: 'test', type: 'calendar_event',
    });

    expect(res.status).toBe(500);
    expect(mockPreEffectBarrier.markTerminalWithExplanation).not.toHaveBeenCalled();
    expect(mockPreEffectBarrier.markTerminal).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'failed', expect.anything(), expect.anything(),
    );
  });
});
