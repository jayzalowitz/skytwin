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
  mockProvenanceRepository,
  mockExecutionRepository,
  mockOauthRepository,
  mockGetExecutionRouter,
  mockRouterRollback,
  mockRegistrySearch,
  mockRegistryGetAll,
  mockLoadConfig,
  mockQuery,
} = vi.hoisted(() => ({
  mockMcpServerRepository: {
    getById: vi.fn(),
    getByUserAndRegistry: vi.fn(),
    listSkillNamesForServer: vi.fn(),
    listForUser: vi.fn(),
    listActive: vi.fn(),
    markDormant: vi.fn(),
    markPaused: vi.fn(),
    markActive: vi.fn(),
    markAllResumedForUser: vi.fn(),
    markResumedForUserByIds: vi.fn(),
    softDelete: vi.fn(),
    updateLastActive: vi.fn(),
    getInactiveSince: vi.fn(),
    updateTrustTier: vi.fn(),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockProvenanceRepository: { writeNode: vi.fn() },
  mockExecutionRepository: {
    getRollbackTargetsByServer: vi.fn(),
  },
  mockOauthRepository: { deleteById: vi.fn() },
  mockGetExecutionRouter: vi.fn(),
  mockRouterRollback: vi.fn(),
  mockRegistrySearch: vi.fn(),
  mockRegistryGetAll: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  provenanceRepository: mockProvenanceRepository,
  executionRepository: mockExecutionRepository,
  oauthRepository: mockOauthRepository,
  CredentialDispatchConflictError: class CredentialDispatchConflictError extends Error {},
  query: mockQuery,
}));

// #324: the regret endpoint resolves the execution router to dispatch
// IronClawAdapter.rollback(planId). Mock it so tests assert the wiring without
// constructing real adapters.
vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: mockGetExecutionRouter,
}));

vi.mock('../lib/user-llm-client.js', () => ({
  buildUserLlmClient: vi.fn().mockResolvedValue(null),
  resolveUserLlmClient: vi.fn().mockResolvedValue({
    state: 'no_provider', client: null, reason: 'No enabled provider is configured',
  }),
}));

// Mock RegistryClient so tests don't hit the filesystem during vitest
vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn(function RegistryClient() {
    return {
      search: mockRegistrySearch,
      getAll: mockRegistryGetAll,
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
  oauth_provider: string | null;
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
    oauth_provider: overrides.oauth_provider ?? null,
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
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
    mockRegistrySearch.mockResolvedValue([
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
    ]);
    mockRegistryGetAll.mockResolvedValue([]);
    mockProvenanceRepository.writeNode.mockResolvedValue(undefined);
    mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([]);
    // Default: query succeeds with empty rows (used for provenance insert)
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    // Default: suggestion mocks return empty arrays
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.getActiveForUser.mockResolvedValue([]);
    mockAppSuggestionRepository.markDismissed.mockResolvedValue(null);
    mockAppSuggestionRepository.markSnoozed.mockResolvedValue(null);
    // Default: listForUser returns empty array
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
    mockMcpServerRepository.markAllResumedForUser.mockResolvedValue([]);
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

    it('preserves ownership denial before account availability checks', async () => {
      const OTHER_USER = 'cccccccc-dddd-eeee-ffff-000000000099';
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({
        user_id: OTHER_USER,
        registry_id: 'gmail-mcp',
      }));

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/${SERVER_ID}`);

      expect(res.status).toBe(403);
      expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
    });

    it.each([
      ['detail', `/api/capabilities/${SERVER_ID}`, { registry_id: 'gmail-mcp' }],
      ['skills', `/api/capabilities/${SERVER_ID}/skills`, { oauth_provider: 'microsoft' }],
      ['policy', `/api/capabilities/${SERVER_ID}/policy`, { registry_id: 'outlook-mcp' }],
    ])('hides retained account-backed metadata from the %s route while disabled', async (_name, path, overrides) => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer(overrides));

      const res = await request(buildApp(USER_ID), 'GET', path);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'This capability is unavailable while account connections are disabled.',
      });
      expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/google|microsoft/);
      expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
    });

    it('hides a custom server when any cached skill is account-backed', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({
        registry_id: 'custom-productivity-tools',
      }));
      mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([
        'read_file',
        'sendEmail',
      ]);

      const res = await request(buildApp(USER_ID), 'GET', `/api/capabilities/${SERVER_ID}`);

      expect(res.status).toBe(503);
      expect(mockMcpServerRepository.listSkillNamesForServer).toHaveBeenCalledWith(SERVER_ID);
    });

    it.each(['empty', 'error'])('fails closed when a custom server inventory is %s', async (inventoryState) => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({
        registry_id: 'custom-productivity-tools',
      }));
      if (inventoryState === 'error') {
        mockMcpServerRepository.listSkillNamesForServer.mockRejectedValue(new Error('inventory unavailable'));
      } else {
        mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([]);
      }

      const res = await request(buildApp(USER_ID), 'GET', `/api/capabilities/${SERVER_ID}/policy`);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'This capability is unavailable while account connections are disabled.',
      });
    });

    it('preserves account-backed detail access in exact experimental mode', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ registry_id: 'gmail-mcp' }));

      const res = await request(buildApp(USER_ID), 'GET', `/api/capabilities/${SERVER_ID}`);

      expect(res.status).toBe(200);
      expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
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
    it('keeps account-capability cleanup reachable while connections are disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const server = makeMcpServer({ registry_id: 'gmail-mcp' });
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

    it('uses the fenced repository delete when revokeOauth is true and token exists', async () => {
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

      expect(mockOauthRepository.deleteById).toHaveBeenCalledWith(USER_ID, tokenId);
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
    it('reports reversible and irreversible targets without dispatching', async () => {
      const server = makeMcpServer();
      mockMcpServerRepository.getById.mockResolvedValue(server);

      // Two rollback targets — one reversible (no plan linkage), one not.
      // #324: the route resolves targets via the join repo method now. A
      // reversible action with NULL executionPlanId remains visible in the
      // report, but cannot be dispatched without a durable rollback lifecycle.
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
        status: string;
        code: string;
        undone: unknown[];
        unavailable: Array<{ actionId: string; planId: string | null; result: string }>;
        irreversible: Array<{ actionId: string; reason: string }>;
      };
      expect(body.status).toBe('report_only');
      expect(body.code).toBe('generic_rollback_report_only');
      expect(body.undone).toEqual([]);
      expect(body.unavailable).toHaveLength(1);
      expect(body.unavailable[0]!.actionId).toBe('action-aaa');
      expect(body.unavailable[0]!.planId).toBeNull();
      expect(body.unavailable[0]!.result).toBe('rollback_unavailable');
      expect(body.irreversible).toHaveLength(1);
      expect(body.irreversible[0]!.actionId).toBe('action-bbb');
      expect(body.irreversible[0]!.reason).toBe('Sent email');
      // Report-only mode never resolves or dispatches a router.
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
      expect(mockRouterRollback).not.toHaveBeenCalled();
    });

    it('does not dispatch even when exact provider plan linkage exists', async () => {
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ user_id: USER_ID }));

      // Plan linkage remains useful report data, but is not rollback authority.
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
        status: string;
        undone: unknown[];
        unavailable: Array<{ actionId: string; planId: string | null; adapterUsed: string | null; result: string }>;
      };
      expect(body.status).toBe('report_only');
      expect(body.undone).toEqual([]);
      expect(body.unavailable).toHaveLength(1);
      expect(body.unavailable[0]!.planId).toBe('plan-xyz');
      expect(body.unavailable[0]!.adapterUsed).toBe('ironclaw');
      expect(body.unavailable[0]!.result).toBe('rollback_unavailable');
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
      expect(mockRouterRollback).not.toHaveBeenCalled();
      const rollbackAuditCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('capability_provenance_nodes')
          && Array.isArray(c[1]) && JSON.stringify(c[1]).includes('rollback'),
      );
      expect(rollbackAuditCall).toBeUndefined();
    });

    it('does not consult adapter rollback results in report-only mode', async () => {
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
        result: { success: false, message: 'ya29.adapter-secret' },
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
        undone: unknown[];
        unavailable: Array<{ planId: string | null; result: string; message?: string }>;
      };
      expect(body.undone).toEqual([]);
      expect(body.unavailable).toHaveLength(1);
      expect(body.unavailable[0]!.planId).toBe('plan-fail');
      expect(body.unavailable[0]!.result).toBe('rollback_unavailable');
      expect(body.unavailable[0]!.message).toContain('durable replay protection');
      expect(mockGetExecutionRouter).not.toHaveBeenCalled();
      expect(mockRouterRollback).not.toHaveBeenCalled();
      expect(JSON.stringify({ response: res.body, writes: mockQuery.mock.calls }))
        .not.toContain('ya29.adapter-secret');
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

    it('hides stale Google servers by registry id or OAuth provider while disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const gmail = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000010',
        registry_id: 'gmail-mcp',
        display_name: 'Gmail',
      });
      const googleOauthAlias = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000011',
        registry_id: 'custom-drive',
        display_name: 'Drive alias',
        oauth_provider: 'google',
        status: 'dormant',
      });
      const github = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000012',
        registry_id: '@modelcontextprotocol/server-github',
        display_name: 'GitHub',
      });
      const customMail = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000013',
        registry_id: 'custom-productivity',
        display_name: 'Custom productivity',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([
        gmail,
        googleOauthAlias,
        customMail,
        github,
      ]);
      mockMcpServerRepository.listSkillNamesForServer.mockImplementation(async (serverId: string) =>
        serverId === customMail.id ? ['sendEmail'] : ['create_issue']);
      mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([
        { registry_id: 'google-calendar-mcp' },
        { registry_id: 'linear-mcp' },
      ]);

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        installed: Array<{ registry_id: string }>;
        dormant: Array<{ registry_id: string }>;
        suggestions: Array<{ registry_id: string }>;
      };
      expect(body.installed.map((server) => server.registry_id))
        .toEqual(['@modelcontextprotocol/server-github']);
      expect(body.dormant).toEqual([]);
      expect(body.suggestions.map((suggestion) => suggestion.registry_id)).toEqual(['linear-mcp']);
    });

    it('fails closed when a visible server tool inventory cannot be read', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.listForUser.mockResolvedValue([
        makeMcpServer({ registry_id: '@modelcontextprotocol/server-github' }),
      ]);
      mockMcpServerRepository.listSkillNamesForServer.mockRejectedValueOnce(
        new Error('classification unavailable'),
      );
      mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ installed: [], dormant: [] });
    });

    it('preserves Google capability rows behind the exact experimental opt-in', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
      mockMcpServerRepository.listForUser.mockResolvedValue([
        makeMcpServer({ registry_id: 'gmail-mcp', display_name: 'Gmail' }),
      ]);
      mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([
        { registry_id: 'google-calendar-mcp' },
      ]);

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const body = res.body as { installed: unknown[]; suggestions: unknown[] };
      expect(body.installed).toHaveLength(1);
      expect(body.suggestions).toHaveLength(1);
    });
  });

  describe('POST /resume-all', () => {
    it('resumes only non-Google paused servers while disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const gmail = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000020',
        registry_id: 'gmail-mcp',
        status: 'paused',
      });
      const googleOauthAlias = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000021',
        registry_id: 'custom-drive',
        oauth_provider: 'google',
        status: 'paused',
      });
      const github = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000022',
        registry_id: '@modelcontextprotocol/server-github',
        status: 'paused',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([gmail, googleOauthAlias, github]);
      mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue(['create_issue']);
      mockMcpServerRepository.markResumedForUserByIds.mockResolvedValueOnce([
        { ...github, status: 'active' },
      ]);

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/resume-all?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resumedCount: 1 });
      expect(mockMcpServerRepository.markAllResumedForUser).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.markResumedForUserByIds)
        .toHaveBeenCalledWith(USER_ID, [github.id]);
    });

    it('does not issue an update when only Google servers are paused', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.listForUser.mockResolvedValue([
        makeMcpServer({ registry_id: 'gmail-mcp', status: 'paused' }),
      ]);

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/resume-all?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resumedCount: 0 });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.markAllResumedForUser).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.markResumedForUserByIds).not.toHaveBeenCalled();
    });

    it('does not resume a custom paused server with account-backed cached skills', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const custom = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000023',
        registry_id: 'custom-productivity',
        status: 'paused',
      });
      const github = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000024',
        registry_id: '@modelcontextprotocol/server-github',
        status: 'paused',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([custom, github]);
      mockMcpServerRepository.listSkillNamesForServer.mockImplementation(async (serverId: string) =>
        serverId === custom.id ? ['sendEmail'] : ['create_issue']);
      mockMcpServerRepository.markResumedForUserByIds.mockResolvedValueOnce([
        { ...github, status: 'active' },
      ]);

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/resume-all?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resumedCount: 1 });
      expect(mockMcpServerRepository.markResumedForUserByIds)
        .toHaveBeenCalledWith(USER_ID, [github.id]);
    });

    it('fails closed when paused-server skill classification cannot be read', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const custom = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000025',
        registry_id: 'custom-productivity',
        status: 'paused',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([custom]);
      mockMcpServerRepository.listSkillNamesForServer.mockRejectedValueOnce(
        new Error('classification unavailable'),
      );

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/resume-all?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resumedCount: 0 });
      expect(mockMcpServerRepository.markResumedForUserByIds).not.toHaveBeenCalled();
    });

    it('does not resume a neutral custom server with no cached inventory evidence', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const custom = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000026',
        registry_id: 'custom-productivity',
        status: 'paused',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([custom]);
      mockMcpServerRepository.listSkillNamesForServer.mockResolvedValueOnce([]);

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/resume-all?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resumedCount: 0 });
      expect(mockMcpServerRepository.markResumedForUserByIds).not.toHaveBeenCalled();
    });

    it('preserves bulk resume behind the exact experimental opt-in', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
      const gmail = makeMcpServer({ registry_id: 'gmail-mcp', status: 'active' });
      mockMcpServerRepository.markAllResumedForUser.mockResolvedValue([gmail]);

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/resume-all?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resumedCount: 1 });
      expect(mockMcpServerRepository.markAllResumedForUser).toHaveBeenCalledWith(USER_ID);
      expect(mockMcpServerRepository.markResumedForUserByIds).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.listForUser).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('GET /suggestions', () => {
    it('filters stale Google suggestions while disabled and preserves neighbors', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const suggestion = (registryId: string, id: string) => ({
        id,
        user_id: USER_ID,
        registry_id: registryId,
        display_name: registryId,
        evidence_count: 1,
        evidence_sources: [],
        evidence_kinds_distinct: 1,
        first_evidence_at: new Date(),
        last_evidence_at: new Date(),
        confidence_score: '0.8',
        status: 'pending' as const,
        snoozed_until: null,
        reason_summary: null,
        push_notified_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([
        suggestion('gmail-mcp', 'suggestion-google'),
        suggestion('linear-mcp', 'suggestion-linear'),
      ]);

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities/suggestions?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect((res.body as { suggestions: Array<{ registry_id: string }> }).suggestions
        .map((entry) => entry.registry_id)).toEqual(['linear-mcp']);
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

    it('filters Google account entries while preserving a non-Google neighbor when disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockRegistrySearch.mockResolvedValue([
        {
          id: 'gmail-mcp',
          displayName: 'Gmail',
          oauthProvider: null,
          category: 'productivity',
        },
        {
          id: 'custom-google-photos',
          displayName: 'Photos',
          oauthProvider: 'google',
          category: 'productivity',
        },
        {
          id: '@modelcontextprotocol/server-github',
          displayName: 'GitHub',
          oauthProvider: 'github',
          category: 'developer',
        },
      ]);

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/registry?userId=${USER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as { entries: Array<{ id: string }> };
      expect(body.entries.map((entry) => entry.id)).toEqual([
        '@modelcontextprotocol/server-github',
      ]);
      expect(mockRegistrySearch).toHaveBeenCalledWith('');
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

    it('filters Google account registry IDs from deterministic recipes while disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', `/api/capabilities/recipes?userId=${USER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as { recipes: Array<{ slug: string; description: string; registryIds: string[] }> };
      const allIds = body.recipes.flatMap((recipe) => recipe.registryIds);
      expect(allIds).not.toContain('gmail-mcp');
      expect(allIds).not.toContain('google-calendar-mcp');
      expect(allIds).not.toContain('@modelcontextprotocol/server-google-drive');
      expect(allIds).toContain('@modelcontextprotocol/server-github');
      expect(body.recipes.find((recipe) => recipe.slug === 'productivity-pack'))
        .toMatchObject({
          description: 'Productivity pack capabilities available in this preview.',
          registryIds: ['@notionhq/notion-mcp-server', '@modelcontextprotocol/server-slack'],
        });
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

    it('returns only non-Google jobs from a mixed recipe while disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const app = buildApp(USER_ID);
      const res = await request(
        app,
        'POST',
        `/api/capabilities/recipes/productivity-pack/install?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        jobs: [
          { registryId: '@notionhq/notion-mcp-server', status: 'pending_user_oauth' },
          { registryId: '@modelcontextprotocol/server-slack', status: 'pending_user_oauth' },
        ],
      });
    });
  });

  describe('POST /install', () => {
    it.each(['gmail-mcp', 'outlook-mcp', 'openclaw:onedrive'])
    ('rejects the known account capability %s before registry lookup or provenance writes', async (registryId) => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', `/api/capabilities/install?userId=${USER_ID}`, {
        registryId,
      });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'ACCOUNT_CONNECTION_DISABLED',
        available: false,
        mode: 'disabled',
      });
      expect(mockRegistrySearch).not.toHaveBeenCalled();
      expect(mockProvenanceRepository.writeNode).not.toHaveBeenCalled();
    });

    it('rejects a registry entry declaring Google OAuth before provenance writes', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockRegistrySearch.mockResolvedValue([
        {
          id: 'custom-google-photos',
          displayName: 'Photos',
          oauthProvider: 'google',
          category: 'productivity',
        },
      ]);
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', `/api/capabilities/install?userId=${USER_ID}`, {
        registryId: 'custom-google-photos',
      });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'ACCOUNT_CONNECTION_DISABLED' });
      expect(mockRegistrySearch).toHaveBeenCalledWith('custom-google-photos');
      expect(mockProvenanceRepository.writeNode).not.toHaveBeenCalled();
    });

    it('preserves direct install placeholders for a non-Google neighbor while disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockRegistrySearch.mockResolvedValue([
        {
          id: '@modelcontextprotocol/server-github',
          displayName: 'GitHub',
          oauthProvider: 'github',
          category: 'developer',
        },
      ]);
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', `/api/capabilities/install?userId=${USER_ID}`, {
        registryId: '@modelcontextprotocol/server-github',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        job: {
          registryId: '@modelcontextprotocol/server-github',
          displayName: 'GitHub',
          status: 'pending_user_oauth',
        },
      });
      expect(mockRegistrySearch).toHaveBeenCalledWith('@modelcontextprotocol/server-github');
      expect(mockProvenanceRepository.writeNode).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // POST /:id/promote-tier
  // =========================================================================
  describe('POST /:id/promote-tier', () => {
    it.each([
      ['Google metadata', { registry_id: 'gmail-mcp' }, 'unused'],
      ['Microsoft metadata', { oauth_provider: 'microsoft' }, 'unused'],
      ['cached account skill', { registry_id: 'custom-productivity-tools' }, 'sendEmail'],
      ['empty inventory', { registry_id: 'custom-productivity-tools' }, 'empty'],
      ['errored inventory', { registry_id: 'custom-productivity-tools' }, 'error'],
    ])('denies promotion for %s while account connections are disabled', async (_name, overrides, inventory) => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer(overrides));
      if (inventory === 'error') {
        mockMcpServerRepository.listSkillNamesForServer.mockRejectedValue(
          new Error('inventory unavailable'),
        );
      } else if (inventory === 'empty') {
        mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([]);
      } else if (inventory !== 'unused') {
        mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([inventory]);
      }

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/${SERVER_ID}/promote-tier`,
        { toTier: 'suggest' },
      );

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'This capability is unavailable while account connections are disabled.',
      });
      expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/google|microsoft/);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.updateTrustTier).not.toHaveBeenCalled();
      expect(mockProvenanceRepository.writeNode).not.toHaveBeenCalled();
    });

    it('preserves account-backed promotion in exact experimental mode', async () => {
      const server = makeMcpServer({ registry_id: 'gmail-mcp', trust_tier: 'observer' });
      const promoted = makeMcpServer({ registry_id: 'gmail-mcp', trust_tier: 'suggest' });
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
      mockMcpServerRepository.getById.mockResolvedValue(server);
      mockMcpServerRepository.updateTrustTier.mockResolvedValue(promoted);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '10', approved: '10' }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: Array.from({ length: 10 }, () => ({
            node_type: 'action',
            payload: { approved: true },
          })),
          rowCount: 10,
        });

      const res = await request(
        buildApp(USER_ID),
        'POST',
        `/api/capabilities/${SERVER_ID}/promote-tier`,
        { toTier: 'suggest' },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ server: expect.objectContaining({ trust_tier: 'suggest' }) });
      expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
      expect(mockMcpServerRepository.updateTrustTier).toHaveBeenCalledWith(SERVER_ID, 'suggest');
      expect(mockProvenanceRepository.writeNode).toHaveBeenCalledWith(expect.objectContaining({
        userId: USER_ID,
        nodeType: 'tier_promotion',
        serverId: SERVER_ID,
      }));
    });
  });

  it.each([
    ['regret report', 'POST', `/api/capabilities/${SERVER_ID}/regret`, { withinHours: 24 }],
    ['time-machine report', 'POST', `/api/capabilities/${SERVER_ID}/time-machine`, {
      decisionId: 'dddddddd-0000-0000-0000-000000000001',
    }],
    ['rehearsal', 'POST', `/api/capabilities/${SERVER_ID}/rehearse`, { daysBack: 30 }],
    ['promotion decline', 'POST', `/api/capabilities/${SERVER_ID}/decline-promotion`, {}],
    ['provenance detail', 'GET', `/api/capabilities/${SERVER_ID}/provenance`, undefined],
    ['metrics detail', 'GET', `/api/capabilities/${SERVER_ID}/metrics`, undefined],
    ['zero-trust enable', 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/enable`, {}],
    ['zero-trust disable', 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/disable`, {}],
  ])('hides the retained account capability from the %s route', async (_name, method, path, body) => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
    mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({
      oauth_provider: 'microsoft',
    }));

    const res = await request(buildApp(USER_ID), method, path, body);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'This capability is unavailable while account connections are disabled.',
    });
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/google|microsoft/);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecutionRepository.getRollbackTargetsByServer).not.toHaveBeenCalled();
    expect(mockMcpServerRepository.updateTrustTier).not.toHaveBeenCalled();
    expect(mockProvenanceRepository.writeNode).not.toHaveBeenCalled();
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

    it('removes account-backed nodes and fallback examples while disabled', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const googleServer = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000030',
        registry_id: 'custom-calendar',
        oauth_provider: 'google',
        display_name: 'Calendar alias',
      });
      const githubServer = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000031',
        registry_id: '@modelcontextprotocol/server-github',
        display_name: 'GitHub',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([googleServer, githubServer]);
      mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue(['create_issue']);
      mockQuery.mockResolvedValue({
        rows: [
          { server_id: googleServer.id, skill_name: 'list_events', server_display_name: 'Calendar alias' },
          { server_id: githubServer.id, skill_name: 'create_issue', server_display_name: 'GitHub' },
        ],
        rowCount: 2,
      });

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities/dependency-graph?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        nodes: Array<{ id: string; label: string }>;
        edges: Array<{ from: string; to: string }>;
      };
      expect(body.nodes.map((node) => node.id)).toEqual([
        `server:${githubServer.id}`,
        'skill:create_issue',
      ]);
      expect(body.edges).toEqual([{
        from: `server:${githubServer.id}`,
        to: 'skill:create_issue',
      }]);
    });

    it('excludes an entire custom server when its cached inventory mixes account-backed and local skills', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const mixedServer = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000032',
        registry_id: 'custom-productivity-tools',
        display_name: 'Productivity tools',
      });
      const localServer = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000033',
        registry_id: '@modelcontextprotocol/server-filesystem',
        display_name: 'Filesystem',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([mixedServer, localServer]);
      mockMcpServerRepository.listSkillNamesForServer.mockImplementation(async (serverId: string) =>
        serverId === mixedServer.id ? ['read_file', 'sendEmail'] : ['read_file']);
      mockQuery.mockResolvedValue({
        rows: [
          { server_id: mixedServer.id, skill_name: 'read_file', server_display_name: 'Productivity tools' },
          { server_id: mixedServer.id, skill_name: 'sendEmail', server_display_name: 'Productivity tools' },
          { server_id: localServer.id, skill_name: 'read_file', server_display_name: 'Filesystem' },
        ],
        rowCount: 3,
      });

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities/dependency-graph?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(mixedServer.id);
      expect(serialized).not.toContain('Productivity tools');
      expect(serialized).toContain(localServer.id);
    });

    it.each(['empty', 'error'])('excludes a custom server whose cached inventory is %s', async (inventoryState) => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      const uncertainServer = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000034',
        registry_id: 'custom-uncertain-tools',
        display_name: 'Uncertain tools',
      });
      const localServer = makeMcpServer({
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000035',
        registry_id: '@modelcontextprotocol/server-filesystem',
        display_name: 'Filesystem',
      });
      mockMcpServerRepository.listForUser.mockResolvedValue([uncertainServer, localServer]);
      mockMcpServerRepository.listSkillNamesForServer.mockImplementation(async (serverId: string) => {
        if (serverId === localServer.id) return ['read_file'];
        if (inventoryState === 'error') throw new Error('inventory unavailable');
        return [];
      });
      mockQuery.mockResolvedValue({
        rows: [
          { server_id: uncertainServer.id, skill_name: 'read_file', server_display_name: 'Uncertain tools' },
          { server_id: localServer.id, skill_name: 'read_file', server_display_name: 'Filesystem' },
        ],
        rowCount: 2,
      });

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities/dependency-graph?userId=${USER_ID}`,
      );

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(uncertainServer.id);
      expect(serialized).not.toContain('Uncertain tools');
      expect(serialized).toContain(localServer.id);
    });

    it('keeps the disabled empty-state graph account-free', async () => {
      mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
      mockMcpServerRepository.listForUser.mockResolvedValue([]);
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const res = await request(
        buildApp(USER_ID),
        'GET',
        `/api/capabilities/dependency-graph?userId=${USER_ID}`,
      );

      const serialized = JSON.stringify(res.body);
      expect(res.status).toBe(200);
      expect(serialized).not.toContain('gmail');
      expect(serialized).not.toContain('read_email');
      expect(serialized).toContain('github');
      expect(serialized).toContain('notion');
    });
  });
});
