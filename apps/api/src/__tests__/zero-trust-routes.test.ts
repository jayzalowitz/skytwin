import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules — vi.hoisted ensures mocks are available when vi.mock factories
// execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockMcpServerRepository,
  mockProvenanceRepository,
  mockAppSuggestionRepository,
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
    updateTrustTier: vi.fn(),
    setZeroTrustMode: vi.fn(),
  },
  mockProvenanceRepository: {
    getForServer: vi.fn(),
    writeNode: vi.fn().mockResolvedValue({ id: 'prov-node-001' }),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  provenanceRepository: mockProvenanceRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  query: mockQuery,
  // The capabilities router also imports these — stub them so the module loads.
  mcpServerMetricsRepository: { listBucketsForServer: vi.fn().mockResolvedValue([]) },
  mcpServerChangelogRepository: {
    listPendingOptInsForUser: vi.fn().mockResolvedValue([]),
    getForServer: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@skytwin/policy-engine', () => ({
  TrustTierEngine: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@skytwin/policy-prompts', () => ({
  runPrompt: vi.fn(),
}));

vi.mock('../lib/llm-client-factory.js', () => ({
  getLlmClientFromConfig: vi.fn(),
}));

vi.mock('../sse.js', () => ({
  sseManager: {},
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability_promotion_offered',
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { createCapabilitiesRouter } from '../routes/capabilities.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const USER_ID   = 'ffffffff-eeee-dddd-cccc-000000000001';
const OTHER_USER_ID = '11111111-2222-3333-4444-555555555555';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeMcpServer(overrides: { zero_trust_mode?: boolean; user_id?: string; status?: string } = {}) {
  return {
    id: SERVER_ID,
    user_id: overrides.user_id ?? USER_ID,
    registry_id: '@test/server',
    display_name: 'Test Server',
    transport: 'stdio',
    command: null,
    args: [],
    env: {},
    url: null,
    oauth_provider: null,
    oauth_token_id: null,
    trust_tier: 'observer',
    per_app_spend_per_action_cents: null,
    per_app_daily_spend_cents: null,
    per_app_monthly_spend_cents: null,
    per_app_monthly_rollover: false,
    per_app_irreversible_requires_approval: null,
    zero_trust_mode: overrides.zero_trust_mode ?? false,
    status: overrides.status ?? 'active',
    last_health_check_at: null,
    health_status: null,
    last_active_at: null,
    installed_at: null,
    uninstalled_at: null,
    auto_promote_paused_until: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/capabilities/:id/zero-trust/enable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProvenanceRepository.writeNode.mockResolvedValue({ id: 'prov-node-001' });
  });

  it('enables zero-trust mode and returns the updated server', async () => {
    const original = makeMcpServer({ zero_trust_mode: false });
    const updated  = makeMcpServer({ zero_trust_mode: true });
    mockMcpServerRepository.getById.mockResolvedValue(original);
    mockMcpServerRepository.setZeroTrustMode.mockResolvedValue(updated);

    const app = buildApp();
    const res = await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/enable`);

    expect(res.status).toBe(200);
    const body = res.body as { server: { zero_trust_mode: boolean } };
    expect(body.server.zero_trust_mode).toBe(true);
  });

  it('writes a zero_trust_change provenance node', async () => {
    const original = makeMcpServer({ zero_trust_mode: false });
    const updated  = makeMcpServer({ zero_trust_mode: true });
    mockMcpServerRepository.getById.mockResolvedValue(original);
    mockMcpServerRepository.setZeroTrustMode.mockResolvedValue(updated);

    const app = buildApp();
    await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/enable`);

    expect(mockProvenanceRepository.writeNode).toHaveBeenCalledOnce();
    const call = mockProvenanceRepository.writeNode.mock.calls[0]?.[0] as {
      nodeType: string;
      payload: { from: boolean; to: boolean };
    };
    expect(call.nodeType).toBe('zero_trust_change');
    expect(call.payload.from).toBe(false);
    expect(call.payload.to).toBe(true);
  });

  it('returns 403 when the caller does not own the server', async () => {
    const otherOwnerServer = makeMcpServer({ user_id: OTHER_USER_ID });
    mockMcpServerRepository.getById.mockResolvedValue(otherOwnerServer);

    const app = buildApp(USER_ID); // authenticated as USER_ID, server owned by OTHER_USER_ID
    const res = await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/enable`);

    expect(res.status).toBe(403);
    expect(mockMcpServerRepository.setZeroTrustMode).not.toHaveBeenCalled();
    expect(mockProvenanceRepository.writeNode).not.toHaveBeenCalled();
  });

  it('returns 404 when the server does not exist', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/enable`);

    expect(res.status).toBe(404);
  });

  it('returns 400 when the id is not a valid UUID', async () => {
    const app = buildApp();
    const res = await request(app, 'POST', '/api/capabilities/not-a-uuid/zero-trust/enable');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/capabilities/:id/zero-trust/disable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProvenanceRepository.writeNode.mockResolvedValue({ id: 'prov-node-002' });
  });

  it('disables zero-trust mode and returns the updated server', async () => {
    const original = makeMcpServer({ zero_trust_mode: true });
    const updated  = makeMcpServer({ zero_trust_mode: false });
    mockMcpServerRepository.getById.mockResolvedValue(original);
    mockMcpServerRepository.setZeroTrustMode.mockResolvedValue(updated);

    const app = buildApp();
    const res = await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/disable`);

    expect(res.status).toBe(200);
    const body = res.body as { server: { zero_trust_mode: boolean } };
    expect(body.server.zero_trust_mode).toBe(false);
  });

  it('writes a provenance node with from:true to:false payload', async () => {
    const original = makeMcpServer({ zero_trust_mode: true });
    const updated  = makeMcpServer({ zero_trust_mode: false });
    mockMcpServerRepository.getById.mockResolvedValue(original);
    mockMcpServerRepository.setZeroTrustMode.mockResolvedValue(updated);

    const app = buildApp();
    await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/disable`);

    const call = mockProvenanceRepository.writeNode.mock.calls[0]?.[0] as {
      nodeType: string;
      payload: { from: boolean; to: boolean };
    };
    expect(call.nodeType).toBe('zero_trust_change');
    expect(call.payload.from).toBe(true);
    expect(call.payload.to).toBe(false);
  });

  it('returns 404 for an uninstalled server', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(makeMcpServer({ status: 'uninstalled' }));

    const app = buildApp();
    const res = await request(app, 'POST', `/api/capabilities/${SERVER_ID}/zero-trust/disable`);

    expect(res.status).toBe(404);
  });
});
