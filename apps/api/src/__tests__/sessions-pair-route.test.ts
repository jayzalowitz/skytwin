/**
 * Tests for the QR pairing token + consume route (#385).
 *
 * Locks the wire contract:
 *   - POST /api/sessions mints a 5-minute pairing token (not a session)
 *   - POST /api/sessions/pair/consume exchanges it for a session
 *   - Expired / used / unknown tokens return the documented HTTP codes
 *   - Device name from consume body overrides the issue-time default
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mockSessionRepository = {
  create: vi.fn(),
  findActiveByUser: vi.fn(),
  findByTokenHash: vi.fn(),
  revoke: vi.fn(),
};

vi.mock('@skytwin/db', () => ({
  sessionRepository: mockSessionRepository,
}));

vi.mock('../middleware/session-auth.js', () => ({
  sessionAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  hashToken: (t: string) => `hashed:${t}`,
}));

vi.mock('../middleware/require-ownership.js', () => ({
  requireOwnership: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const { createSessionsRouter } = await import('../routes/sessions.js');
const { __resetPairingTokenStoreForTests } = await import('../pairing-token-store.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createSessionsRouter());
  return app;
}

async function request(
  app: Express,
  method: 'POST',
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

beforeEach(() => {
  vi.clearAllMocks();
  __resetPairingTokenStoreForTests();
  mockSessionRepository.create.mockResolvedValue({
    id: 'session-1',
    user_id: 'user-1',
    device_name: 'Phone',
    expires_at: new Date('2027-01-01T00:00:00Z'),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/sessions (#385: now mints a pairing token, not a session)', () => {
  it('returns a 5-minute pairing token + QR URL with pairToken= query param', async () => {
    const app = makeApp();
    const beforeMs = Date.now();
    const { status, body } = await request(app, 'POST', '/api/sessions', { userId: 'user-1' });
    expect(status).toBe(201);
    expect(typeof body['token']).toBe('string');
    // Should embed `pairToken=`, NOT `token=` (the legacy flow).
    expect(String(body['qrUrl'])).toContain('pairToken=');
    expect(String(body['qrUrl'])).not.toContain('token=' + body['token']);
    // Expiry is within ~5 minutes — short-lived by design.
    const expiry = Date.parse(String(body['expiresAt']));
    expect(expiry - beforeMs).toBeGreaterThan(4 * 60 * 1000);
    expect(expiry - beforeMs).toBeLessThan(6 * 60 * 1000);
    // CRITICAL: the existing sessions table is NOT written at QR-mint
    // time anymore — sessions get created on consume.
    expect(mockSessionRepository.create).not.toHaveBeenCalled();
  });

  it('400s on missing userId', async () => {
    const app = makeApp();
    const { status } = await request(app, 'POST', '/api/sessions', {});
    expect(status).toBe(400);
  });
});

describe('POST /api/sessions/pair/consume (#385)', () => {
  it('exchanges a valid pairing token for a session token + persists the session row', async () => {
    const app = makeApp();
    const issued = await request(app, 'POST', '/api/sessions', { userId: 'user-1' });
    const pairToken = issued.body['token'] as string;

    const { status, body } = await request(app, 'POST', '/api/sessions/pair/consume', {
      pairToken,
      deviceName: 'iPad',
    });
    expect(status).toBe(201);
    expect(typeof body['token']).toBe('string');
    expect(body['token']).not.toBe(pairToken); // distinct credential
    expect(body['userId']).toBe('user-1');
    expect(mockSessionRepository.create).toHaveBeenCalledOnce();
    const arg = mockSessionRepository.create.mock.calls[0]![0];
    expect(arg.userId).toBe('user-1');
    expect(arg.deviceName).toBe('iPad'); // body override beats issue-time default
  });

  it('returns 409 already_used on a second consume of the same token (replay defence)', async () => {
    const app = makeApp();
    const issued = await request(app, 'POST', '/api/sessions', { userId: 'user-1' });
    const pairToken = issued.body['token'] as string;

    const first = await request(app, 'POST', '/api/sessions/pair/consume', { pairToken });
    expect(first.status).toBe(201);

    const second = await request(app, 'POST', '/api/sessions/pair/consume', { pairToken });
    expect(second.status).toBe(409);
    expect(second.body['error']).toBe('code_already_used');
    // sessionRepository.create must not be called a second time —
    // a successful replay would mint a second long-lived credential.
    expect(mockSessionRepository.create).toHaveBeenCalledOnce();
  });

  it('returns 410 code_expired once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(new Date(base));

    const app = makeApp();
    const issued = await request(app, 'POST', '/api/sessions', { userId: 'user-1' });
    const pairToken = issued.body['token'] as string;

    // Advance past 5min
    vi.setSystemTime(new Date(base + 6 * 60 * 1000));

    const { status, body } = await request(app, 'POST', '/api/sessions/pair/consume', { pairToken });
    expect(status).toBe(410);
    expect(body['error']).toBe('code_expired');
    expect(mockSessionRepository.create).not.toHaveBeenCalled();
  });

  it('returns 404 code_not_found on an unknown / never-issued token', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/api/sessions/pair/consume', {
      pairToken: 'never-issued-deadbeef',
    });
    expect(status).toBe(404);
    expect(body['error']).toBe('code_not_found');
    expect(mockSessionRepository.create).not.toHaveBeenCalled();
  });

  it('400s on missing pairToken', async () => {
    const app = makeApp();
    const { status } = await request(app, 'POST', '/api/sessions/pair/consume', {});
    expect(status).toBe(400);
  });

  it('keeps the issued device name when the consume body omits it', async () => {
    const app = makeApp();
    const issued = await request(app, 'POST', '/api/sessions', { userId: 'user-1', deviceName: 'Tablet' });
    const pairToken = issued.body['token'] as string;

    const { status } = await request(app, 'POST', '/api/sessions/pair/consume', { pairToken });
    expect(status).toBe(201);
    const arg = mockSessionRepository.create.mock.calls[0]![0];
    expect(arg.deviceName).toBe('Tablet');
  });
});
