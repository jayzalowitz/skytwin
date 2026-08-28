import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

/**
 * Tests for the session-auth middleware and require-ownership middleware.
 *
 * Uses vi.mock to stub the session repository, and directly invokes the
 * middleware functions with mock req/res/next objects.
 */

// Stub the session repository before importing the middleware
vi.mock('@skytwin/db', () => ({
  sessionRepository: {
    findByTokenHash: vi.fn(),
    refreshExpiry: vi.fn(),
    touchLastActive: vi.fn(),
  },
}));

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '192.168.1.100', // non-localhost by default
    socket: { remoteAddress: '192.168.1.100' },
    headers: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('sessionAuth middleware', () => {
  let sessionAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;

  const savedEnv = {
    SKYTWIN_DEV_AUTH_BYPASS: process.env['SKYTWIN_DEV_AUTH_BYPASS'],
    SKYTWIN_SERVICE_TOKEN: process.env['SKYTWIN_SERVICE_TOKEN'],
  };

  beforeEach(async () => {
    // Reset env for each test
    delete process.env['SKYTWIN_DEV_AUTH_BYPASS'];
    delete process.env['SKYTWIN_SERVICE_TOKEN'];

    // Fresh import to pick up env changes
    vi.resetModules();

    // Re-mock after resetModules
    vi.doMock('@skytwin/db', () => ({
      sessionRepository: {
        findByTokenHash: vi.fn(),
        refreshExpiry: vi.fn(),
        touchLastActive: vi.fn(),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Don't leak env state into sibling test files that share this process.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects remote requests without Authorization header', async () => {
    // Force bypass off
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects remote requests with invalid token', async () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;
    const db = await import('@skytwin/db');
    (db.sessionRepository.findByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = mockReq({ headers: { authorization: 'Bearer bad-token' } });
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('attaches userId to request on valid session', async () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;
    const db = await import('@skytwin/db');
    (db.sessionRepository.findByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'session-1',
      user_id: 'user-abc',
      expires_at: new Date(Date.now() + 86400000 * 3), // 3 days from now
    });
    (db.sessionRepository.touchLastActive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const req = mockReq({ headers: { authorization: 'Bearer good-token' } });
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authenticatedUserId).toBe('user-abc');
    expect(req.authenticatedSessionId).toBe('session-1');
  });

  it('accepts token from query string for EventSource-based clients', async () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;
    const db = await import('@skytwin/db');
    (db.sessionRepository.findByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'session-2',
      user_id: 'user-sse',
      expires_at: new Date(Date.now() + 86400000 * 3),
    });
    (db.sessionRepository.touchLastActive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const req = mockReq({ query: { token: 'sse-token' } });
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authenticatedUserId).toBe('user-sse');
  });

  it('rejects expired sessions', async () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;
    const db = await import('@skytwin/db');
    (db.sessionRepository.findByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'session-1',
      user_id: 'user-abc',
      expires_at: new Date(Date.now() - 1000), // expired
    });

    const req = mockReq({ headers: { authorization: 'Bearer expired-token' } });
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('allows localhost when dev bypass is explicitly enabled', async () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'true';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;

    const req = mockReq({ ip: '127.0.0.1' });
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authenticatedUserId).toBeUndefined(); // no session in bypass mode
  });

  it('requires auth for localhost when bypass is disabled', async () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
    const mod = await import('../middleware/session-auth.js');
    sessionAuth = mod.sessionAuth;

    const req = mockReq({ ip: '127.0.0.1' });
    const res = mockRes();
    const next = vi.fn();

    await sessionAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // -------------------------------------------------------------------
  // Loopback service credential (worker / idle-miner). Distinct from the
  // dev bypass and available in production — without it a packaged build
  // 401s every /api/events/ingest POST and the product ingests nothing.
  // -------------------------------------------------------------------
  describe('SKYTWIN_SERVICE_TOKEN loopback credential', () => {
    const TOKEN = 'f'.repeat(64);
    const INGEST = '/api/events/ingest';

    async function loadWithBypassOff(): Promise<
      (req: Request, res: Response, next: NextFunction) => Promise<void>
    > {
      process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
      const mod = await import('../middleware/session-auth.js');
      return mod.sessionAuth;
    }

    /**
     * A service request as the worker actually sends it: dedicated header,
     * loopback SOCKET (not just `req.ip`), and an allowlisted route.
     */
    function serviceReq(overrides: Partial<Request> = {}): Request {
      return mockReq({
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        originalUrl: INGEST,
        headers: { 'x-skytwin-service-token': TOKEN },
        ...overrides,
      } as Partial<Request>);
    }

    async function run(req: Request): Promise<{ res: Response; next: ReturnType<typeof vi.fn> }> {
      const res = mockRes();
      const next = vi.fn();
      await sessionAuth(req, res, next);
      return { res, next };
    }

    it('accepts a matching token from a loopback socket on the ingest route', async () => {
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq();
      const { next } = await run(req);

      expect(next).toHaveBeenCalled();
      expect(req.serviceAuthenticated).toBe(true);
      // No human identity is bound — the daemons act for every user.
      expect(req.authenticatedUserId).toBeUndefined();
      expect(req.authenticatedSessionId).toBeUndefined();
    });

    it('rejects a non-matching token of the same length', async () => {
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({ headers: { 'x-skytwin-service-token': 'e'.repeat(64) } });
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(req.serviceAuthenticated).toBeUndefined();
    });

    it('rejects a token of a different length without throwing (timingSafeEqual guard)', async () => {
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({ headers: { 'x-skytwin-service-token': 'short' } });
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects the credential on the Authorization header (web-proxy laundering)', async () => {
      // apps/web forwards `Authorization` verbatim to the API over a fresh
      // localhost connection. A credential on that header could therefore be
      // POSTed to the dashboard port by a remote caller and arrive looking
      // like loopback. The proxy does not forward `x-skytwin-service-token`.
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({ headers: { authorization: `Bearer ${TOKEN}` } });
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(req.serviceAuthenticated).toBeUndefined();
    });

    it('rejects the credential on a NON-allowlisted route (no cross-user bypass)', async () => {
      // `requireOwnership` skips its check for a service-authenticated request
      // and guards ~33 routers, so without the allowlist this credential would
      // be a cross-user read/write capability, not an ingest key.
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({ originalUrl: '/api/settings/some-user-id' });
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(req.serviceAuthenticated).toBeUndefined();
    });

    it('ignores a spoofed X-Forwarded-For and reads the raw socket instead', async () => {
      // `req.ip` honours `trust proxy`; the socket address does not. A remote
      // client claiming `X-Forwarded-For: 127.0.0.1` must not pass.
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({
        ip: '127.0.0.1',
        socket: { remoteAddress: '203.0.113.7' },
      } as Partial<Request>);
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(req.serviceAuthenticated).toBeUndefined();
    });

    it('does not accept the service token via the ?token= query fallback', async () => {
      process.env['SKYTWIN_SERVICE_TOKEN'] = TOKEN;
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({ headers: {}, query: { token: TOKEN } } as Partial<Request>);
      const { next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(req.serviceAuthenticated).toBeUndefined();
    });

    it('grants nothing when SKYTWIN_SERVICE_TOKEN is unset', async () => {
      delete process.env['SKYTWIN_SERVICE_TOKEN'];
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq();
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(req.serviceAuthenticated).toBeUndefined();
    });

    it('grants nothing when SKYTWIN_SERVICE_TOKEN is an empty string', async () => {
      process.env['SKYTWIN_SERVICE_TOKEN'] = '';
      sessionAuth = await loadWithBypassOff();

      const req = serviceReq({ headers: { 'x-skytwin-service-token': '' } });
      const { res, next } = await run(req);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});

describe('requireOwnership middleware', () => {
  let requireOwnership: (req: Request, res: Response, next: NextFunction) => void;

  beforeEach(async () => {
    const mod = await import('../middleware/require-ownership.js');
    requireOwnership = mod.requireOwnership;
  });

  it('allows when authenticated user matches :userId', () => {
    const req = mockReq({ params: { userId: 'user-abc' } });
    req.authenticatedUserId = 'user-abc';
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks when authenticated user does not match :userId', () => {
    const req = mockReq({ params: { userId: 'user-abc' } });
    req.authenticatedUserId = 'user-other';
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks when authenticated user does not match body.userId', () => {
    const req = mockReq({ body: { userId: 'user-abc' } });
    req.authenticatedUserId = 'user-other';
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks when authenticated user does not match query.userId', () => {
    const req = mockReq({ query: { userId: 'user-abc' } });
    req.authenticatedUserId = 'user-other';
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('skips check when authenticatedUserId is undefined (dev bypass)', () => {
    const req = mockReq({ params: { userId: 'user-abc' } });
    // authenticatedUserId not set — dev bypass
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('skips check when no :userId param in route', () => {
    const req = mockReq({ params: {} });
    req.authenticatedUserId = 'user-abc';
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('skips check for a service-authenticated request (worker forwards for every user)', () => {
    const req = mockReq({ body: { userId: 'user-abc' } });
    req.serviceAuthenticated = true;
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still enforces ownership for a human session even if a service flag is absent', () => {
    const req = mockReq({ params: { userId: 'user-xyz' } });
    req.authenticatedUserId = 'user-abc';
    req.serviceAuthenticated = false;
    const res = mockRes();
    const next = vi.fn();

    requireOwnership(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
