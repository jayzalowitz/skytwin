/**
 * Auth-chain tests for `/api/events/ingest`.
 *
 * WHY THIS FILE EXISTS: `events-routes.test.ts` mounts `createEventsRouter()`
 * BARE. Production mounts it behind `sessionAuth, requireOwnership,
 * requestContext` (apps/api/src/index.ts). That gap is why a packaged desktop
 * build — which runs every child process under `NODE_ENV=production` with the
 * localhost dev bypass off — shipped with the worker POSTing signals and no
 * credential: every ingest 401'd, and no test could see it.
 *
 * These tests mount the REAL chain in the REAL order, with `NODE_ENV=production`
 * and the dev bypass explicitly off, and pin the four cases that matter for the
 * loopback service credential.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// `vi.hoisted` runs before module imports, so `session-auth.ts` computes its
// module-level DEV_AUTH_BYPASS constant against production values, and the
// constants below are usable from the hoisted `vi.mock` factories.
const { savedEnv, mocks, SERVICE_TOKEN, TEST_USER_ID } = vi.hoisted(() => {
  const saved = {
    NODE_ENV: process.env['NODE_ENV'],
    SKYTWIN_DEV_AUTH_BYPASS: process.env['SKYTWIN_DEV_AUTH_BYPASS'],
    SKYTWIN_SERVICE_TOKEN: process.env['SKYTWIN_SERVICE_TOKEN'],
    SKYTWIN_GMAIL_ARCHIVE_ENABLED: process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'],
  };
  process.env['NODE_ENV'] = 'production';
  process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
  process.env['SKYTWIN_SERVICE_TOKEN'] = 'a'.repeat(64);
  return {
    SERVICE_TOKEN: 'a'.repeat(64),
    TEST_USER_ID: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    savedEnv: saved,
    mocks: {
      interpret: vi.fn(),
      evaluate: vi.fn(),
      generate: vi.fn(),
      saveDecision: vi.fn(),
      saveCandidates: vi.fn(),
      saveOutcome: vi.fn(),
      getOutcome: vi.fn(),
      approvalCreate: vi.fn(),
      approvalFindByDecisionId: vi.fn(),
      authenticateAndMaintain: vi.fn(),
      runWithRequestContext: vi.fn(),
      persistEvidence: vi.fn(),
      buildArchiveProposal: vi.fn(),
      persistArchiveProposal: vi.fn(),
      findBySignalId: vi.fn(),
      sseEmit: vi.fn(),
      userFindById: vi.fn(),
      oauthGetToken: vi.fn(),
      executionCreatePlan: vi.fn(),
      executionCreateEvent: vi.fn(),
      executionUpdatePlanStatus: vi.fn(),
      executionCreateResult: vi.fn(),
      executionGetByDecisionId: vi.fn(),
      inferenceCreateMany: vi.fn(),
      resolveUserLlmClient: vi.fn(),
      getMemoryPortForUser: vi.fn(),
      getExecutionRouter: vi.fn(),
      recordMcpActionSpend: vi.fn(),
      buildDraftEmailGenerator: vi.fn(),
      twinGetOrCreateProfile: vi.fn(),
      twinGetRelevantPreferences: vi.fn(),
      twinGetPatterns: vi.fn(),
      twinGetTraits: vi.fn(),
      twinGetTemporalProfile: vi.fn(),
      policyEvaluate: vi.fn(),
      isReceiptComplete: vi.fn(),
    },
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

vi.mock('@skytwin/decision-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skytwin/decision-engine')>();
  return {
    ...actual,
    SituationInterpreter: vi.fn(function SituationInterpreter() {
      return { interpret: mocks.interpret };
    }),
    DecisionMaker: vi.fn(function DecisionMaker() {
      return { evaluate: mocks.evaluate };
    }),
    LlmSituationStrategy: vi.fn(),
    LlmCandidateGenerator: vi.fn(),
    FallbackSituationStrategy: vi.fn(),
    FallbackCandidateGenerator: vi.fn(),
    RuleBasedCandidateGenerator: vi.fn(),
    SenderAwareCandidateGenerator: vi.fn(),
    CompositeCandidateGenerator: vi.fn(),
    gmailArchiveProposalEnabled: () => process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] === 'true',
    buildGmailArchiveProposal: mocks.buildArchiveProposal,
    __realBuildGmailArchiveProposal: actual.buildGmailArchiveProposal,
  };
});

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn(function TwinService() {
    return {
      getOrCreateProfile: mocks.twinGetOrCreateProfile,
      getRelevantPreferences: mocks.twinGetRelevantPreferences,
      getPatterns: mocks.twinGetPatterns,
      getTraits: mocks.twinGetTraits,
      getTemporalProfile: mocks.twinGetTemporalProfile,
    };
  }),
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn(function PolicyEvaluator() {
    return { evaluate: mocks.policyEvaluate };
  }),
}));

vi.mock('@skytwin/explanations', () => ({
  ExplanationGenerator: vi.fn(function ExplanationGenerator() {
    return { generate: mocks.generate };
  }),
}));

vi.mock('@skytwin/llm-client', () => ({ LlmClient: vi.fn() }));

vi.mock('../lib/user-llm-client.js', () => ({
  resolveUserLlmClient: vi.fn().mockResolvedValue({
    state: 'no_provider',
    client: null,
    reason: 'No provider in test',
  }),
}));

vi.mock('@skytwin/db', () => ({
  // sessionAuth
  sessionRepository: {
    authenticateAndMaintain: mocks.authenticateAndMaintain,
    revalidateSourceKeyAuthority: vi.fn().mockResolvedValue({ status: 'inactive' }),
  },
  // requestContext
  runWithRequestContext: mocks.runWithRequestContext,
  // events router
  approvalRepository: {
    create: mocks.approvalCreate,
    findByDecisionId: mocks.approvalFindByDecisionId,
  },
  oauthRepository: { getToken: mocks.oauthGetToken },
  gmailMessageRefRepository: { persistEvidence: mocks.persistEvidence },
  gmailArchiveProposalRepository: { persist: mocks.persistArchiveProposal },
  executionRepository: {
    createPlan: mocks.executionCreatePlan,
    createEvent: mocks.executionCreateEvent,
    updatePlanStatus: mocks.executionUpdatePlanStatus,
    createResult: mocks.executionCreateResult,
    getByDecisionId: mocks.executionGetByDecisionId,
  },
  userRepository: {
    findById: mocks.userFindById,
  },
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([]) },
  inferenceReceiptRepository: {
    isCompleteForDecision: vi.fn().mockResolvedValue(false),
    createManyForUser: mocks.inferenceCreateMany.mockImplementation(async (_u, inputs, completion) => ({
      receipts: inputs,
      continuation: completion.continuation,
    })),
    getContinuationForDecision: vi.fn().mockResolvedValue(null),
    claimExecutionForDecision: vi.fn().mockResolvedValue({
      id: 'plan-1',
      dispatchAuthorityUpdatedAt: new Date(),
    }),
    isExecutionDispatchableForDecision: vi.fn().mockResolvedValue(true),
    markExecutionTerminalForDecision: vi.fn().mockResolvedValue(true),
    markNonEffectForDecision: vi.fn().mockResolvedValue(true),
  },
  reasoningModeRepository: {
    getOrCreateForUser: vi.fn().mockResolvedValue({ mode: 'on_device', requires_confirmation: false }),
  },
  emailLabelRepository: {
    topLabelsForSender: vi.fn().mockResolvedValue([]),
    topLabelsForListId: vi.fn().mockResolvedValue([]),
  },
  mempalaceRepository: { getEpisodes: vi.fn().mockResolvedValue([]) },
  twinRepository: { getProfile: vi.fn().mockResolvedValue(null) },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: {
    saveDecision: mocks.saveDecision,
    saveCandidates: mocks.saveCandidates,
    saveOutcome: mocks.saveOutcome,
    getOutcome: mocks.getOutcome,
    getRiskAssessment: vi.fn().mockResolvedValue(null),
    findBySignalId: mocks.findBySignalId,
  },
  explanationRepositoryAdapter: {
    getByDecisionId: vi.fn().mockResolvedValue(null),
  },
  policyRepositoryAdapter: {},
}));

vi.mock('../workflows/registry.js', () => ({
  WorkflowHandlerRegistry: vi.fn(function WorkflowHandlerRegistry() {
    return { register: vi.fn() };
  }),
}));
vi.mock('../workflows/calendar-conflict.js', () => ({
  processCalendarConflict: vi.fn(),
}));
vi.mock('../workflows/subscription-renewal.js', () => ({
  processSubscriptionRenewal: vi.fn(),
}));
vi.mock('../workflows/grocery-reorder.js', () => ({
  processGroceryReorder: vi.fn(),
}));
vi.mock('../workflows/travel-decision.js', () => ({
  processTravelDecision: vi.fn(),
}));
vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: mocks.getExecutionRouter,
}));
vi.mock('../sse.js', () => ({ sseManager: { emit: mocks.sseEmit } }));
vi.mock('../lib/user-llm-client.js', () => ({
  resolveUserLlmClient: mocks.resolveUserLlmClient,
}));
vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: mocks.getMemoryPortForUser,
}));
vi.mock('../mcp-action-spend.js', () => ({
  recordMcpActionSpend: mocks.recordMcpActionSpend,
}));
vi.mock('../draft-email-setup.js', () => ({
  buildDraftEmailGenerator: mocks.buildDraftEmailGenerator,
}));

import { createEventsRouter } from '../routes/events.js';
import { sessionAuth } from '../middleware/session-auth.js';
import { requireOwnership } from '../middleware/require-ownership.js';
import { requestContext } from '../middleware/request-context.js';
import * as decisionEngineModule from '@skytwin/decision-engine';

const realBuildGmailArchiveProposal = (
  decisionEngineModule as unknown as {
    __realBuildGmailArchiveProposal: typeof decisionEngineModule.buildGmailArchiveProposal;
  }
).__realBuildGmailArchiveProposal;

/**
 * Mirrors `app.use('/api/events', sessionAuth, requireOwnership, requestContext,
 * createEventsRouter())` from apps/api/src/index.ts.
 *
 * `trust proxy` is enabled so a test can present a non-loopback client address
 * via `X-Forwarded-For` — the same mechanism a real reverse-proxied deployment
 * uses, exercising the real `req.ip` getter rather than a stubbed one.
 */
function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/events', sessionAuth, requireOwnership, requestContext, createEventsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function post(
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}/api/events/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(
          body ?? {
            userId: TEST_USER_ID,
            source: 'gmail',
            type: 'email_received',
            signalId: 'sig-account-message-1',
            connectorEvidence: {
              kind: 'gmail_message',
              connectorAccountId: '11111111-1111-4111-8111-111111111111',
              provider: 'google',
              providerMessageId: 'message-1',
              providerThreadId: 'thread-1',
              authoringTier: 'inbox_personal',
              observedInInbox: true,
              observedAt: '2026-09-11T12:00:00.000Z',
              messageTimestamp: '2026-09-11T11:00:00.000Z',
            },
          },
        ),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

function proposalPersistenceResult(created: boolean): Record<string, unknown> {
  return {
    ok: true,
    created,
    proposal: {
      decision: {
        id: '55555555-5555-4555-8555-555555555555',
        situation_type: 'email_triage',
        domain: 'email',
        urgency: 'medium',
      },
      candidate: {
        id: '44444444-4444-4444-8444-444444444444',
        action_type: 'archive_email',
        description: 'Propose moving this message out of the Inbox.',
        risk_assessment: { overallTier: 'moderate' },
      },
      outcome: {
        explanation: 'Review is required.',
        confidence: 0.6,
      },
      explanation: {
        what_happened: 'Prepared a review-only Inbox archive proposal; no external action was attempted.',
      },
      approval: {
        id: '88888888-8888-4888-8888-888888888888',
        status: 'pending',
      },
      barrier: {},
      receipt: {},
      revisions: [],
    },
  };
}

function expectNoOrdinaryPipelineCalls(): void {
  for (const mock of [
    mocks.interpret,
    mocks.evaluate,
    mocks.generate,
    mocks.saveDecision,
    mocks.saveCandidates,
    mocks.saveOutcome,
    mocks.approvalCreate,
    mocks.approvalFindByDecisionId,
    mocks.userFindById,
    mocks.oauthGetToken,
    mocks.executionCreatePlan,
    mocks.executionCreateEvent,
    mocks.executionUpdatePlanStatus,
    mocks.executionCreateResult,
    mocks.executionGetByDecisionId,
    mocks.inferenceCreateMany,
    mocks.resolveUserLlmClient,
    mocks.getMemoryPortForUser,
    mocks.getExecutionRouter,
    mocks.recordMcpActionSpend,
    mocks.buildDraftEmailGenerator,
    mocks.twinGetOrCreateProfile,
    mocks.twinGetRelevantPreferences,
    mocks.twinGetPatterns,
    mocks.twinGetTraits,
    mocks.twinGetTemporalProfile,
    mocks.policyEvaluate,
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe('/api/events/ingest behind the production auth chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['SKYTWIN_SERVICE_TOKEN'] = SERVICE_TOKEN;
    delete process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'];
    mocks.runWithRequestContext.mockImplementation(async (_userId: unknown, fn: () => Promise<unknown>) => fn());
    mocks.authenticateAndMaintain.mockResolvedValue({ status: 'inactive' });
    mocks.interpret.mockResolvedValue({
      id: 'decision-1',
      situationType: 'email_triage',
      domain: 'email',
      urgency: 'low',
      summary: 'Inbound mail',
    });
    mocks.evaluate.mockResolvedValue({
      autoExecute: false,
      requiresApproval: false,
      reasoning: 'Awareness only',
      selectedAction: null,
      allCandidates: [],
    });
    mocks.generate.mockResolvedValue({
      riskTier: 'low',
      summary: 'Low risk',
      overallConfidence: 0.9,
    });
    mocks.saveDecision.mockImplementation(async (d: unknown) => ({
      decision: d,
      created: true,
    }));
    mocks.saveCandidates.mockResolvedValue([]);
    mocks.saveOutcome.mockImplementation(async (o: unknown) => o);
    mocks.getOutcome.mockResolvedValue(null);
    mocks.approvalFindByDecisionId.mockResolvedValue(null);
    mocks.findBySignalId.mockResolvedValue(null);
    mocks.isReceiptComplete.mockResolvedValue(false);
    mocks.userFindById.mockResolvedValue({
      id: TEST_USER_ID,
      trust_tier: 'observer',
      ironclaw_channel: 'skytwin',
    });
    mocks.oauthGetToken.mockResolvedValue(null);
    mocks.executionCreatePlan.mockResolvedValue({ id: 'plan-1' });
    mocks.executionCreateEvent.mockResolvedValue({});
    mocks.executionUpdatePlanStatus.mockResolvedValue({});
    mocks.executionCreateResult.mockResolvedValue({});
    mocks.executionGetByDecisionId.mockResolvedValue(null);
    mocks.inferenceCreateMany.mockImplementation(
      async (_userId: unknown, inputs: unknown[], completion: { continuation: unknown }) => ({
        receipts: inputs,
        continuation: completion.continuation,
      }),
    );
    mocks.resolveUserLlmClient.mockResolvedValue({ state: 'unavailable' });
    mocks.getMemoryPortForUser.mockResolvedValue({
      port: { recordSignal: vi.fn().mockResolvedValue(undefined) },
    });
    mocks.buildDraftEmailGenerator.mockResolvedValue(null);
    mocks.twinGetOrCreateProfile.mockResolvedValue({});
    mocks.twinGetRelevantPreferences.mockResolvedValue([]);
    mocks.twinGetPatterns.mockResolvedValue([]);
    mocks.twinGetTraits.mockResolvedValue([]);
    mocks.twinGetTemporalProfile.mockResolvedValue({});
    mocks.buildArchiveProposal.mockImplementation(realBuildGmailArchiveProposal);
    mocks.persistArchiveProposal.mockResolvedValue(proposalPersistenceResult(true));
    mocks.persistEvidence.mockResolvedValue({
      ok: true,
      created: true,
      messageRef: {
        id: '22222222-2222-4222-8222-222222222222',
        authoring_tier: 'inbox_automated',
        first_observed_at: new Date('2026-09-11T12:00:00.000Z'),
        last_observed_inbox: true,
      },
      signal: {
        id: '33333333-3333-4333-8333-333333333333',
        type: 'email_received',
        source_signal_id: 'sig-account-message-conflict',
        timestamp: new Date('2026-09-11T11:00:00.000Z'),
        data: {
          authoringTier: 'inbox_automated',
          receivedAt: '2026-09-11T11:00:00.000Z',
          observedAt: '2026-09-11T12:00:00.000Z',
        },
      },
    });
  });

  it('rejects an unauthenticated loopback POST (the packaged-build regression)', async () => {
    // This is exactly what the worker used to send: Content-Type only.
    const res = await post({});
    expect(res.status).toBe(401);
    // Nothing reached the pipeline.
    expect(mocks.interpret).not.toHaveBeenCalled();
  });

  it('accepts the correct SKYTWIN_SERVICE_TOKEN from loopback', async () => {
    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(mocks.interpret).toHaveBeenCalledTimes(1);
  });

  it('uses the service envelope tier/time and removes provider ids before interpretation', async () => {
    const res = await post(
      { 'X-SkyTwin-Service-Token': SERVICE_TOKEN },
      {
        userId: TEST_USER_ID,
        source: 'gmail',
        type: 'email_received',
        signalId: 'sig-account-message-conflict',
        authoringTier: 'user_sent_originated',
        receivedAt: '2030-01-01T00:00:00.000Z',
        messageId: 'flat-message-id',
        emailId: 'flat-email-id',
        threadId: 'flat-thread-id',
        connectorEvidence: {
          kind: 'gmail_message',
          connectorAccountId: '11111111-1111-4111-8111-111111111111',
          provider: 'google',
          providerMessageId: 'provider-message-id',
          providerThreadId: 'provider-thread-id',
          authoringTier: 'inbox_automated',
          observedInInbox: true,
          observedAt: '2026-09-11T12:00:00.000Z',
          messageTimestamp: '2026-09-11T11:00:00.000Z',
        },
      },
    );

    expect(res.status).toBe(200);
    const persisted = mocks.persistEvidence.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted['authoringTier']).toBe('inbox_automated');
    expect(persisted['observedAt']).toEqual(new Date('2026-09-11T12:00:00.000Z'));
    expect(persisted['signalTimestamp']).toEqual(new Date('2026-09-11T11:00:00.000Z'));
    expect(persisted['signalData']).toMatchObject({
      authoringTier: 'inbox_automated',
      receivedAt: '2026-09-11T11:00:00.000Z',
      observedAt: '2026-09-11T12:00:00.000Z',
    });
    const interpreted = mocks.interpret.mock.calls[0]![0] as Record<string, unknown>;
    expect(interpreted).toMatchObject({
      authoringTier: 'inbox_automated',
      receivedAt: '2026-09-11T11:00:00.000Z',
      observedAt: '2026-09-11T12:00:00.000Z',
      messageRefId: '22222222-2222-4222-8222-222222222222',
      signalId: 'sig-account-message-conflict',
    });
    expect(interpreted).not.toHaveProperty('messageId');
    expect(interpreted).not.toHaveProperty('emailId');
    expect(interpreted).not.toHaveProperty('threadId');
  });

  it.each(['TRUE', '1', 'on', ' true '])('keeps the proposal path off for non-exact flag value %s', async (value) => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = value;
    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(200);
    expect(mocks.interpret).toHaveBeenCalledTimes(1);
    expect(mocks.buildArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.persistArchiveProposal).not.toHaveBeenCalled();
  });

  it('persists and returns one review-only proposal before the ordinary pipeline', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision: {
        id: '55555555-5555-4555-8555-555555555555',
        situationType: 'email_triage',
        urgency: 'medium',
      },
      outcome: {
        selectedAction: { actionType: 'archive_email' },
        autoExecute: false,
        requiresApproval: true,
      },
      execution: null,
      approval: {
        id: '88888888-8888-4888-8888-888888888888',
        status: 'pending',
      },
    });
    expect(res.body).not.toHaveProperty('reIngested');
    expect(mocks.persistArchiveProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TEST_USER_ID,
        connectorAccountId: '11111111-1111-4111-8111-111111111111',
        messageRefId: '22222222-2222-4222-8222-222222222222',
        signalId: '33333333-3333-4333-8333-333333333333',
        proposal: expect.any(Object),
      }),
    );
    expect(mocks.buildArchiveProposal).toHaveBeenCalledWith({
      decision: expect.objectContaining({
        situationType: 'email_triage',
        domain: 'email',
        provenance: 'untrusted_external',
        rawData: {
          messageRefId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    });
    const persistenceInput = mocks.persistArchiveProposal.mock.calls[0]![0] as Record<string, unknown>;
    const builderResult = mocks.buildArchiveProposal.mock.results[0]!.value as {
      proposal: {
        candidate: { id: string };
        riskAssessment: {
          actionId: string;
          dimensions: Record<string, unknown>;
        };
      };
    };
    expect(persistenceInput['proposal']).toBe(builderResult.proposal);
    expect(builderResult.proposal.riskAssessment.actionId).toBe(builderResult.proposal.candidate.id);
    expect(Object.keys(builderResult.proposal.riskAssessment.dimensions)).toHaveLength(6);
    expect(mocks.findBySignalId).toHaveBeenCalledWith(TEST_USER_ID, 'sig-account-message-conflict');
    expect(mocks.sseEmit).toHaveBeenCalledTimes(1);
    expect(mocks.sseEmit).toHaveBeenCalledWith(
      TEST_USER_ID,
      'approval:new',
      expect.objectContaining({
        id: '88888888-8888-4888-8888-888888888888',
        decisionId: '55555555-5555-4555-8555-555555555555',
      }),
    );
    expectNoOrdinaryPipelineCalls();
  });

  it('returns an immutable replay without emitting another approval event', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.persistArchiveProposal.mockResolvedValue(proposalPersistenceResult(false));

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reIngested: true });
    expect(mocks.sseEmit).not.toHaveBeenCalled();
    expectNoOrdinaryPipelineCalls();
  });

  it('does not propose an archive when repository truth says the message is outside Inbox', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const evidence = await mocks.persistEvidence();
    mocks.persistEvidence.mockResolvedValue({
      ...evidence,
      messageRef: { ...evidence.messageRef, last_observed_inbox: false },
    });

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(200);
    expect(mocks.buildArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.persistArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.interpret).toHaveBeenCalledTimes(1);
  });

  it('preserves the evidence conflict response without constructing a proposal', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.persistEvidence.mockResolvedValue({
      ok: false,
      error: 'source_binding_conflict',
    });

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'source_binding_conflict' });
    expect(mocks.buildArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.persistArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.sseEmit).not.toHaveBeenCalled();
    expectNoOrdinaryPipelineCalls();
  });

  it('fails internally on an impossible builder rejection without falling through', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.buildArchiveProposal.mockReturnValue({
      ok: false,
      error: 'invalid_decision',
    });

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(500);
    expect(mocks.persistArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.sseEmit).not.toHaveBeenCalled();
    expectNoOrdinaryPipelineCalls();
  });

  it.each(['evidence_not_found', 'idempotency_conflict'] as const)(
    'returns 409 for persistence failure %s without falling through',
    async (error) => {
      process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
      mocks.persistArchiveProposal.mockResolvedValue({ ok: false, error });

      const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error });
      expect(mocks.sseEmit).not.toHaveBeenCalled();
      expectNoOrdinaryPipelineCalls();
    },
  );

  it('treats server-constructed persistence rejection as an internal error', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.persistArchiveProposal.mockResolvedValue({
      ok: false,
      error: 'invalid_input',
    });

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(500);
    expect(mocks.sseEmit).not.toHaveBeenCalled();
    expectNoOrdinaryPipelineCalls();
  });

  it('does not emit or fall through when atomic persistence throws', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.persistArchiveProposal.mockRejectedValue(new Error('receipt append failed'));

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(500);
    expect(mocks.sseEmit).not.toHaveBeenCalled();
    expectNoOrdinaryPipelineCalls();
  });

  it('does not send an incomplete gated proposal through the ordinary path after disabling the gate', async () => {
    mocks.findBySignalId.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '99999999-9999-4999-8999-999999999999',
      situationType: 'email_triage',
      domain: 'email',
      urgency: 'low',
      summary: 'Legacy incomplete decision',
      rawData: { signalId: 'sig-account-message-conflict' },
      interpretedAt: new Date('2026-09-11T11:00:00.000Z'),
    });

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(409);
    expect(mocks.findBySignalId.mock.calls.map((call) => call[1])).toEqual([
      'sig-account-message-conflict',
      '33333333-3333-4333-8333-333333333333',
    ]);
    expect(mocks.interpret).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy decision lacks a durable continuation', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.findBySignalId.mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      situationType: 'email_triage',
      domain: 'email',
      urgency: 'low',
      summary: 'Prior Gmail decision',
      rawData: {
        signalId: 'sig-account-message-conflict',
        messageRefId: '22222222-2222-4222-8222-222222222222',
      },
      interpretedAt: new Date('2026-09-11T11:00:00.000Z'),
    });
    // A legacy completeness bit is not enough to reconstruct the atomic
    // receipt/continuation snapshot required by the current ingest contract.
    mocks.isReceiptComplete.mockResolvedValue(true);

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INFERENCE_RECEIPT_RECOVERY_REQUIRED',
      decisionId: '99999999-9999-4999-8999-999999999999',
    });
    expect(mocks.buildArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.persistArchiveProposal).not.toHaveBeenCalled();
    expect(mocks.sseEmit).not.toHaveBeenCalled();
    expectNoOrdinaryPipelineCalls();
  });

  it('does not replay a legacy response bound to another linked account', async () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    mocks.findBySignalId.mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      situationType: 'email_triage',
      domain: 'email',
      urgency: 'low',
      summary: 'A different account decision',
      rawData: {
        signalId: 'sig-account-message-conflict',
        messageRefId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      interpretedAt: new Date('2026-09-11T11:00:00.000Z'),
    });

    const res = await post({ 'X-SkyTwin-Service-Token': SERVICE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision: { id: '55555555-5555-4555-8555-555555555555' },
      approval: { status: 'pending' },
    });
    expect(res.body).not.toHaveProperty('reIngested');
    expect(mocks.getOutcome).not.toHaveBeenCalled();
    expect(mocks.isReceiptComplete).not.toHaveBeenCalled();
    expect(mocks.persistArchiveProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorAccountId: '11111111-1111-4111-8111-111111111111',
        messageRefId: '22222222-2222-4222-8222-222222222222',
        signalId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    expectNoOrdinaryPipelineCalls();
  });

  it('rejects a WRONG token from loopback', async () => {
    const res = await post({ 'X-SkyTwin-Service-Token': 'b'.repeat(64) });
    expect(res.status).toBe(401);
    expect(mocks.interpret).not.toHaveBeenCalled();
  });

  it('rejects a token of a different LENGTH without throwing (timingSafeEqual guard)', async () => {
    // `crypto.timingSafeEqual` throws on unequal buffer lengths; a missing
    // length guard would surface as a 500 from the error handler, not a 401.
    const res = await post({ 'X-SkyTwin-Service-Token': 'short' });
    expect(res.status).toBe(401);
  });

  it('ignores X-Forwarded-For for the service credential (reads the raw socket)', async () => {
    // The service path deliberately uses `req.socket.remoteAddress`, not
    // `req.ip`. `req.ip` honours `trust proxy` (the API sets it from
    // TRUST_PROXY_HOPS), so a spoofed `X-Forwarded-For: 127.0.0.1` from a
    // genuinely remote client could otherwise satisfy the loopback check.
    // Reading the socket makes the header irrelevant in both directions —
    // this request IS from loopback, so a spoofed remote XFF must not change
    // the verdict. Supertest can only connect over loopback, so the
    // genuinely-remote-socket case is covered by inspection, not by this test.
    const res = await post({
      'X-SkyTwin-Service-Token': SERVICE_TOKEN,
      'X-Forwarded-For': '203.0.113.7',
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('does not accept the service token via the ?token= SSE query fallback', async () => {
    // The query fallback exists for EventSource, which cannot set headers.
    // The service credential is header-only so it never lands in a URL / log.
    const app = buildApp();
    const res = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          reject(new Error('no port'));
          return;
        }
        fetch(`http://127.0.0.1:${addr.port}/api/events/ingest?token=${SERVICE_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: TEST_USER_ID,
            source: 'gmail',
            type: 'email_received',
          }),
        })
          .then((r) => {
            server.close();
            resolve(r.status);
          })
          .catch((e) => {
            server.close();
            reject(e);
          });
      });
    });
    // Falls through to the session lookup, which finds nothing.
    expect(res).toBe(401);
    expect(mocks.authenticateAndMaintain).toHaveBeenCalled();
  });

  it('rejects everything when SKYTWIN_SERVICE_TOKEN is unset (no token means no service auth)', async () => {
    delete process.env['SKYTWIN_SERVICE_TOKEN'];
    const res = await post({ 'X-SkyTwin-Service-Token': '' });
    expect(res.status).toBe(401);
    expect(mocks.interpret).not.toHaveBeenCalled();
  });
  // ── codex review [P1] / [P2] ──────────────────────────────────────────

  it('does NOT accept the service credential on the Authorization header', async () => {
    // apps/web proxies dashboard traffic to the API and forwards
    // `Authorization` verbatim over a fresh localhost connection. If the
    // service credential rode on that header, a remote caller could POST it to
    // the dashboard port and the API would see a loopback source. Keeping the
    // credential on a header the proxy does not forward closes that path.
    const res = await post({ Authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(res.status).toBe(401);
    expect(mocks.interpret).not.toHaveBeenCalled();
  });

  it('does NOT grant access to non-ingest routes (no cross-user ownership bypass)', async () => {
    // `requireOwnership` skips its check for a service-authenticated request,
    // and it guards ~33 routers. Without a route allowlist the ingest
    // credential would be a cross-user read/write capability for any local
    // process that can read the token file.
    //
    // Mount a second ownership-guarded router shaped like a real one
    // (`/api/settings/:userId`) so this exercises the allowlist rather than
    // just hitting a 404.
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    const settings = express.Router();
    settings.get('/:userId', (_req, res) => {
      res.json({ leaked: true });
    });
    app.use('/api/settings', sessionAuth, requireOwnership, settings);

    const status = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          reject(new Error('no port'));
          return;
        }
        fetch(`http://127.0.0.1:${addr.port}/api/settings/${TEST_USER_ID}`, {
          headers: { 'X-SkyTwin-Service-Token': SERVICE_TOKEN },
        })
          .then((r) => {
            server.close();
            resolve(r.status);
          })
          .catch((e) => {
            server.close();
            reject(e);
          });
      });
    });

    expect(status).toBe(401);
  });
});
