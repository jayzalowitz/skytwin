import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
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
  userRepository: { findDemoById: vi.fn() },
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
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    write: vi.fn(() => true),
    end: vi.fn().mockReturnThis(),
    writeHead: vi.fn().mockReturnThis(),
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), String(value));
    }),
    removeHeader: vi.fn((name: string) => {
      headers.delete(name.toLowerCase());
    }),
  } as unknown as Response;
  return res;
}

describe('sessionAuth middleware', () => {
  let sessionAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;

  const savedEnv = {
    SKYTWIN_DEV_AUTH_BYPASS: process.env['SKYTWIN_DEV_AUTH_BYPASS'],
    SKYTWIN_SERVICE_TOKEN: process.env['SKYTWIN_SERVICE_TOKEN'],
    SESSION_SECRET: process.env['SESSION_SECRET'],
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
      userRepository: { findDemoById: vi.fn() },
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

  describe('read-only sample credential', () => {
    async function loadDemoAuth() {
      process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
      process.env['SESSION_SECRET'] = 'test-demo-session-secret-that-is-long-enough';
      const auth = await import('../middleware/session-auth.js');
      const demo = await import('../auth/demo-session.js');
      const db = await import('@skytwin/db');
      (db.userRepository.findDemoById as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: demo.DEMO_USER_ID,
        is_demo: true,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      return { sessionAuth: auth.sessionAuth, issueDemoSession: demo.issueDemoSession };
    }

    it('binds an allowlisted read to the reserved sample identity', async () => {
      const mod = await loadDemoAuth();
      const issued = mod.issueDemoSession();
      const req = mockReq({
        method: 'GET',
        originalUrl: '/api/decisions/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const res = mockRes();
      const next = vi.fn();

      await mod.sessionAuth(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.authenticatedUserId).toBe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
      expect(req.demoAuthenticated).toBe(true);
    });

    it('does not pass authority revoked during the sample marker lookup', async () => {
      const mod = await loadDemoAuth();
      const demo = await import('../auth/demo-session.js');
      const db = await import('@skytwin/db');
      let releaseLookup!: (value: { id: string; is_demo: boolean; created_at: Date }) => void;
      (
        db.userRepository.findDemoById as ReturnType<typeof vi.fn>
      ).mockReturnValueOnce(
        new Promise((resolve) => {
          releaseLookup = resolve;
        }),
      );
      const issued = mod.issueDemoSession();
      const req = mockReq({
        method: 'GET',
        originalUrl: `/api/decisions/${demo.DEMO_USER_ID}`,
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const res = mockRes();
      const next = vi.fn();

      const pending = mod.sessionAuth(req, res, next);
      await vi.waitFor(() =>
        expect(db.userRepository.findDemoById).toHaveBeenCalledOnce(),
      );
      demo.revokeDemoSession(issued.token);
      releaseLookup({
        id: demo.DEMO_USER_ID,
        is_demo: true,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      await pending;

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it.each([
      ['GET', 'discard', 'json-then-end'],
      ['HEAD', 'replacement', 'json'],
      ['GET', 'replacement', 'error'],
    ] as const)(
      'does not return an asynchronous %s decision read after concurrent %s (%s)',
      async (method, revocationKind, responseKind) => {
        const mod = await loadDemoAuth();
        const demo = await import('../auth/demo-session.js');
        const { createDemoSimulationRouter } = await import(
          '../routes/demo-simulation.js'
        );
        let markRouteStarted!: () => void;
        let releaseRoute!: () => void;
        const routeStarted = new Promise<void>((resolve) => {
          markRouteStarted = resolve;
        });
        const routeRelease = new Promise<void>((resolve) => {
          releaseRoute = resolve;
        });
        const app = express();
        app.get(
          `/api/decisions/${demo.DEMO_USER_ID}`,
          mod.sessionAuth,
          async (_req, res, next) => {
            markRouteStarted();
            await routeRelease;
            if (responseKind === 'error') {
              next(new Error('late downstream failure'));
              return;
            }
            res.json({ decisions: [{ id: 'late-fictional-decision' }] });
            if (responseKind === 'json-then-end') res.end();
          },
        );
        app.use(
          '/api/v1/demo/simulation',
          createDemoSimulationRouter(),
        );
        app.use(
          (
            error: Error,
            _req: Request,
            res: Response,
            _next: NextFunction,
          ) => {
            res.status(503).json({ error: error.message });
          },
        );
        const server = app.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          throw new Error('Could not determine test server port.');
        }
        const issued = mod.issueDemoSession();

        try {
          const pending = fetch(
            `http://127.0.0.1:${address.port}/api/decisions/${demo.DEMO_USER_ID}`,
            {
              method,
              headers: { Authorization: `Bearer ${issued.token}` },
            },
          );
          await routeStarted;
          if (revocationKind === 'discard') {
            const discard = await fetch(
              `http://127.0.0.1:${address.port}/api/v1/demo/simulation`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${issued.token}` },
              },
            );
            expect(discard.status).toBe(204);
          } else {
            demo.issueDemoSession(Date.now(), issued.token);
          }
          releaseRoute();

          const response = await pending;
          expect(response.status).toBe(401);
          expect(response.headers.get('cache-control')).toBe('no-store');
          if (method === 'GET') {
            await expect(response.json()).resolves.toMatchObject({
              error: expect.stringMatching(/unavailable/i),
            });
          } else {
            expect(await response.text()).toBe('');
          }
        } finally {
          releaseRoute();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );

    it.each([
      ['marker is cleared', null],
      ['reserved row is replaced', {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        is_demo: true,
        created_at: new Date('2026-01-02T00:00:00.000Z'),
      }],
    ])('does not emit a paused allowlisted read after the database %s', async (_scenario, replacement) => {
      const mod = await loadDemoAuth();
      const demo = await import('../auth/demo-session.js');
      const db = await import('@skytwin/db');
      const original = {
        id: demo.DEMO_USER_ID,
        is_demo: true,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      let current: typeof original | null = original;
      (db.userRepository.findDemoById as ReturnType<typeof vi.fn>)
        .mockImplementation(async () => current);
      let markRouteStarted!: () => void;
      let releaseRoute!: () => void;
      const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve; });
      const routeRelease = new Promise<void>((resolve) => { releaseRoute = resolve; });
      const app = express();
      const path = `/api/decisions/${demo.DEMO_USER_ID}`;
      app.get(path, mod.sessionAuth, async (_req, res) => {
        markRouteStarted();
        await routeRelease;
        res.json({ decisions: [{ id: 'must-not-escape' }] });
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test server port.');
      const issued = mod.issueDemoSession();
      try {
        const pending = fetch(`http://127.0.0.1:${address.port}${path}`, {
          headers: { Authorization: `Bearer ${issued.token}` },
        });
        await routeStarted;
        current = replacement;
        releaseRoute();
        const response = await pending;
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringMatching(/unavailable/i),
        });
        expect(db.userRepository.findDemoById).toHaveBeenCalledTimes(2);
      } finally {
        releaseRoute();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
    });

    it('preserves active downstream status, headers, and error handling', async () => {
      const mod = await loadDemoAuth();
      const demo = await import('../auth/demo-session.js');
      const path = `/api/decisions/${demo.DEMO_USER_ID}`;
      const app = express();
      app.get(path, mod.sessionAuth, (req, res, next) => {
        if (req.query['fail'] === '1') {
          next(new Error('expected downstream failure'));
          return;
        }
        res.status(206).set('X-Sample-Test', 'preserved').json({ ok: true });
      });
      app.use(
        (
          error: Error,
          _req: Request,
          res: Response,
          _next: NextFunction,
        ) => {
          res
            .status(503)
            .set('X-Sample-Error', 'preserved')
            .json({ error: error.message });
        },
      );
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Could not determine test server port.');
      }
      const issued = mod.issueDemoSession();
      const headers = { Authorization: `Bearer ${issued.token}` };

      try {
        const success = await fetch(
          `http://127.0.0.1:${address.port}${path}`,
          { headers },
        );
        expect(success.status).toBe(206);
        expect(success.headers.get('x-sample-test')).toBe('preserved');
        await expect(success.json()).resolves.toEqual({ ok: true });

        const failure = await fetch(
          `http://127.0.0.1:${address.port}${path}?fail=1`,
          { headers },
        );
        expect(failure.status).toBe(503);
        expect(failure.headers.get('x-sample-error')).toBe('preserved');
        await expect(failure.json()).resolves.toEqual({
          error: 'expected downstream failure',
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });

    it('preserves writeHead, write, and end after final authority proof', async () => {
      const mod = await loadDemoAuth();
      const demo = await import('../auth/demo-session.js');
      const path = `/api/decisions/${demo.DEMO_USER_ID}`;
      const app = express();
      app.get(path, mod.sessionAuth, (_req, res) => {
        res.writeHead(207, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Sample-Stream': 'preserved',
        });
        res.write('buffered-');
        res.end('response');
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test server port.');
      const issued = mod.issueDemoSession();
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          headers: { Authorization: `Bearer ${issued.token}` },
        });
        expect(response.status).toBe(207);
        expect(response.headers.get('x-sample-stream')).toBe('preserved');
        await expect(response.text()).resolves.toBe('buffered-response');
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
    });

    it('rejects mutations and non-allowlisted reads without falling through to DB sessions', async () => {
      const mod = await loadDemoAuth();
      const issued = mod.issueDemoSession();
      const db = await import('@skytwin/db');

      for (const [method, originalUrl] of [
        ['POST', '/api/feedback'],
        ['GET', '/api/users'],
        ['GET', '/api/settings/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
      ]) {
        const req = mockReq({
          method,
          originalUrl,
          headers: { authorization: `Bearer ${issued.token}` },
        });
        const res = mockRes();
        const next = vi.fn();
        await mod.sessionAuth(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
      }
      expect(db.sessionRepository.findByTokenHash).not.toHaveBeenCalled();
    });

    it('keeps the sample principal read-only when the localhost development bypass is enabled', async () => {
      process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'true';
      process.env['SESSION_SECRET'] =
        'test-demo-session-secret-that-is-long-enough';
      const auth = await import('../middleware/session-auth.js');
      const demo = await import('../auth/demo-session.js');
      const db = await import('@skytwin/db');
      (
        db.userRepository.findDemoById as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ id: demo.DEMO_USER_ID, is_demo: true });
      const req = mockReq({
        ip: '127.0.0.1',
        method: 'POST',
        originalUrl: '/api/feedback',
        headers: {
          authorization: `Bearer ${demo.issueDemoSession().token}`,
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await auth.sessionAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(db.sessionRepository.findByTokenHash).not.toHaveBeenCalled();
    });

    it.each(['expired', 'malformed'])(
      'never lets an %s reserved sample token inherit localhost dev auth',
      async (kind) => {
        process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'true';
        process.env['SESSION_SECRET'] =
          'test-demo-session-secret-that-is-long-enough';
        const auth = await import('../middleware/session-auth.js');
        const demo = await import('../auth/demo-session.js');
        const db = await import('@skytwin/db');
        const token =
          kind === 'expired'
            ? demo.issueDemoSession(
                Date.now() - 4 * 60 * 60 * 1000 - 1,
              ).token
            : 'skytwin-demo-v1';
        const req = mockReq({
          ip: '127.0.0.1',
          socket: { remoteAddress: '127.0.0.1' } as Request['socket'],
          method: 'POST',
          originalUrl: '/api/feedback',
          headers: { authorization: `Bearer ${token}` },
        });
        const res = mockRes();
        const next = vi.fn();

        await auth.sessionAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(db.sessionRepository.findByTokenHash).not.toHaveBeenCalled();
      },
    );

    it('revokes an issued sample credential when the database marker disappears', async () => {
      const mod = await loadDemoAuth();
      const issued = mod.issueDemoSession();
      const db = await import('@skytwin/db');
      (db.userRepository.findDemoById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const req = mockReq({
        method: 'GET',
        originalUrl: '/api/decisions/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const res = mockRes();
      const next = vi.fn();

      await mod.sessionAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(req.authenticatedUserId).toBeUndefined();
    });
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
