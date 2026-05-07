/**
 * Tests for tier promotion ceremony endpoints (issue #177).
 *
 * POST /api/capabilities/:id/promote-tier
 * POST /api/capabilities/:id/decline-promotion
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
    evaluateProgression: vi.fn().mockReturnValue({
      shouldChange: true,
      currentTier: 'observer',
      recommendedTier: 'suggest',
      direction: 'promotion',
      reason: 'Met threshold.',
    }),
    evaluateRegression: vi.fn().mockReturnValue({ shouldChange: false, currentTier: 'observer', reason: 'No regression.' }),
    evaluate: vi.fn().mockReturnValue({ shouldChange: false, currentTier: 'observer', reason: 'Stable.' }),
  })),
}));

vi.mock('@skytwin/shared-types', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    PROMOTION_THRESHOLDS: {
      observer: { consecutiveApprovals: 10, minApprovalRatio: 0.8, nextTier: 'suggest' },
      suggest: { consecutiveApprovals: 20, minApprovalRatio: 0.85, nextTier: 'low_autonomy' },
      low_autonomy: { consecutiveApprovals: 50, minApprovalRatio: 0.9, nextTier: 'moderate_autonomy' },
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

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const USER_ID   = 'ffffffff-eeee-dddd-cccc-000000000001';

const SERVER_ROW = {
  id: SERVER_ID,
  user_id: USER_ID,
  registry_id: 'linear-mcp',
  display_name: 'Linear',
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

describe('POST /api/capabilities/:id/promote-tier', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('happy path: promotes observer → suggest when thresholds are met', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);
    // query mock for stats (2 calls: total stats + recent actions)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '15', approved: '14' }] })
      .mockResolvedValueOnce({ rows: Array(12).fill({ payload: { approved: true } }) });
    const promoted = { ...SERVER_ROW, trust_tier: 'suggest' };
    mockMcpServerRepository.updateTrustTier.mockResolvedValue(promoted);
    mockProvenanceRepository.writeNode.mockResolvedValue({ id: 'node-1', node_type: 'tier_promotion' });

    const { status, body } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/promote-tier`, { toTier: 'suggest' });

    expect(status).toBe(200);
    expect((body as { server: { trust_tier: string } }).server.trust_tier).toBe('suggest');
    expect(mockMcpServerRepository.updateTrustTier).toHaveBeenCalledWith(SERVER_ID, 'suggest');
    expect(mockProvenanceRepository.writeNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeType: 'tier_promotion' }),
    );
  });

  it('returns 409 when threshold is not met', async () => {
    const { TrustTierEngine } = await import('@skytwin/policy-engine');
    (TrustTierEngine as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      evaluateProgression: vi.fn().mockReturnValue({
        shouldChange: false,
        currentTier: 'observer',
        reason: 'Need more approvals.',
      }),
    }));

    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);
    mockQuery.mockResolvedValue({ rows: [{ total: '2', approved: '1' }] });

    const { status, body } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/promote-tier`, { toTier: 'suggest' });

    expect(status).toBe(409);
    expect(String((body as { error: string }).error).toLowerCase()).toMatch(/threshold/);
    expect(mockMcpServerRepository.updateTrustTier).not.toHaveBeenCalled();
  });

  it('returns 403 when caller does not own the server', async () => {
    mockMcpServerRepository.getById.mockResolvedValue({
      ...SERVER_ROW,
      user_id: 'other-user-id',
    });

    const { status } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/promote-tier`, { toTier: 'suggest' });
    expect(status).toBe(403);
  });

  it('returns 409 when toTier is not the next legal tier (skipping tiers)', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);

    const { status, body } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/promote-tier`, { toTier: 'high_autonomy' });

    expect(status).toBe(409);
    expect(String((body as { error: string }).error).toLowerCase()).toMatch(/cannot promote/);
  });
});

describe('POST /api/capabilities/:id/decline-promotion', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets auto_promote_paused_until and returns the updated server', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);
    const paused = { ...SERVER_ROW, auto_promote_paused_until: new Date(Date.now() + 14 * 86_400_000) };
    mockMcpServerRepository.pauseAutoPromotion.mockResolvedValue(paused);

    const { status, body } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/decline-promotion`, { disableForDays: 14 });

    expect(status).toBe(200);
    expect((body as { server: unknown }).server).toBeDefined();
    expect(mockMcpServerRepository.pauseAutoPromotion).toHaveBeenCalledWith(
      SERVER_ID,
      expect.any(Date),
    );
  });

  it('defaults to 14 days when disableForDays is not provided', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(SERVER_ROW);
    mockMcpServerRepository.pauseAutoPromotion.mockResolvedValue(SERVER_ROW);

    await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/decline-promotion`, {});

    const calledWith = mockMcpServerRepository.pauseAutoPromotion.mock.calls[0]?.[1] as Date;
    const diffDays = (calledWith.getTime() - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(13.9);
    expect(diffDays).toBeLessThan(14.1);
  });

  it('returns 403 when caller does not own the server', async () => {
    mockMcpServerRepository.getById.mockResolvedValue({
      ...SERVER_ROW,
      user_id: 'other-user-id',
    });

    const { status } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/decline-promotion`, { disableForDays: 7 });
    expect(status).toBe(403);
  });

  it('returns 404 when server not found', async () => {
    mockMcpServerRepository.getById.mockResolvedValue(null);

    const { status } = await req(buildApp(), 'POST', `/api/capabilities/${SERVER_ID}/decline-promotion`, { disableForDays: 7 });
    expect(status).toBe(404);
  });
});
