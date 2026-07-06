import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules — vi.hoisted ensures mocks are available when vi.mock factories
// execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockMcpServerRepository,
  mockAppSuggestionRepository,
  mockExecutionRepository,
  mockGetExecutionRouter,
  mockRouterRollback,
  mockQuery,
} = vi.hoisted(() => ({
  mockMcpServerRepository: {
    getById: vi.fn(),
    getByUserAndRegistry: vi.fn(),
    listForUser: vi.fn(),
    listActive: vi.fn(),
    markDormant: vi.fn(),
    markPaused: vi.fn(),
    markActive: vi.fn(),
    softDelete: vi.fn(),
    updateLastActive: vi.fn(),
    getInactiveSince: vi.fn(),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockExecutionRepository: {
    getRollbackTargetsByServer: vi.fn(),
  },
  mockGetExecutionRouter: vi.fn(),
  mockRouterRollback: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  executionRepository: mockExecutionRepository,
  query: mockQuery,
}));

// #324: the regret endpoint resolves the execution router to dispatch
// IronClawAdapter.rollback(planId). Mock it so tests assert the wiring without
// constructing real adapters.
vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: mockGetExecutionRouter,
}));

// Mock RegistryClient so tests don't hit the filesystem during vitest
vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn(function RegistryClient() {
    return {
    search: vi.fn().mockResolvedValue([
      {
        id: '@modelcontextprotocol/server-filesystem',
        displayName: 'Filesystem',
        transport: 'stdio',
        oauthProvider: null,
        category: 'developer',
        description: 'Read and write files.',
        keywords: ['files', 'filesystem'],
        verified: 'anthropic',
      },
    ]),
    getAll: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { createCapabilitiesRouter } from '../routes/capabilities.js';

// ---------------------------------------------------------------------------
// UUID constants used across fixtures and helpers
// ---------------------------------------------------------------------------

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const USER_ID = 'ffffffff-eeee-dddd-cccc-000000000001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  // Inject a synthetic req.user so ownership checks inside the route resolve.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/api/capabilities', createCapabilitiesRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const options: RequestInit = { method, headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      fetch(url, options)
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMcpServer(overrides: Partial<{
  id: string;
  user_id: string;
  registry_id: string | null;
  display_name: string;
  status: string;
  oauth_token_id: string | null;
  trust_tier: string;
  last_active_at: Date | null;
  created_at: Date;
  updated_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? SERVER_ID,
    user_id: overrides.user_id ?? USER_ID,
    registry_id: overrides.registry_id ?? '@modelcontextprotocol/server-filesystem',
    display_name: overrides.display_name ?? 'Filesystem',
    transport: 'stdio',
    command: '/usr/bin/npx',
    args: [],
    env: {},
    url: null,
    oauth_provider: null,
    oauth_token_id: overrides.oauth_token_id ?? null,
    trust_tier: overrides.trust_tier ?? 'observer',
    per_app_spend_per_action_cents: null,
    per_app_daily_spend_cents: null,
    per_app_monthly_spend_cents: null,
    per_app_monthly_rollover: false,
    per_app_irreversible_requires_approval: null,
    zero_trust_mode: false,
    status: overrides.status ?? 'active',
    last_health_check_at: null,
    health_status: null,
    last_active_at: overrides.last_active_at ?? new Date('2026-04-01'),
    installed_at: new Date('2026-01-01'),
    uninstalled_at: null,
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: overrides.updated_at ?? new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Capabilities API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: query succeeds with empty rows (used for provenance insert)
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    // Default: suggestion mocks return empty arrays
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.getActiveForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.markDismissed.mockResolvedValue(null);
    mockAppSuggestionRepository.markSnoozed.mockResolvedValue(null);
    // Default: listForUser returns empty array
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    // #324: default router resolves with a rollback() that succeeds.
    mockRouterRollback.mockResolvedValue({
      result: { success: true, message: 'Rolled back by ironclaw' },
      adapterUsed: 'ironclaw',
      noAdapter: false,
    });
    mockGetExecutionRouter.mockResolvedValue({ rollback: mockRouterRollback });
    // #324: default rollback targets are empty unless a test sets them.
    mockExecutionRepository.getRollbackTargetsByServer.mockResolvedValue([]);
  });

  // =========================================================================
  // GET /:id, /:id/skills, /:id/policy
  // =========================================================================
  describe('capability detail routes', () => {
    it('returns a single owned capability server for the detail page', async () => {
      const server = makeMcpServer();
      mockMcpServerRepository.getById.mockResolvedValue(server);

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/${SERVER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as { server: { id: string; display_name: string } };
      expect(body.server.id).toBe(SERVER_ID);
      expect(body.server.display_name).toBe('Filesystem');
    });

    it('redacts command/args/env/url/token from the detail response', async () => {
      const server = makeMcpServer();
      Object.assign(server, {
        command: '/usr/bin/npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: { API_KEY: 'super-secret-value' },
        url: 'https://user:pass@example.com/mcp?token=abc',
        oauth_token_id: 'tok-123',
      });
      mockMcpServerRepository.getById.mockResolvedValue(server);

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/${SERVER_ID}`);

      expect(res.status).toBe(200);
      const srv = (res.body as { server: Record<string, unknown> }).server;
      for (const field of ['command', 'args', 'env', 'url', 'oauth_token_id']) {
        expect(srv).not.toHaveProperty(field);
      }
      // The secret value must not leak anywhere in the payload.
      expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
      // Safe display metadata is still returned.
      expect(srv.display_name).toBe('Filesystem');
      expect(srv.trust_tier).toBeDefined();
    });

    it('does not expose a capability owned by another user', async () => {
      const OTHER_USER = 'cccccccc-dddd-eeee-ffff-000000000099';
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ user_id: OTHER_USER }));

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/${SERVER_ID}`);

      expect(res.status).toBe(403);
    });

    it('returns cached skills for the capability detail page', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer());
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            skill_name: 'read_file',
            skill_description: 'Read a file',
            is_destructive: false,
            is_irreversible: false,
            estimated_cost_cents: 0,
          },
        ],
        rowCount: 1,
      });

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/${SERVER_ID}/skills`);

      expect(res.status).toBe(200);
      const body = res.body as { skills: Array<{ skill_name: string }> };
      expect(body.skills[0]!.skill_name).toBe('read_file');
    });

    it('returns per-capability policy values from the server row', async () => {
      mockMcpServerRepository.getById.mockResolvedValue({
        ...makeMcpServer(),
        per_app_spend_per_action_cents: 500,
        per_app_daily_spend_cents: 2500,
        per_app_monthly_spend_cents: 10000,
      });

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/${SERVER_ID}/policy`);

      expect(res.status).toBe(200);
      const body = res.body as { policy: { perAppSpendPerActionCents: number; perAppDailySpendCents: number } };
      expect(body.policy.perAppSpendPerActionCents).toBe(500);
      expect(body.policy.perAppDailySpendCents).toBe(2500);
    });

    it('updates only the spend caps supplied by the detail page', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer());
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            ...makeMcpServer(),
            per_app_spend_per_action_cents: 1200,
            per_app_daily_spend_cents: null,
          },
        ],
        rowCount: 1,
      });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'PUT',
        `/api/capabilities/${SERVER_ID}/policy`,
        { perAppSpendPerActionCents: 1200, perAppDailySpendCents: null },
      );

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE mcp_servers'),
        [SERVER_ID, true, 1200, true, null, USER_ID],
      );
      const body = res.body as { policy: { perAppSpendPerActionCents: number; perAppDailySpendCents: null } };
      expect(body.policy.perAppSpendPerActionCents).toBe(1200);
      expect(body.policy.perAppDailySpendCents).toBeNull();
    });
  });

  // =========================================================================
  // POST /:id/uninstall
  // =========================================================================
  describe('POST /:id/uninstall', () => {
    it('returns 204 and marks server uninstalled', async () => {
      const server = makeMcpServer();
      mockMcpServerRepository.getById.mockResolvedValue(server);
      mockMcpServerRepository.softDelete.mockResolvedValue({ ...server, status: 'uninstalled' });

      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', `/api/capabilities/${SERVER_ID}/uninstall`, {});

      expect(res.status).toBe(204);
      expect(mockMcpServerRepository.softDelete).toHaveBeenCalledWith(SERVER_ID, {
        revokedOauth: false,
        droppedSignals: false,
      });
    });

    it('returns 400 when id is not a UUID', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', '/api/capabilities/server-missing/uninstall', {});
      expect(res.status).toBe(400);
    });

    it('returns 404 when server is already uninstalled', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ status: 'uninstalled' }));

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/uninstall`,
        {},
      );

      expect(res.status).toBe(404);
      expect(mockMcpServerRepository.softDelete).not.toHaveBeenCalled();
    });

    it('returns 403 when requester is not the owner', async () => {
      const OTHER_USER = 'cccccccc-dddd-eeee-ffff-000000000099';
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ user_id: OTHER_USER }));

      const app = buildApp(USER_ID); // different user
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/uninstall`,
        {},
      );

      expect(res.status).toBe(403);
      expect(mockMcpServerRepository.softDelete).not.toHaveBeenCalled();
    });

    it('calls query to delete OAuth token when revokeOauth is true and token exists', async () => {
      const tokenId = 'token-uuid-1111-1111-1111-111111111111';
      const server = makeMcpServer({ oauth_token_id: tokenId });
      mockMcpServerRepository.getById.mockResolvedValue(server);
      mockMcpServerRepository.softDelete.mockResolvedValue({ ...server, status: 'uninstalled' });

      const app = buildApp(USER_ID);
      await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/uninstall`,
        { revokeOauth: true },
      );

      const callArgs = mockQuery.mock.calls;
      const oauthDeleteCall = callArgs.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' && (args[0] as string).includes('DELETE FROM oauth_tokens'),
      );
      expect(oauthDeleteCall).toBeDefined();
    });

    it('writes a capability_provenance_nodes row on successful uninstall', async () => {
      const server = makeMcpServer();
      mockMcpServerRepository.getById.mockResolvedValue(server);
      mockMcpServerRepository.softDelete.mockResolvedValue({ ...server, status: 'uninstalled' });

      const app = buildApp(USER_ID);
      await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/uninstall`,
        {},
      );

      const callArgs = mockQuery.mock.calls;
      const provenanceInsert = callArgs.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          (args[0] as string).includes('capability_provenance_nodes'),
      );
      expect(provenanceInsert).toBeDefined();
    });
  });

  // =========================================================================
  // POST /:id/regret
  // =========================================================================
  describe('POST /:id/regret', () => {
    it('returns undone and irreversible split', async () => {
      const server = makeMcpServer();
      mockMcpServerRepository.getById.mockResolvedValue(server);

      // Two rollback targets — one reversible (no plan linkage), one not.
      // #324: the route resolves targets via the join repo method now. A
      // reversible action with NULL executionPlanId reports
      // `result: 'no_plan_linkage'` — honest reporting, no plan to target.
      mockExecutionRepository.getRollbackTargetsByServer.mockResolvedValue([
        {
          actionId: 'action-aaa',
          payload: { reversible: true },
          occurredAt: new Date(),
          executionPlanId: null,
          adapterUsed: null,
        },
        {
          actionId: 'action-bbb',
          payload: { reversible: false, irreversibleReason: 'Sent email' },
          occurredAt: new Date(),
          executionPlanId: null,
          adapterUsed: null,
        },
      ]);

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/regret`,
        { withinHours: 48 },
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        undone: Array<{ actionId: string; planId: string | null; result: string }>;
        irreversible: Array<{ actionId: string; reason: string }>;
      };
      expect(body.undone).toHaveLength(1);
      expect(body.undone[0]!.actionId).toBe('action-aaa');
      expect(body.undone[0]!.planId).toBeNull();
      expect(body.undone[0]!.result).toBe('no_plan_linkage');
      expect(body.irreversible).toHaveLength(1);
      expect(body.irreversible[0]!.actionId).toBe('action-bbb');
      expect(body.irreversible[0]!.reason).toBe('Sent email');
      // No plan to target → the router's rollback is never dispatched.
      expect(mockRouterRollback).not.toHaveBeenCalled();
    });

    it('dispatches IronClawAdapter.rollback via the router and reports rolled_back (#324)', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ user_id: USER_ID }));

      // Reversible action with a resolved plan id + recorded adapter — the
      // router rollback is dispatched against the SAME adapter that executed it.
      mockExecutionRepository.getRollbackTargetsByServer.mockResolvedValue([
        {
          actionId: 'action-ccc',
          payload: { reversible: true },
          occurredAt: new Date(),
          executionPlanId: 'plan-xyz',
          adapterUsed: 'ironclaw',
        },
      ]);

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/regret`,
        { withinHours: 48 },
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        undone: Array<{ actionId: string; planId: string | null; adapterUsed: string | null; result: string }>;
      };
      expect(body.undone).toHaveLength(1);
      expect(body.undone[0]!.planId).toBe('plan-xyz');
      expect(body.undone[0]!.adapterUsed).toBe('ironclaw');
      expect(body.undone[0]!.result).toBe('rolled_back');
      // The router was asked to roll back the resolved plan, targeting the
      // adapter recorded at execution time.
      expect(mockRouterRollback).toHaveBeenCalledWith('plan-xyz', 'ironclaw');
      // Audit trail: a rollback provenance node was written (Safety Invariant #2).
      const auditCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('capability_provenance_nodes'),
      );
      expect(auditCall).toBeDefined();
    });

    it('reports rollback_failed when the adapter cannot roll back (#324)', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ user_id: USER_ID }));
      mockExecutionRepository.getRollbackTargetsByServer.mockResolvedValue([
        {
          actionId: 'action-ddd',
          payload: { reversible: true },
          occurredAt: new Date(),
          executionPlanId: 'plan-fail',
          adapterUsed: 'openclaw',
        },
      ]);
      // Adapter reports failure (e.g. no rollback steps / adapter gone).
      mockRouterRollback.mockResolvedValue({
        result: { success: false, message: 'This action is not reversible.' },
        adapterUsed: 'openclaw',
        noAdapter: true,
      });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/regret`,
        { withinHours: 48 },
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        undone: Array<{ planId: string | null; result: string; message?: string }>;
      };
      expect(body.undone).toHaveLength(1);
      expect(body.undone[0]!.planId).toBe('plan-fail');
      expect(body.undone[0]!.result).toBe('rollback_failed');
      expect(body.undone[0]!.message).toContain('not reversible');
    });

    it('returns 403 when requester is not the owner', async () => {
      const OTHER_USER = 'cccccccc-dddd-eeee-ffff-000000000099';
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ user_id: OTHER_USER }));

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/regret`,
        { withinHours: 24 },
      );

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // POST /:id/time-machine
  // =========================================================================
  describe('POST /:id/time-machine', () => {
    it('returns originalDecision and stub alternateDecision without mutating', async () => {
      const server = makeMcpServer();
      mockMcpServerRepository.getById.mockResolvedValue(server);

      const decisionId = 'dddddddd-0000-0000-0000-000000000001';
      const fakeDecision = { id: decisionId, situation_type: 'email_received' };

      // Mock query to return decision row when queried
      mockQuery.mockResolvedValueOnce({ rows: [fakeDecision], rowCount: 1 });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/time-machine`,
        { decisionId, withoutCapability: true },
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        originalDecision: Record<string, unknown>;
        alternateDecision: Record<string, unknown>;
        diff: string;
      };
      expect(body.originalDecision['id']).toBe(decisionId);
      // Stub note present
      expect(typeof body.alternateDecision['note']).toBe('string');
      expect(body.diff).toContain('Filesystem');
    });

    it('returns 400 when decisionId is missing', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer());

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/time-machine`,
        {},
      );

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /:id/rehearse
  // =========================================================================
  describe('POST /:id/rehearse', () => {
    it('returns wouldHaveActions list', async () => {
      const server = makeMcpServer({ trust_tier: 'observer' });
      mockMcpServerRepository.getById.mockResolvedValue(server);

      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'dec-1', situation_type: 'email_received', created_at: new Date('2026-04-15') },
          { id: 'dec-2', situation_type: 'calendar_event', created_at: new Date('2026-04-20') },
        ],
        rowCount: 2,
      });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/${SERVER_ID}/rehearse`,
        { daysBack: 30 },
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        wouldHaveActions: Array<{
          decisionId: string;
          actionType: string;
          skippedDueToTier: string;
          wouldHaveExecutedAt: string;
        }>;
      };
      expect(body.wouldHaveActions).toHaveLength(2);
      expect(body.wouldHaveActions[0]!.decisionId).toBe('dec-1');
      expect(body.wouldHaveActions[0]!.skippedDueToTier).toBe('observer');
    });
  });

  // =========================================================================
  // GET / — list capabilities
  // =========================================================================
  describe('GET /', () => {
    it('returns installed, suggestions, and dormant slices', async () => {
      const activeServer = makeMcpServer({ status: 'active' });
      const dormantServer = makeMcpServer({ id: 'bbbbbbbb-bbbb-cccc-dddd-000000000002', status: 'dormant' });
      const suggestion = {
        id: 'cccccccc-dddd-eeee-ffff-000000000001',
        user_id: USER_ID,
        registry_id: 'gmail-mcp',
        display_name: 'Gmail',
        evidence_count: 5,
        evidence_sources: {},
        evidence_kinds_distinct: 2,
        first_evidence_at: new Date(),
        last_evidence_at: new Date(),
        confidence_score: '0.85',
        status: 'pending' as const,
        snoozed_until: null,
        reason_summary: 'You use Gmail frequently.',
        push_notified_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockMcpServerRepository.listForUser.mockResolvedValue([activeServer, dormantServer]);
      mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([suggestion]);

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities?userId=${USER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as {
        installed: unknown[];
        suggestions: unknown[];
        dormant: unknown[];
      };
      expect(body.installed).toHaveLength(1);
      expect(body.dormant).toHaveLength(1);
      expect(body.suggestions).toHaveLength(1);
    });

    it('returns 400 when userId is missing', async () => {
      // Override synthetic user injection to omit userId
      const appNoUser = express();
      appNoUser.use(express.json());
      appNoUser.use('/api/capabilities', createCapabilitiesRouter());
      const res = await request(appNoUser, 'GET', '/api/capabilities');
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // GET /registry
  // =========================================================================
  describe('GET /registry', () => {
    it('returns registry entries for an empty search query', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/registry?userId=${USER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as { entries: unknown[]; nextCursor: null };
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.nextCursor).toBeNull();
    });

    it('filters by category when provided', async () => {
      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'GET',
        `/api/capabilities/registry?userId=${USER_ID}&category=developer`,
      );
      expect(res.status).toBe(200);
      const body = res.body as { entries: Array<{ category: string }>; nextCursor: null };
      // All returned entries should have category=developer (or the filtered mock returns all)
      for (const entry of body.entries) {
        expect(entry.category).toBe('developer');
      }
    });
  });

  // =========================================================================
  // POST /suggestions/:id/dismiss
  // =========================================================================
  describe('POST /suggestions/:id/dismiss', () => {
    const SUGGESTION_ID = 'dddddddd-eeee-ffff-aaaa-000000000003';

    it('returns 204 on success', async () => {
      const suggestion = {
        id: SUGGESTION_ID,
        user_id: USER_ID,
        registry_id: 'gmail-mcp',
        display_name: 'Gmail',
        evidence_count: 3,
        evidence_sources: {},
        evidence_kinds_distinct: 1,
        first_evidence_at: new Date(),
        last_evidence_at: new Date(),
        confidence_score: '0.7',
        status: 'pending' as const,
        snoozed_until: null,
        reason_summary: null,
        push_notified_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockAppSuggestionRepository.getActiveForUser.mockResolvedValue([suggestion]);
      mockAppSuggestionRepository.markDismissed.mockResolvedValue({ ...suggestion, status: 'dismissed' as const });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/suggestions/${SUGGESTION_ID}/dismiss?userId=${USER_ID}`,
      );

      expect(res.status).toBe(204);
      expect(mockAppSuggestionRepository.markDismissed).toHaveBeenCalledWith(SUGGESTION_ID);
    });

    it('returns 404 when suggestion not found', async () => {
      mockAppSuggestionRepository.getActiveForUser.mockResolvedValue([]);

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/suggestions/${SUGGESTION_ID}/dismiss?userId=${USER_ID}`,
      );

      expect(res.status).toBe(404);
      expect(mockAppSuggestionRepository.markDismissed).not.toHaveBeenCalled();
    });

    it('returns 403 when user does not own the suggestion', async () => {
      const OTHER_USER = 'eeeeeeee-ffff-aaaa-bbbb-000000000099';
      const suggestion = {
        id: SUGGESTION_ID,
        user_id: OTHER_USER,
        registry_id: 'gmail-mcp',
        display_name: 'Gmail',
        evidence_count: 1,
        evidence_sources: {},
        evidence_kinds_distinct: 1,
        first_evidence_at: new Date(),
        last_evidence_at: new Date(),
        confidence_score: '0.5',
        status: 'pending' as const,
        snoozed_until: null,
        reason_summary: null,
        push_notified_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockAppSuggestionRepository.getActiveForUser.mockResolvedValue([suggestion]);

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/suggestions/${SUGGESTION_ID}/dismiss?userId=${USER_ID}`,
      );

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // POST /suggestions/:id/snooze
  // =========================================================================
  describe('POST /suggestions/:id/snooze', () => {
    const SUGGESTION_ID = 'eeeeeeee-ffff-aaaa-bbbb-000000000004';

    it('returns snoozedUntil for valid request', async () => {
      const suggestion = {
        id: SUGGESTION_ID,
        user_id: USER_ID,
        registry_id: 'linear-mcp',
        display_name: 'Linear',
        evidence_count: 2,
        evidence_sources: {},
        evidence_kinds_distinct: 1,
        first_evidence_at: new Date(),
        last_evidence_at: new Date(),
        confidence_score: '0.6',
        status: 'pending' as const,
        snoozed_until: null,
        reason_summary: null,
        push_notified_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockAppSuggestionRepository.getActiveForUser.mockResolvedValue([suggestion]);
      mockAppSuggestionRepository.markSnoozed.mockResolvedValue({
        ...suggestion,
        status: 'snoozed' as const,
        snoozed_until: new Date(),
      });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/suggestions/${SUGGESTION_ID}/snooze?userId=${USER_ID}`,
        { untilDays: 14 },
      );

      expect(res.status).toBe(200);
      const body = res.body as { snoozedUntil: string };
      expect(typeof body.snoozedUntil).toBe('string');
      expect(mockAppSuggestionRepository.markSnoozed).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /recipes + POST /recipes/:slug/install
  // =========================================================================
  describe('GET /recipes', () => {
    it('returns all 6 hardcoded recipes', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/recipes?userId=${USER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as { recipes: Array<{ slug: string; displayName: string; registryIds: string[] }> };
      expect(body.recipes).toHaveLength(6);
      const slugs = body.recipes.map((r) => r.slug);
      expect(slugs).toContain('developer-pack');
      expect(slugs).toContain('productivity-pack');
    });
  });

  describe('POST /recipes/:slug/install', () => {
    it('returns job descriptors for a valid recipe slug', async () => {
      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/recipes/developer-pack/install?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const body = res.body as { jobs: Array<{ registryId: string; status: string }> };
      expect(Array.isArray(body.jobs)).toBe(true);
      expect(body.jobs.length).toBeGreaterThan(0);
      for (const job of body.jobs) {
        expect(job.status).toBe('pending_user_oauth');
        expect(typeof job.registryId).toBe('string');
      }
    });

    it('returns 404 for an unknown recipe slug', async () => {
      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/recipes/nonexistent-pack/install?userId=${USER_ID}`,
      );
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /dependency-graph
  // =========================================================================
  describe('GET /dependency-graph', () => {
    it('returns nodes and edges with fallback shape when no skills exist', async () => {
      // listForUser returns empty (no installed servers → fallback example nodes)
      mockMcpServerRepository.listForUser.mockResolvedValue([]);
      // skillResult query returns empty
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'GET',
        `/api/capabilities/dependency-graph?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        nodes: Array<{ id: string; label: string; installed: boolean }>;
        edges: Array<{ from: string; to: string }>;
      };
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
      // Fallback shape has at least 5 nodes
      expect(body.nodes.length).toBeGreaterThanOrEqual(5);
      expect(body.edges.length).toBeGreaterThan(0);
    });
  });
});
