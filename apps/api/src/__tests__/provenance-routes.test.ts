/**
 * Tests for provenance lineage endpoint (issue #177).
 *
 * GET /api/capabilities/:id/provenance
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Mocks (vi.hoisted so factories run before vi.mock) ─────────────────────

const {
  mockMcpServerRepository,
  mockAppSuggestionRepository,
  mockProvenanceRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockMcpServerRepository: {
    getById: vi.fn(),
    listForUser: vi.fn(),
    listActive: vi.fn(),
    softDelete: vi.fn(),
    updateLastActive: vi.fn(),
    markDormant: vi.fn(),
    markPaused: vi.fn(),
    markActive: vi.fn(),
    markAllPausedForUser: vi.fn(),
    markAllResumedForUser: vi.fn(),
    getInactiveSince: vi.fn(),
    updateTrustTier: vi.fn(),
    pauseAutoPromotion: vi.fn(),
    getByUserAndRegistry: vi.fn(),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockProvenanceRepository: {
    getForServer: vi.fn(),
    writeNode: vi.fn(),
    writeEdge: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  provenanceRepository: mockProvenanceRepository,
  query: mockQuery,
}));

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@skytwin/policy-engine', () => ({
  TrustTierEngine: vi.fn().mockImplementation(() => ({
    evaluateProgression: vi.fn().mockReturnValue({ shouldChange: false, currentTier: 'observer', reason: 'Stable.' }),
    evaluateRegression: vi.fn().mockReturnValue({ shouldChange: false, currentTier: 'observer', reason: 'Stable.' }),
    evaluate: vi.fn().mockReturnValue({ shouldChange: false, currentTier: 'observer', reason: 'Stable.' }),
  })),
}));

vi.mock('@skytwin/shared-types', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    PROMOTION_THRESHOLDS: {
      observer: { consecutiveApprovals: 10, minApprovalRatio: 0.8, nextTier: 'suggest' },
    },
  };
});

vi.mock('../sse.js', () => ({
  sseManager: { emit: vi.fn() },
  SSE_CAPABILITY_SUGGESTED: 'capability:suggested',
  SSE_CAPABILITY_INSTALLED: 'capability:installed',
  SSE_CAPABILITY_HEALTH: 'capability:health',
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability:promotion-offered',
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { createCapabilitiesRouter } from '../routes/capabilities.js';

// ── Constants ─────────────────────────────────────────────────────────────

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const USER_ID   = 'ffffffff-eeee-dddd-cccc-000000000002';

const SERVER_ROW = {
  id: SERVER_ID,
  user_id: USER_ID,
  registry_id: 'notion-mcp',
  display_name: 'Notion',
  transport: 'http',
  command: null,
  args: [],
  env: {},
  url: 'https://notion.mcp',
  oauth_provider: 'notion',
  oauth_token_id: null,
  trust_tier: 'observer',
  per_app_spend_per_action_cents: null,
  per_app_daily_spend_cents: null,
  per_app_monthly_spend_cents: null,
  per_app_monthly_rollover: false,
  per_app_irreversible_requires_approval: null,
  zero_trust_mode: false,
  status: 'active',
  last_health_check_at: null,
  health_status: null,
  last_active_at: null,
  installed_at: null,
  uninstalled_at: null,
  auto_promote_paused_until: null,
  created_at: new Date(),
  updated_at: new Date(),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
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

async function req(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('no port')); return; }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const opts: RequestInit = { method, headers };
      if (body !== undefined) opts.body = JSON.stringify(body);
      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/capabilities/:id/provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('returns the provenance chain for a server the caller owns', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);
    const nodes = [
      {
        id: 'node-1',
        user_id: USER_ID,
        node_type: 'install',
        ref_table: 'mcp_servers',
        ref_id: SERVER_ID,
        server_id: SERVER_ID,
        occurred_at: new Date(),
        payload: { displayName: 'Notion' },
        created_at: new Date(),
      },
    ];
    mockProvenanceRepository.getForServer.mockResolvedValue(nodes);

    const { status, body } = await req(buildApp(), 'GET', `/api/capabilities/${SERVER_ID}/provenance`);

    expect(status).toBe(200);
    expect((body as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect((body as { nodes: Array<{ node_type: string }> }).nodes[0]!.node_type).toBe('install');
    expect((body as { serverId: string }).serverId).toBe(SERVER_ID);
    expect(mockProvenanceRepository.getForServer).toHaveBeenCalledWith(USER_ID, SERVER_ID);
  });

  it('returns empty nodes array for a server with no provenance', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);
    mockProvenanceRepository.getForServer.mockResolvedValue([]);

    const { status, body } = await req(buildApp(), 'GET', `/api/capabilities/${SERVER_ID}/provenance`);

    expect(status).toBe(200);
    expect((body as { nodes: unknown[] }).nodes).toEqual([]);
  });

  it('returns 403 when the caller does not own the server', async () => {
    mockMcpServerRepository.getById.mockResolvedValue({
      ...SERVER_ROW,
      user_id: 'other-user',
    });

    const { status } = await req(buildApp(), 'GET', `/api/capabilities/${SERVER_ID}/provenance`);

    expect(status).toBe(403);
    expect(mockProvenanceRepository.getForServer).not.toHaveBeenCalled();
  });

  it('returns 404 when the server does not exist', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(null);

    const { status } = await req(buildApp(), 'GET', `/api/capabilities/${SERVER_ID}/provenance`);

    expect(status).toBe(404);
  });
});
