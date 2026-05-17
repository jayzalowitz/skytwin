/**
 * Tests for the worker→API bridge promotion-offers routes (#310).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mockPromotionOffersRepository = {
  listPending: vi.fn(),
  listPendingWithServerName: vi.fn(),
  findById: vi.fn(),
  markResponded: vi.fn(),
  listOfferedSince: vi.fn(),
};
const mockMcpServerRepository = {
  getById: vi.fn(),
  updateTrustTier: vi.fn(),
};
const mockSseEmit = vi.fn();

vi.mock('@skytwin/db', () => ({
  promotionOffersRepository: mockPromotionOffersRepository,
  mcpServerRepository: mockMcpServerRepository,
}));

vi.mock('../sse.js', () => ({
  sseManager: { emit: (...args: unknown[]) => mockSseEmit(...args) },
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability:promotion-offered',
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

const {
  createPromotionOffersRouter,
  sweepPromotionOffersOnce,
} = await import('../routes/promotion-offers.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/promotion-offers', createPromotionOffersRouter());
  return app;
}

async function request(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req: Partial<express.Request> = {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      body: body ?? {},
    } as Partial<express.Request>;
    let status = 200;
    let resp: Record<string, unknown> = {};
    const res = {
      status(code: number) { status = code; return res; },
      json(payload: Record<string, unknown>) { resp = payload; resolve({ status, body: resp }); return res; },
      send(payload: unknown) { resp = payload as Record<string, unknown>; resolve({ status, body: resp }); return res; },
      setHeader: () => res,
      end: () => resolve({ status, body: resp }),
    } as unknown as express.Response;
    app(req as express.Request, res as express.Response, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ status, body: resp });
    });
  });
}

describe('GET /promotion-offers/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pending offers with serverName', async () => {
    mockPromotionOffersRepository.listPendingWithServerName.mockResolvedValue([
      {
        id: 'o-1',
        user_id: 'u-1',
        server_id: 's-1',
        server_name: 'Linear',
        current_tier: 'observer',
        proposed_tier: 'suggest',
        reason: 'Met threshold',
        decisions_observed_count: 20,
        approved_count: 18,
        offered_at: new Date('2026-05-17T00:00:00Z'),
        responded_at: null,
        response: null,
      },
    ]);
    const app = makeApp();
    const { status, body } = await request(app, 'GET', '/promotion-offers/u-1');
    expect(status).toBe(200);
    const offers = body['offers'] as Array<Record<string, unknown>>;
    expect(offers).toHaveLength(1);
    expect(offers[0]!['id']).toBe('o-1');
    expect(offers[0]!['serverName']).toBe('Linear');
    expect(offers[0]!['proposedTier']).toBe('suggest');
  });

  // Missing userId: express's :userId route doesn't match `/promotion-offers/`
  // so the request lands as a 404 from the router, not a 400 from our
  // handler. Not worth pinning the framework's routing behavior in a test.
});

describe('POST /promotion-offers/:offerId/respond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an invalid response value', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'u-1',
      response: 'unknown-thing',
    });
    expect(status).toBe(400);
    expect(String(body['error'])).toContain('Invalid response');
  });

  it('404 when the offer does not exist', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue(null);
    const app = makeApp();
    const { status } = await request(app, 'POST', '/promotion-offers/o-missing/respond', {
      userId: 'u-1',
      response: 'accepted',
    });
    expect(status).toBe(404);
  });

  it('403 when the offer belongs to a different user', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'u-other',
      responded_at: null,
    });
    const app = makeApp();
    const { status } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'u-1',
      response: 'accepted',
    });
    expect(status).toBe(403);
  });

  it('409 when the offer was already responded to', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'u-1',
      responded_at: new Date('2026-05-17T00:00:00Z'),
      response: 'accepted',
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'u-1',
      response: 'accepted',
    });
    expect(status).toBe(409);
    expect(body['response']).toBe('accepted');
  });

  it('on accept: validates server still at snapshot tier, then promotes', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'u-1',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockMcpServerRepository.getById.mockResolvedValue({
      id: 's-1',
      trust_tier: 'observer',
    });
    mockPromotionOffersRepository.markResponded.mockResolvedValue({
      id: 'o-1',
      response: 'accepted',
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'u-1',
      response: 'accepted',
    });
    expect(status).toBe(200);
    expect(body['promotionApplied']).toBe(true);
    expect(mockMcpServerRepository.updateTrustTier).toHaveBeenCalledWith('s-1', 'suggest');
    expect(mockPromotionOffersRepository.markResponded).toHaveBeenCalledWith('o-1', 'accepted');
  });

  it('on accept with stale snapshot: refuses promotion + marks responded=rejected', async () => {
    // Admin demoted the server between offer creation and the user's
    // Accept click. Accepting the stale offer would jump the tier
    // unexpectedly — we MUST refuse and clean up the stale offer so
    // it doesn't keep prompting.
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'u-1',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockMcpServerRepository.getById.mockResolvedValue({
      id: 's-1',
      trust_tier: 'low_autonomy', // different from snapshot
    });
    mockPromotionOffersRepository.markResponded.mockResolvedValue({ id: 'o-1' });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'u-1',
      response: 'accepted',
    });
    expect(status).toBe(409);
    expect(String(body['error'])).toContain('Server tier has changed');
    expect(mockMcpServerRepository.updateTrustTier).not.toHaveBeenCalled();
    expect(mockPromotionOffersRepository.markResponded).toHaveBeenCalledWith('o-1', 'rejected');
  });

  it('on rejected/dismissed: marks responded without touching mcp_servers', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'u-1',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockPromotionOffersRepository.markResponded.mockResolvedValue({
      id: 'o-1',
      response: 'rejected',
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'u-1',
      response: 'rejected',
    });
    expect(status).toBe(200);
    expect(body['promotionApplied']).toBe(false);
    expect(mockMcpServerRepository.updateTrustTier).not.toHaveBeenCalled();
  });
});

describe('sweepPromotionOffersOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits SSE for each newly-offered row', async () => {
    mockPromotionOffersRepository.listOfferedSince.mockResolvedValue([
      {
        id: 'o-1',
        user_id: 'u-1',
        server_id: 's-1',
        server_name: 'Linear',
        current_tier: 'observer',
        proposed_tier: 'suggest',
        reason: 'Met threshold',
        decisions_observed_count: 20,
        approved_count: 18,
        offered_at: new Date(),
        responded_at: null,
        response: null,
      },
    ]);
    const count = await sweepPromotionOffersOnce();
    expect(count).toBe(1);
    expect(mockSseEmit).toHaveBeenCalledTimes(1);
    const [userId, event, payload] = mockSseEmit.mock.calls[0]!;
    expect(userId).toBe('u-1');
    expect(event).toBe('capability:promotion-offered');
    expect((payload as Record<string, unknown>)['offerId']).toBe('o-1');
    expect((payload as Record<string, unknown>)['serverName']).toBe('Linear');
  });

  it('returns 0 and swallows errors when the repo fails', async () => {
    mockPromotionOffersRepository.listOfferedSince.mockRejectedValue(
      new Error('CRDB pool exhausted'),
    );
    const count = await sweepPromotionOffersOnce();
    expect(count).toBe(0);
    expect(mockSseEmit).not.toHaveBeenCalled();
  });
});
