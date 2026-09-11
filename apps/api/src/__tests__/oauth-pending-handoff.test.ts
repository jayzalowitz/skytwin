import express from 'express';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  withTransaction: vi.fn(),
  saveTokenForAccount: vi.fn(),
  rememberPending: vi.fn(),
  sweepExpired: vi.fn().mockResolvedValue(0),
  findByEmail: vi.fn(),
  createUser: vi.fn(),
  exchangeCode: vi.fn(),
  PendingSigninCollisionError: class PendingSigninCollisionError extends Error {
    readonly code = 'oauth_pending_signin_collision';
  },
  logWarn: vi.fn(),
}));

vi.mock('@skytwin/core', () => ({
  createLogger: () => ({ warn: mocks.logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: () => ({
    googleClientId: 'client-id',
    googleClientSecret: 'client-secret',
    googleRedirectUri: 'http://localhost/api/oauth/google/callback',
  }),
}));

vi.mock('@skytwin/connectors', () => ({
  generateAuthUrl: vi.fn(),
  generatePkcePair: vi.fn(),
  exchangeCode: mocks.exchangeCode,
  revokeToken: vi.fn(),
  fetchGoogleProfileSync: vi.fn().mockResolvedValue({
    language: 'en', timezone: 'UTC', languageDefaulted: true, timezoneDefaulted: true,
  }),
  microsoftOAuth: {
    generatePkcePair: vi.fn(), generateAuthUrl: vi.fn(), exchangeCode: vi.fn(), fetchUserInfo: vi.fn(),
  },
  MICROSOFT_GRAPH_SCOPES: [],
}));

vi.mock('@skytwin/db', () => ({
  withTransaction: mocks.withTransaction,
  oauthRepository: {
    saveTokenForAccount: mocks.saveTokenForAccount,
    getToken: vi.fn(), listAccountsForUser: vi.fn(), deleteAllForProvider: vi.fn(), deleteAccount: vi.fn(),
  },
  oauthPkcePendingRepository: {
    consume: vi.fn().mockResolvedValue('verifier'), remember: vi.fn(), sweepExpired: vi.fn().mockResolvedValue(0),
  },
  oauthPendingSigninRepository: {
    remember: mocks.rememberPending,
    sweepExpired: mocks.sweepExpired,
  },
  PendingSigninCollisionError: mocks.PendingSigninCollisionError,
  serviceCredentialRepository: { getAsMap: vi.fn().mockResolvedValue({}) },
  userRepository: {
    findByEmail: mocks.findByEmail,
    findById: vi.fn(),
    create: mocks.createUser,
    updateLocale: vi.fn(),
  },
  sessionRepository: {
    findByTokenHash: vi.fn(), refreshExpiry: vi.fn(), touchLastActive: vi.fn(),
  },
}));

const {
  _resetNewUserRateLimitForTests,
  _signStatePayloadForTests,
  _stateTtlMsForTests,
  createOAuthRouter,
  derivePendingCapabilityDigest,
  derivePendingSessionToken,
} = await import('../routes/oauth.js');
const nativeFetch = globalThis.fetch;

interface HttpResult {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  text: string;
}

async function request(
  app: express.Express,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<HttpResult> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  try {
    const response = await nativeFetch(`http://127.0.0.1:${address.port}${path}`, {
      redirect: 'manual',
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const responseText = await response.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(responseText) as Record<string, unknown>; } catch { /* HTML or empty */ }
    return { status: response.status, headers: response.headers, body, text: responseText };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/oauth', createOAuthRouter());
  instance.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  return instance;
}

const KEY = '550e8400-e29b-41d4-a716-446655440000';
const DIGEST = derivePendingCapabilityDigest(KEY);
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('Google pending sign-in durable handoff', () => {
  it('uses the browser-compatible domain-separated digest', () => {
    expect(DIGEST).toBe('a1e2b7f67d6cdd3b14fcb72990395bb7fc3bced3284fd7ea99eb7bfa3c68c087');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockReset();
    mocks.withTransaction.mockReset();
    mocks.rememberPending.mockReset();
    _resetNewUserRateLimitForTests();
    mocks.withTransaction.mockImplementation(async (operation: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) =>
      operation({ query: mocks.clientQuery }));
    mocks.findByEmail.mockResolvedValue(null);
    mocks.createUser.mockResolvedValue({ id: USER_ID, trust_tier: 'observer' });
    mocks.exchangeCode.mockResolvedValue({
      accessToken: 'access-token', refreshToken: 'refresh-token',
      expiresAt: new Date('2026-09-11T00:00:00Z'), scopes: ['openid', 'email'],
    });
    mocks.saveTokenForAccount.mockResolvedValue({});
    mocks.rememberPending.mockResolvedValue(undefined);
    mocks.sweepExpired.mockResolvedValue(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'google-subject', email: 'person@example.com', verified_email: true, name: 'Person',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fails the callback when the transactional pending write fails instead of redirecting success', async () => {
    mocks.rememberPending.mockRejectedValueOnce(new Error('pending write failed'));
    const state = _signStatePayloadForTests(`new|key_digest=${DIGEST}`, Date.now() + _stateTtlMsForTests);
    const result = await request(app(), `/api/oauth/google/callback?code=one-shot&state=${encodeURIComponent(state)}`);

    expect(result.status).toBe(500);
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    const transactionClient = mocks.saveTokenForAccount.mock.calls[0]?.[1];
    expect(transactionClient).toBeTruthy();
    expect(mocks.rememberPending.mock.calls[0]?.[1]).toBe(transactionClient);
    expect(mocks.rememberPending.mock.calls[0]?.[0]).toMatchObject({ pendingKeyDigest: DIGEST });
    expect(JSON.stringify(mocks.rememberPending.mock.calls)).not.toContain(KEY);
  });

  it('returns a stable typed failure when the immutable capability digest collides', async () => {
    mocks.rememberPending.mockRejectedValueOnce(new mocks.PendingSigninCollisionError());
    const state = _signStatePayloadForTests(`new|key_digest=${DIGEST}`, Date.now() + _stateTtlMsForTests);
    const result = await request(app(), `/api/oauth/google/callback?code=one-shot&state=${encodeURIComponent(state)}`);
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'oauth_pending_signin_collision' });
    expect(JSON.stringify(result.body)).not.toContain(KEY);
  });

  it('renders the close-and-return page for a browser callback with a pending digest', async () => {
    const state = _signStatePayloadForTests(`new|key_digest=${DIGEST}`, Date.now() + _stateTtlMsForTests);
    const result = await request(app(), `/api/oauth/google/callback?code=one-shot&state=${encodeURIComponent(state)}`);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toMatch(/^text\/html/);
    expect(result.headers.get('location')).toBeNull();
    expect(result.text).toContain('background:#0E0F13;color:#ECEDF1');
    expect(result.text).toContain('font-family:Geist,ui-sans-serif,sans-serif');
    expect(result.text).toContain('close this window and return to SkyTwin');
    expect(mocks.rememberPending).toHaveBeenCalledWith(
      expect.objectContaining({ pendingKeyDigest: DIGEST }),
      expect.anything(),
    );
  });

  it('keeps the established redirect for a non-pending browser callback', async () => {
    const state = _signStatePayloadForTests(USER_ID, Date.now() + _stateTtlMsForTests);
    const result = await request(app(), `/api/oauth/google/callback?code=existing&state=${encodeURIComponent(state)}`);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toMatch(/\?userId=.*#\/\?connected=google/);
    expect(mocks.rememberPending).not.toHaveBeenCalled();
  });

  it('returns the same session after a lost first response and never caches capability responses', async () => {
    const pendingBase = {
      user_id: USER_ID,
      account_email: 'person@example.com',
      scopes: ['openid', 'email'],
      next_hash: '#/connect-gmail',
      expires_at: new Date(Date.now() + 60_000),
    };
    const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ ...pendingBase, session_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...pendingBase, session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [{ expires_at: sessionExpiresAt }] });

    const first = await request(app(), '/api/oauth/google/pending', { method: 'POST', body: { pendingKey: KEY } });
    const retry = await request(app(), '/api/oauth/google/pending', { method: 'POST', body: { pendingKey: KEY } });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(first.body['sessionToken']).toBe(derivePendingSessionToken(KEY));
    expect(retry.body['sessionToken']).toBe(first.body['sessionToken']);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(retry.headers.get('cache-control')).toBe('no-store');
    expect(mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO sessions'))).toHaveLength(1);
    expect(JSON.stringify(mocks.clientQuery.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(KEY);
  });

  it('keeps the capability retryable when first session creation aborts', async () => {
    const pending = {
      user_id: USER_ID, account_email: 'person@example.com', scopes: [], next_hash: null,
      expires_at: new Date(Date.now() + 60_000), session_id: null,
    };
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [pending] })
      .mockRejectedValueOnce(new Error('session insert failed'))
      .mockResolvedValueOnce({ rows: [pending] })
      .mockResolvedValueOnce({ rows: [{ id: 'session-2' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const failed = await request(app(), '/api/oauth/google/pending', { method: 'POST', body: { pendingKey: KEY } });
    const retried = await request(app(), '/api/oauth/google/pending', { method: 'POST', body: { pendingKey: KEY } });

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(retried.body['sessionToken']).toBe(derivePendingSessionToken(KEY));
  });

  it('serializes concurrent redemption onto one durable session', async () => {
    let releaseTail = Promise.resolve();
    mocks.withTransaction.mockImplementation(async (operation: (client: { query: typeof mocks.clientQuery }) => Promise<unknown>) => {
      const prior = releaseTail;
      let release!: () => void;
      releaseTail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        return await operation({ query: mocks.clientQuery });
      } finally {
        release();
      }
    });
    const expiresAt = new Date(Date.now() + 60_000);
    let sessionId: string | null = null;
    let insertCount = 0;
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM oauth_pending_signin')) return { rows: [{
        user_id: USER_ID, account_email: 'person@example.com', scopes: [], next_hash: null,
        expires_at: expiresAt, session_id: sessionId,
      }] };
      if (sql.includes('INSERT INTO sessions')) {
        insertCount += 1;
        return { rows: [{ id: 'session-concurrent' }] };
      }
      if (sql.includes('UPDATE oauth_pending_signin')) {
        sessionId = 'session-concurrent';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM sessions')) return { rows: [{ expires_at: expiresAt }] };
      throw new Error('unexpected query shape');
    });

    const target = '/api/oauth/google/pending';
    const instance = app();
    const [one, two] = await Promise.all([
      request(instance, target, { method: 'POST', body: { pendingKey: KEY } }),
      request(instance, target, { method: 'POST', body: { pendingKey: KEY } }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body['sessionToken']).toBe(two.body['sessionToken']);
    expect(insertCount).toBe(1);
    expect(JSON.stringify(mocks.clientQuery.mock.calls)).not.toContain(KEY);
  });

  it('does not expose the capability in a request target and removes legacy GET redemption', async () => {
    mocks.clientQuery.mockResolvedValue({ rows: [] });
    const legacy = await request(app(), `/api/oauth/google/pending/${KEY}`);
    expect(legacy.status).not.toBe(200);
    const target = '/api/oauth/google/pending';
    expect(target).not.toContain(KEY);
    const missing = await request(app(), target, { method: 'POST', body: { pendingKey: KEY } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });
});
