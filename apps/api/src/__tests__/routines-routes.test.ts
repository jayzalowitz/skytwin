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
  mockDecisionRepositoryAdapter,
  mockExplanationRepositoryAdapter,
  mockPreEffectBarrierRepository,
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
  mockDecisionRepositoryAdapter: {
    saveDecision: vi.fn(),
    saveCandidates: vi.fn(),
    saveRiskAssessment: vi.fn(),
    saveOutcome: vi.fn(),
  },
  mockExplanationRepositoryAdapter: { save: vi.fn() },
  mockPreEffectBarrierRepository: {
    reserve: vi.fn(),
    markPrepared: vi.fn(),
    updatePreparedPolicy: vi.fn(),
    claimPrepared: vi.fn(),
    markTerminal: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  policyRepositoryAdapter: mockPolicyRepositoryAdapter,
  decisionRepositoryAdapter: mockDecisionRepositoryAdapter,
  explanationRepositoryAdapter: mockExplanationRepositoryAdapter,
  preEffectBarrierRepository: mockPreEffectBarrierRepository,
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn(function PolicyEvaluator() {
    return mockPolicyEvaluator;
  }),
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

    mockUserRepository.findById.mockResolvedValue({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', trust_tier: 'autopilot' });
    mockPolicyRepositoryAdapter.getAllPolicies.mockResolvedValue([]);
    mockPolicyEvaluator.evaluate.mockResolvedValue({ allowed: true });
    mockGetIronClawEnhancedAdapter.mockResolvedValue(mockAdapter);
    mockDecisionRepositoryAdapter.saveDecision.mockImplementation(async (decision) => ({ decision, created: true }));
    mockDecisionRepositoryAdapter.saveCandidates.mockImplementation(async (candidates) => candidates);
    mockDecisionRepositoryAdapter.saveRiskAssessment.mockImplementation(async (risk) => risk);
    mockDecisionRepositoryAdapter.saveOutcome.mockImplementation(async (outcome) => outcome);
    mockExplanationRepositoryAdapter.save.mockImplementation(async (record) => ({
      ...record,
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    }));
    mockPreEffectBarrierRepository.reserve.mockResolvedValue({
      row: {
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        status: 'reserved',
        effect_result: {},
      },
      created: true,
    });
    mockPreEffectBarrierRepository.markPrepared.mockResolvedValue({ status: 'prepared' });
    mockPreEffectBarrierRepository.updatePreparedPolicy.mockResolvedValue({ status: 'prepared' });
    mockPreEffectBarrierRepository.claimPrepared.mockResolvedValue({ status: 'in_progress' });
    mockPreEffectBarrierRepository.markTerminal.mockResolvedValue({ status: 'succeeded' });

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
    it('durably blocks unattended registration until per-run admission exists', async () => {
      const res = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(503);
      expect(res.body).toEqual(expect.objectContaining({
        error: expect.stringContaining('not available'),
        reason: expect.stringContaining('runtime policy and explanation admission'),
      }));
      expect(mockPolicyRepositoryAdapter.getAllPolicies).toHaveBeenCalledWith(
        'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      );
      expect(mockAdapter.createRoutine).not.toHaveBeenCalled();
      expect(mockDecisionRepositoryAdapter.saveOutcome).toHaveBeenLastCalledWith(
        expect.objectContaining({ autoExecute: false, requiresApproval: false }),
      );
      expect(mockExplanationRepositoryAdapter.save).toHaveBeenCalledTimes(2);
      expect(mockPreEffectBarrierRepository.markPrepared).toHaveBeenCalledWith(
        expect.objectContaining({ explanationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }),
      );
      expect(mockPreEffectBarrierRepository.markTerminal).toHaveBeenCalledWith(
        'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'blocked',
        { runtimeAdmission: 'unavailable' },
        expect.stringContaining('runtime policy and explanation admission'),
      );
    });

    it('does NOT trust a caller-supplied verified_zero / reversible for a costed action type', async () => {
      await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: { action: { actionType: 'send_email', costZeroIntent: 'verified_zero', reversible: true } },
      });
      const checked = mockPolicyEvaluator.evaluate.mock.calls[0]![0] as {
        costZeroIntent: string; reversible: boolean; provenance: string;
      };
      expect(checked.costZeroIntent).toBe('unknown'); // server overrode the caller's claim
      expect(checked.reversible).toBe(false); // not a free type → assumed irreversible
      expect(checked.provenance).toBe('untrusted_external');
    });

    it('classifies a known free action type as verified_zero + reversible', async () => {
      await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: { action: { actionType: 'create_note' } },
      });
      const checked = mockPolicyEvaluator.evaluate.mock.calls[0]![0] as {
        costZeroIntent: string; reversible: boolean;
      };
      expect(checked.costZeroIntent).toBe('verified_zero');
      expect(checked.reversible).toBe(true);
    });

    it('persists only the normalized candidate and never dispatches caller-supplied steps', async () => {
      await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: { action: { actionType: 'create_note' }, steps: [{ type: 'shell_exec', cmd: 'rm -rf /' }] },
      });
      expect(mockDecisionRepositoryAdapter.saveCandidates).toHaveBeenCalledWith([
        expect.objectContaining({ actionType: 'create_note' }),
      ]);
      expect(mockAdapter.createRoutine).not.toHaveBeenCalled();
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
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        plan: validPlan,
      });
      expect(res2.status).toBe(400);

      // Missing plan
      const res3 = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
      });
      expect(res3.status).toBe(400);
    });

    it('fails closed with zero registrations when explanation persistence fails', async () => {
      mockExplanationRepositoryAdapter.save.mockRejectedValueOnce(new Error('audit store unavailable'));

      const res = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: { action: { actionType: 'create_note' } },
      });

      expect(res.status).toBe(500);
      expect(mockAdapter.createRoutine).not.toHaveBeenCalled();
      expect(mockPreEffectBarrierRepository.claimPrepared).not.toHaveBeenCalled();
    });

    it('suppresses replay after a durable runtime-admission block', async () => {
      const requestBody = {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: { action: { actionType: 'create_note' } },
      };

      const first = await request(app, 'POST', '/api/routines', requestBody);
      expect(first.status).toBe(503);
      expect(mockAdapter.createRoutine).not.toHaveBeenCalled();

      mockPreEffectBarrierRepository.reserve.mockResolvedValueOnce({
        row: {
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          status: 'blocked',
          effect_result: {},
        },
        created: false,
      });
      const retry = await request(app, 'POST', '/api/routines', requestBody);
      expect(retry.status).toBe(409);
      expect(mockAdapter.createRoutine).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid cron schedule', async () => {
      const res = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: 'not-a-cron',
        plan: validPlan,
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Invalid schedule format/);
    });

    it('returns 400 for missing plan.action.actionType', async () => {
      const res = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
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
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(403);
      const body = res.body as { error: string; reason: string };
      expect(body.error).toMatch(/blocked by policy/);
      expect(body.reason).toBe('Spend limit exceeded');
    });

    it('returns 403 when the action requires approval (cannot run unattended)', async () => {
      mockPolicyEvaluator.evaluate.mockResolvedValue({
        allowed: true,
        requiresApproval: true,
        reason: 'Irreversible action requires approval',
      });

      const res = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(403);
      const body = res.body as { error: string; reason: string };
      expect(body.error).toMatch(/requires manual approval/);
      expect(body.reason).toBe('Irreversible action requires approval');
      expect(mockAdapter.createRoutine).not.toHaveBeenCalled();
    });

    it('evaluates the action with a riskAssessment AND autonomySettings (full policy gate)', async () => {
      await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: validPlan,
      });
      const evalArgs = mockPolicyEvaluator.evaluate.mock.calls[0]!;
      expect(evalArgs).toHaveLength(5); // action, policies, tier, riskAssessment, autonomy
      expect(evalArgs[3]).toBeDefined(); // riskAssessment (enables reversibility/risk rules)
      expect(evalArgs[4]).toBeDefined(); // autonomySettings (enables the spend hard-limit)
    });

    it('does not even resolve the adapter for POST while runtime admission is unavailable', async () => {
      mockGetIronClawEnhancedAdapter.mockResolvedValue(null);

      const res = await request(app, 'POST', '/api/routines', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(res.status).toBe(503);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/not available/);
      expect(mockGetIronClawEnhancedAdapter).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /api/routines/:userId
  // =========================================================================
  describe('GET /:userId', () => {
    it('lists routines successfully', async () => {
      const res = await request(app, 'GET', '/api/routines/aaaaaaaa-bbbb-cccc-dddd-000000000001');

      expect(res.status).toBe(200);
      const body = res.body as {
        userId: string;
        routines: Array<{ id: string; schedule: string }>;
        available: boolean;
      };
      expect(body.userId).toBe('aaaaaaaa-bbbb-cccc-dddd-000000000001');
      expect(body.routines).toHaveLength(2);
      expect(body.available).toBe(true);
      expect(mockAdapter.listRoutines).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-000000000001');
    });

    it('returns available: false when adapter unavailable', async () => {
      mockGetIronClawEnhancedAdapter.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/routines/aaaaaaaa-bbbb-cccc-dddd-000000000001');

      expect(res.status).toBe(200);
      const body = res.body as {
        userId: string;
        routines: unknown[];
        available: boolean;
      };
      expect(body.userId).toBe('aaaaaaaa-bbbb-cccc-dddd-000000000001');
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
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
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
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      });

      expect(res.status).toBe(403);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/does not belong to you/);
    });

    it('returns 503 when adapter unavailable', async () => {
      mockGetIronClawEnhancedAdapter.mockResolvedValue(null);

      const res = await request(app, 'DELETE', '/api/routines/routine-1', {
        userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      });

      expect(res.status).toBe(503);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/unavailable/);
    });
  });
});
