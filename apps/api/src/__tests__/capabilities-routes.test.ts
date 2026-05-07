import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules — vi.hoisted ensures mocks are available when vi.mock factories
// execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockMcpServerRepository,
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
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  query: mockQuery,
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

      // Mock: two provenance nodes — one reversible, one not
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'node-1',
            ref_id: 'action-aaa',
            payload: { reversible: true },
            occurred_at: new Date(),
          },
          {
            id: 'node-2',
            ref_id: 'action-bbb',
            payload: { reversible: false, irreversibleReason: 'Sent email' },
            occurred_at: new Date(),
          },
        ],
        rowCount: 2,
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
        undone: Array<{ actionId: string; result: string }>;
        irreversible: Array<{ actionId: string; reason: string }>;
      };
      expect(body.undone).toHaveLength(1);
      expect(body.undone[0]!.actionId).toBe('action-aaa');
      expect(body.undone[0]!.result).toBe('rolled_back');
      expect(body.irreversible).toHaveLength(1);
      expect(body.irreversible[0]!.actionId).toBe('action-bbb');
      expect(body.irreversible[0]!.reason).toBe('Sent email');
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
});
