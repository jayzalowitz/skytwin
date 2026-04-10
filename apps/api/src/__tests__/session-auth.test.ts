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

  beforeEach(async () => {
    // Reset env for each test
    delete process.env['SKYTWIN_DEV_AUTH_BYPASS'];

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
});
