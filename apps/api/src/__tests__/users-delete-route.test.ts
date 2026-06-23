/**
 * Tests for the DELETE /api/users/:userId right-to-erasure route (#376).
 *
 * Verifies the confirmation gate (no purge without the explicit
 * `?confirm=delete-my-data` query param), the 404 path when the user
 * doesn't exist at delete time, and the success response shape the
 * Settings page renders ("twin profile: 1, decisions: 147, …").
 *
 * The repository's transactional contract + dependency order are
 * unit-tested in `packages/db/src/__tests__/user-purge-repository.test.ts`.
 * The actual cascade behaviour is exercised end-to-end in
 * `packages/db/src/__tests__/cascade-cleanup.e2e.test.ts` from #413.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mockUserPurgeRepository = {
  purgeUser: vi.fn(),
};
const mockUserRepository = {
  findById: vi.fn(),
  findByEmail: vi.fn(),
  findAll: vi.fn(),
};

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  userPurgeRepository: mockUserPurgeRepository,
  // Both DB-adapter shims pulled in by TwinService.
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../middleware/session-auth.js', () => ({
  sessionAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const authenticatedUserId = req.headers['x-auth-user-id'];
    if (typeof authenticatedUserId === 'string') {
      req.authenticatedUserId = authenticatedUserId;
    }
    next();
  },
}));

vi.mock('../middleware/require-ownership.js', () => ({
  requireOwnership: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  bindUserIdParamOwnership: vi.fn(),
}));

const { createUsersRouter } = await import('../routes/users.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/users', createUsersRouter());
  return app;
}

async function request(
  app: Express,
  method: 'DELETE' | 'GET',
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [pathOnly, queryStr] = path.split('?');
  const query: Record<string, string> = {};
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[k] = v ?? '';
    }
  }
  return new Promise((resolve, reject) => {
    const req: Partial<express.Request> = {
      method,
      url: path,
      headers: { 'content-type': 'application/json', ...headers },
      body: {},
      query,
    } as Partial<express.Request>;
    let status = 200;
    let resp: Record<string, unknown> = {};
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: Record<string, unknown>) {
        resp = payload;
        resolve({ status, body: resp });
        return res;
      },
      send(payload: unknown) {
        resp = payload as Record<string, unknown>;
        resolve({ status, body: resp });
        return res;
      },
      setHeader: () => res,
      end: () => resolve({ status, body: resp }),
    } as unknown as express.Response;
    app(req as express.Request, res as express.Response, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ status, body: resp });
    });
    void pathOnly; // silence unused
  });
}

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000088';

describe('GET /users/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('looks non-UUID identifiers up by email without sending them through the UUID query path', async () => {
    mockUserRepository.findByEmail.mockResolvedValue({
      id: USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      trust_tier: 'observer',
      created_at: new Date('2026-06-01'),
    });

    const app = makeApp();
    const { status, body } = await request(app, 'GET', '/users/test%40example.com');

    expect(status).toBe(200);
    expect(mockUserRepository.findById).not.toHaveBeenCalled();
    expect(mockUserRepository.findByEmail).toHaveBeenCalledWith('test@example.com');
    expect((body['user'] as { id: string }).id).toBe(USER_ID);
  });

  it('allows an authenticated user to read their own row by email', async () => {
    mockUserRepository.findById.mockResolvedValue({
      id: USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      trust_tier: 'observer',
      created_at: new Date('2026-06-01'),
    });
    mockUserRepository.findByEmail.mockResolvedValue({
      id: USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      trust_tier: 'observer',
      created_at: new Date('2026-06-01'),
    });

    const app = makeApp();
    const { status, body } = await request(
      app,
      'GET',
      '/users/test%40example.com',
      { 'x-auth-user-id': USER_ID },
    );

    expect(status).toBe(200);
    expect(mockUserRepository.findByEmail).toHaveBeenCalledWith('test@example.com');
    expect((body['user'] as { id: string }).id).toBe(USER_ID);
  });

  it('403s for non-owned email identifiers without probing whether that email exists', async () => {
    mockUserRepository.findById.mockResolvedValue({
      id: USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      trust_tier: 'observer',
      created_at: new Date('2026-06-01'),
    });

    const app = makeApp();
    const { status, body } = await request(
      app,
      'GET',
      '/users/other%40example.com',
      { 'x-auth-user-id': USER_ID },
    );

    expect(status).toBe(403);
    expect(body['error']).toBe('Forbidden');
    expect(mockUserRepository.findByEmail).not.toHaveBeenCalled();
  });
});

describe('DELETE /users/:userId (#376)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400s without ?confirm=delete-my-data — no purge call', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'DELETE', `/users/${USER_ID}`);
    expect(status).toBe(400);
    expect(body['error']).toBe('confirmation_required');
    expect(mockUserPurgeRepository.purgeUser).not.toHaveBeenCalled();
  });

  it('400s when confirm has the wrong value (defends against typos / stale clients)', async () => {
    const app = makeApp();
    const { status } = await request(
      app,
      'DELETE',
      `/users/${USER_ID}?confirm=yes`,
    );
    expect(status).toBe(400);
    expect(mockUserPurgeRepository.purgeUser).not.toHaveBeenCalled();
  });

  it('purges and returns counts + total when the user exists', async () => {
    mockUserPurgeRepository.purgeUser.mockResolvedValue({
      counts: {
        candidate_actions: 11,
        decision_outcomes: 4,
        execution_plans: 2,
        users: 1,
      },
      total: 18,
      userExisted: true,
    });
    const app = makeApp();
    const { status, body } = await request(
      app,
      'DELETE',
      `/users/${USER_ID}?confirm=delete-my-data`,
    );
    expect(status).toBe(200);
    expect(body['deleted']).toBe(true);
    expect(body['userId']).toBe(USER_ID);
    expect(body['totalRows']).toBe(18);
    const counts = body['counts'] as Record<string, number>;
    expect(counts['candidate_actions']).toBe(11);
    expect(counts['users']).toBe(1);
    expect(mockUserPurgeRepository.purgeUser).toHaveBeenCalledWith(USER_ID);
  });

  it('404s when the final DELETE FROM users hit zero rows (user already gone)', async () => {
    mockUserPurgeRepository.purgeUser.mockResolvedValue({
      counts: { users: 0 },
      total: 0,
      userExisted: false,
    });
    const app = makeApp();
    const { status, body } = await request(
      app,
      'DELETE',
      `/users/${USER_ID}?confirm=delete-my-data`,
    );
    expect(status).toBe(404);
    expect(body['error']).toBe('user_not_found');
    expect(body['counts']).toEqual({ users: 0 });
  });

  it('propagates a repository error via the express error pipeline', async () => {
    mockUserPurgeRepository.purgeUser.mockRejectedValue(
      new Error('CRDB pool exhausted'),
    );
    const app = makeApp();
    let caught: Error | undefined;
    await new Promise<void>((resolve) => {
      const req: Partial<express.Request> = {
        method: 'DELETE',
        url: `/users/${USER_ID}?confirm=delete-my-data`,
        headers: {},
        body: {},
        query: { confirm: 'delete-my-data' },
      } as Partial<express.Request>;
      const res = {
        status: () => res,
        json: () => res,
        send: () => res,
        setHeader: () => res,
        end: () => resolve(),
      } as unknown as express.Response;
      app(req as express.Request, res as express.Response, (err?: unknown) => {
        if (err) caught = err instanceof Error ? err : new Error(String(err));
        resolve();
      });
    });
    expect(caught?.message).toContain('CRDB pool exhausted');
  });
});
