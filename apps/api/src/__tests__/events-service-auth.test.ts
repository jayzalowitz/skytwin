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
      findByTokenHash: vi.fn(),
      runWithRequestContext: vi.fn(),
    },
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

vi.mock('@skytwin/decision-engine', () => ({
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

vi.mock('@skytwin/explanations', () => ({
  ExplanationGenerator: vi.fn(function ExplanationGenerator() {
    return { generate: mocks.generate };
  }),
}));

vi.mock('@skytwin/llm-client', () => ({ LlmClient: vi.fn() }));

vi.mock('@skytwin/db', () => ({
  // sessionAuth
  sessionRepository: {
    findByTokenHash: mocks.findByTokenHash,
    refreshExpiry: vi.fn(),
    touchLastActive: vi.fn(),
  },
  // requestContext
  runWithRequestContext: mocks.runWithRequestContext,
  // events router
  approvalRepository: {
    create: mocks.approvalCreate,
    findByDecisionId: mocks.approvalFindByDecisionId,
  },
  oauthRepository: { getToken: vi.fn().mockResolvedValue(null) },
  executionRepository: {
    createPlan: vi.fn().mockResolvedValue({ id: 'plan-1' }),
    createEvent: vi.fn().mockResolvedValue({}),
    updatePlanStatus: vi.fn().mockResolvedValue({}),
    createResult: vi.fn().mockResolvedValue({}),
    getByDecisionId: vi.fn().mockResolvedValue(null),
  },
  userRepository: {
    findById: vi
      .fn()
      .mockResolvedValue({ id: TEST_USER_ID, trust_tier: 'observer', ironclaw_channel: 'skytwin' }),
  },
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([]) },
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
  },
  explanationRepositoryAdapter: { getByDecisionId: vi.fn().mockResolvedValue(null) },
  policyRepositoryAdapter: {},
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
vi.mock('../execution-setup.js', () => ({ getExecutionRouter: vi.fn() }));
vi.mock('../sse.js', () => ({ sseManager: { emit: vi.fn() } }));

import { createEventsRouter } from '../routes/events.js';
import { sessionAuth } from '../middleware/session-auth.js';
import { requireOwnership } from '../middleware/require-ownership.js';
import { requestContext } from '../middleware/request-context.js';

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
        body: JSON.stringify({ userId: TEST_USER_ID, source: 'gmail', type: 'email_received' }),
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

describe('/api/events/ingest behind the production auth chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['SKYTWIN_SERVICE_TOKEN'] = SERVICE_TOKEN;
    mocks.runWithRequestContext.mockImplementation(
      async (_userId: unknown, fn: () => Promise<unknown>) => fn(),
    );
    mocks.findByTokenHash.mockResolvedValue(null);
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
    mocks.generate.mockResolvedValue({ riskTier: 'low', summary: 'Low risk', overallConfidence: 0.9 });
    mocks.saveDecision.mockImplementation(async (d: unknown) => ({ decision: d, created: true }));
    mocks.saveCandidates.mockResolvedValue([]);
    mocks.saveOutcome.mockImplementation(async (o: unknown) => o);
    mocks.getOutcome.mockResolvedValue(null);
    mocks.approvalFindByDecisionId.mockResolvedValue(null);
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
        fetch(
          `http://127.0.0.1:${addr.port}/api/events/ingest?token=${SERVICE_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: TEST_USER_ID, source: 'gmail', type: 'email_received' }),
          },
        )
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
    expect(mocks.findByTokenHash).toHaveBeenCalled();
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
    settings.get('/:userId', (_req, res) => { res.json({ leaked: true }); });
    app.use('/api/settings', sessionAuth, requireOwnership, settings);

    const status = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') { server.close(); reject(new Error('no port')); return; }
        fetch(`http://127.0.0.1:${addr.port}/api/settings/${TEST_USER_ID}`, {
          headers: { 'X-SkyTwin-Service-Token': SERVICE_TOKEN },
        })
          .then((r) => { server.close(); resolve(r.status); })
          .catch((e) => { server.close(); reject(e); });
      });
    });

    expect(status).toBe(401);
  });
});
