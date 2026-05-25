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
  acceptAtomic: vi.fn(),
  listOfferedSince: vi.fn(),
};
const mockSseEmit = vi.fn();

vi.mock('@skytwin/db', () => ({
  promotionOffersRepository: mockPromotionOffersRepository,
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
        user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
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
    const { status, body } = await request(app, 'GET', '/promotion-offers/aaaaaaaa-bbbb-cccc-dddd-000000000002');
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
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'unknown-thing',
    });
    expect(status).toBe(400);
    expect(String(body['error'])).toContain('Invalid response');
  });

  it('404 when the offer does not exist', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue(null);
    const app = makeApp();
    const { status } = await request(app, 'POST', '/promotion-offers/o-missing/respond', {
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
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
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'accepted',
    });
    expect(status).toBe(403);
  });

  it('409 when the offer was already responded to (non-accept path uses findById guard)', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      responded_at: new Date('2026-05-17T00:00:00Z'),
      response: 'rejected',
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'rejected',
    });
    expect(status).toBe(409);
    expect(body['response']).toBe('rejected');
  });

  it('on accept: defers to acceptAtomic (single transaction guards offer state + server tier + tier bump)', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockPromotionOffersRepository.acceptAtomic.mockResolvedValue({
      row: { id: 'o-1', response: 'accepted' },
      alreadyResponded: false,
      staleSnapshot: false,
      serverMissing: false,
      notFound: false,
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'accepted',
    });
    expect(status).toBe(200);
    expect(body['promotionApplied']).toBe(true);
    expect(mockPromotionOffersRepository.acceptAtomic).toHaveBeenCalledWith({
      offerId: 'o-1',
      serverId: 's-1',
      expectedCurrentTier: 'observer',
      proposedTier: 'suggest',
    });
  });

  it('on accept with stale snapshot: acceptAtomic returns staleSnapshot → 409 (cleanup happens inside acceptAtomic)', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockPromotionOffersRepository.acceptAtomic.mockResolvedValue({
      row: null,
      alreadyResponded: false,
      staleSnapshot: true,
      serverMissing: false,
      notFound: false,
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'accepted',
    });
    expect(status).toBe(409);
    expect(String(body['error'])).toContain('Server tier has changed');
    // markResponded is NOT called from the route — acceptAtomic does
    // the cleanup inside its transaction.
    expect(mockPromotionOffersRepository.markResponded).not.toHaveBeenCalled();
  });

  it('on accept with concurrent already-responded: acceptAtomic returns alreadyResponded → 409', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockPromotionOffersRepository.acceptAtomic.mockResolvedValue({
      row: { id: 'o-1', response: 'accepted' },
      alreadyResponded: true,
      staleSnapshot: false,
      serverMissing: false,
      notFound: false,
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'accepted',
    });
    expect(status).toBe(409);
    expect(body['response']).toBe('accepted');
  });

  it('on accept with server missing: acceptAtomic returns serverMissing → 409', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      server_id: 's-1',
      current_tier: 'observer',
      proposed_tier: 'suggest',
      responded_at: null,
    });
    mockPromotionOffersRepository.acceptAtomic.mockResolvedValue({
      row: null,
      alreadyResponded: false,
      staleSnapshot: false,
      serverMissing: true,
      notFound: false,
    });
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/promotion-offers/o-1/respond', {
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'accepted',
    });
    expect(status).toBe(409);
    expect(String(body['error'])).toContain('Server no longer exists');
  });

  it('on rejected/dismissed: marks responded without invoking acceptAtomic', async () => {
    mockPromotionOffersRepository.findById.mockResolvedValue({
      id: 'o-1',
      user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
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
      userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
      response: 'rejected',
    });
    expect(status).toBe(200);
    expect(body['promotionApplied']).toBe(false);
    expect(mockPromotionOffersRepository.acceptAtomic).not.toHaveBeenCalled();
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
        user_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002',
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
    expect(userId).toBe('aaaaaaaa-bbbb-cccc-dddd-000000000002');
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
