import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules -- vi.hoisted ensures these are available when vi.mock
// factories execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockUserRepository,
  mockPolicyRepositoryAdapter,
  mockGetIronClawEnhancedAdapter,
  mockPolicyEvaluator,
} = vi.hoisted(() => ({
  mockUserRepository: {
    findById: vi.fn(),
  },
  mockPolicyRepositoryAdapter: {
    getAllPolicies: vi.fn(),
  },
  mockGetIronClawEnhancedAdapter: vi.fn(),
  mockPolicyEvaluator: {
    evaluate: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  policyRepositoryAdapter: mockPolicyRepositoryAdapter,
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn().mockImplementation(() => mockPolicyEvaluator),
}));

vi.mock('../execution-setup.js', () => ({
  getIronClawEnhancedAdapter: mockGetIronClawEnhancedAdapter,
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

vi.mock('@skytwin/shared-types', async () => {
  const actual = await vi.importActual('@skytwin/shared-types');
  return actual;
});

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { createRoutinesRouter } from '../routes/routines.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/routines', createRoutinesRouter());
  // Error handler to capture next(error) calls
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

/**
 * Lightweight test helper that makes HTTP requests to an Express app
 * without needing supertest. Uses the native Node fetch API against
 * a locally started server.
 */
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

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const validPlan = {
  action: { actionType: 'send_email' },
  explanation: 'test routine',
};

const mockAdapter = {
  createRoutine: vi.fn(),
  listRoutines: vi.fn(),
  deleteRoutine: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Routines API routes', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();

    mockUserRepository.findById.mockResolvedValue({ id: 'user-1', trust_tier: 'autopilot' });
    mockPolicyRepositoryAdapter.getAllPolicies.mockResolvedValue([]);
    mockPolicyEvaluator.evaluate.mockResolvedValue({ allowed: true });
    mockGetIronClawEnhancedAdapter.mockResolvedValue(mockAdapter);

    mockAdapter.createRoutine.mockResolvedValue({ routineId: 'routine-1' });
    mockAdapter.listRoutines.mockResolvedValue([
      { id: 'routine-1', schedule: '0 9 * * *' },
      { id: 'routine-2', schedule: '0 17 * * 1-5' },
    ]);
    mockAdapter.deleteRoutine.mockResolvedValue({ success: true });

    app = buildApp();
  });

  // =========================================================================
  // POST /api/routines
  // =========================================================================
  describe('POST /', () => {
    it('creates a routine successfully', async () => {
      const res = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(201);
      const body = res.body as { userId: string; schedule: string; routineId: string };
      expect(body.userId).toBe('user-1');
      expect(body.schedule).toBe('0 9 * * *');
      expect(body.routineId).toBe('routine-1');
      expect(mockAdapter.createRoutine).toHaveBeenCalledWith(
        'user-1',
        '0 9 * * *',
        {
          ...validPlan,
          action: {
            ...validPlan.action,
            parameters: { userId: 'user-1' },
          },
        },
      );
    });

    it('returns 400 for missing fields', async () => {
      // Missing userId
      const res1 = await request(app, 'POST', '/api/routines', {
        schedule: '0 9 * * *',
        plan: validPlan,
      });
      expect(res1.status).toBe(400);

      // Missing schedule
      const res2 = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        plan: validPlan,
      });
      expect(res2.status).toBe(400);

      // Missing plan
      const res3 = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        schedule: '0 9 * * *',
      });
      expect(res3.status).toBe(400);
    });

    it('returns 400 for invalid cron schedule', async () => {
      const res = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        schedule: 'not-a-cron',
        plan: validPlan,
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Invalid schedule format/);
    });

    it('returns 400 for missing plan.action.actionType', async () => {
      const res = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        schedule: '0 9 * * *',
        plan: { action: {} },
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/actionType/);
    });

    it('returns 404 when user not found', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      const res = await request(app, 'POST', '/api/routines', {
        userId: 'nonexistent-user',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(404);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/User not found/);
    });

    it('returns 403 when policy blocks the action', async () => {
      mockPolicyEvaluator.evaluate.mockResolvedValue({
        allowed: false,
        reason: 'Spend limit exceeded',
      });

      const res = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(403);
      const body = res.body as { error: string; reason: string };
      expect(body.error).toMatch(/blocked by policy/);
      expect(body.reason).toBe('Spend limit exceeded');
    });

    it('returns 503 when adapter unavailable', async () => {
      mockGetIronClawEnhancedAdapter.mockResolvedValue(null);

      const res = await request(app, 'POST', '/api/routines', {
        userId: 'user-1',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(503);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/unavailable/);
    });
  });

  // =========================================================================
  // GET /api/routines/:userId
  // =========================================================================
  describe('GET /:userId', () => {
    it('lists routines successfully', async () => {
      const res = await request(app, 'GET', '/api/routines/user-1');

      expect(res.status).toBe(200);
      const body = res.body as {
        userId: string;
        routines: Array<{ id: string; schedule: string }>;
        available: boolean;
      };
      expect(body.userId).toBe('user-1');
      expect(body.routines).toHaveLength(2);
      expect(body.available).toBe(true);
      expect(mockAdapter.listRoutines).toHaveBeenCalledWith('user-1');
    });

    it('returns available: false when adapter unavailable', async () => {
      mockGetIronClawEnhancedAdapter.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/routines/user-1');

      expect(res.status).toBe(200);
      const body = res.body as {
        userId: string;
        routines: unknown[];
        available: boolean;
      };
      expect(body.userId).toBe('user-1');
      expect(body.routines).toHaveLength(0);
      expect(body.available).toBe(false);
    });
  });

  // =========================================================================
  // DELETE /api/routines/:routineId
  // =========================================================================
  describe('DELETE /:routineId', () => {
    it('deletes owned routine successfully', async () => {
      const res = await request(app, 'DELETE', '/api/routines/routine-1', {
        userId: 'user-1',
      });

      expect(res.status).toBe(200);
      const body = res.body as { routineId: string; deleted: boolean };
      expect(body.routineId).toBe('routine-1');
      expect(body.deleted).toBe(true);
      expect(mockAdapter.deleteRoutine).toHaveBeenCalledWith('routine-1');
    });

    it('returns 400 when userId missing', async () => {
      const res = await request(app, 'DELETE', '/api/routines/routine-1', {});

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Missing required userId/);
    });

    it('returns 403 when routine not owned by user', async () => {
      mockAdapter.listRoutines.mockResolvedValue([
        { id: 'routine-99', schedule: '0 9 * * *' },
      ]);

      const res = await request(app, 'DELETE', '/api/routines/routine-1', {
        userId: 'user-1',
      });

      expect(res.status).toBe(403);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/does not belong to you/);
    });

    it('returns 503 when adapter unavailable', async () => {
      mockGetIronClawEnhancedAdapter.mockResolvedValue(null);

      const res = await request(app, 'DELETE', '/api/routines/routine-1', {
        userId: 'user-1',
      });

      expect(res.status).toBe(503);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/unavailable/);
    });
  });
});
