import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  getPolicies: vi.fn(),
  evaluatePolicy: vi.fn(),
  recordNonAction: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  userRepository: { findById: mocks.findUser },
  policyRepositoryAdapter: { getAllPolicies: mocks.getPolicies },
  routineNonActionRepository: { record: mocks.recordNonAction },
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn(function PolicyEvaluator() {
    return { evaluate: mocks.evaluatePolicy };
  }),
}));

vi.mock('../execution-setup.js', () => ({
  getIronClawEnhancedAdapter: mocks.getAdapter,
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

import { createRoutinesRouter } from '../routes/routines.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const validPlan = {
  action: { actionType: 'send_email' },
  explanation: 'test routine',
};
const adapter = {
  createRoutine: vi.fn(),
  listRoutines: vi.fn(),
  deleteRoutine: vi.fn(),
};

function buildApp(authenticatedUserId?: string): Express {
  const app = express();
  app.use(express.json());
  if (authenticatedUserId) {
    app.use((req, _res, next) => {
      req.authenticatedUserId = authenticatedUserId;
      next();
    });
  }
  app.use('/api/routines', createRoutinesRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body !== undefined) options.body = JSON.stringify(body);
      fetch(`http://127.0.0.1:${address.port}${path}`, options)
        .then(async (response) => {
          const responseBody = await response.json().catch(() => null);
          server.close();
          resolve({ status: response.status, body: responseBody });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

describe('Routines API routes', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ id: USER_ID, trust_tier: 'autopilot' });
    mocks.getPolicies.mockResolvedValue([]);
    mocks.evaluatePolicy.mockResolvedValue({
      allowed: true,
      requiresApproval: false,
      reason: 'Allowed by current policy.',
    });
    mocks.recordNonAction.mockResolvedValue({ created: true, decisionId: 'decision-1' });
    mocks.getAdapter.mockResolvedValue(adapter);
    adapter.createRoutine.mockResolvedValue({ routineId: 'routine-1' });
    adapter.listRoutines.mockResolvedValue([
      { id: 'routine-1', schedule: '0 9 * * *' },
      { id: 'routine-2', schedule: '0 17 * * 1-5' },
    ]);
    adapter.deleteRoutine.mockResolvedValue({ success: true });
    app = buildApp();
  });

  describe('POST /', () => {
    it('durably records a deliberate non-action without resolving the write adapter', async () => {
      const response = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(response.status).toBe(503);
      expect(mocks.recordNonAction).toHaveBeenCalledWith(expect.objectContaining({
        outcome: expect.objectContaining({
          selectedAction: null,
          riskAssessment: null,
          allCandidates: [expect.any(Object)],
          allRiskAssessments: [expect.any(Object)],
          autoExecute: false,
          requiresApproval: false,
          reasoning: expect.stringContaining('runtime policy and explanation admission'),
        }),
        explanation: expect.objectContaining({
          summary: 'The routine was not registered.',
          escalationRationale: expect.stringContaining('runtime policy and explanation admission'),
        }),
      }));
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(adapter.createRoutine).not.toHaveBeenCalled();
    });

    it('persists only a server-normalized candidate', async () => {
      await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: {
          action: {
            actionType: 'send_email',
            costZeroIntent: 'verified_zero',
            reversible: true,
            provenance: 'user_originated',
            estimatedCostCents: -100,
            parameters: { subject: 'hello' },
          },
          steps: [{ type: 'shell_exec', command: 'unchecked' }],
        },
      });

      const candidate = mocks.recordNonAction.mock.calls[0]![0].action;
      expect(candidate).toMatchObject({
        actionType: 'send_email',
        costZeroIntent: 'unknown',
        reversible: false,
        provenance: 'untrusted_external',
        estimatedCostCents: 0,
        parameters: { subject: 'hello', userId: USER_ID },
      });
      expect(candidate).not.toHaveProperty('steps');
      expect(mocks.evaluatePolicy).toHaveBeenCalledWith(
        candidate,
        [],
        'autopilot',
        expect.any(Object),
        expect.any(Object),
      );
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('fails closed with no adapter access when the atomic audit write fails', async () => {
      mocks.recordNonAction.mockRejectedValueOnce(new Error('audit transaction rolled back'));

      const response = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'audit transaction rolled back' });
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(adapter.createRoutine).not.toHaveBeenCalled();
    });

    it('persists the policy denial and never registers the routine', async () => {
      mocks.evaluatePolicy.mockResolvedValueOnce({
        allowed: false,
        requiresApproval: false,
        reason: 'Spend limit exceeded.',
      });

      const response = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(response.status).toBe(403);
      expect(mocks.recordNonAction).toHaveBeenCalledWith(expect.objectContaining({
        outcome: expect.objectContaining({
          selectedAction: null,
          riskAssessment: null,
          reasoning: 'Spend limit exceeded.',
        }),
        explanation: expect.any(Object),
      }));
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('suppresses a replay before writing child artifacts or resolving the adapter', async () => {
      mocks.recordNonAction.mockResolvedValueOnce({ created: false, decisionId: 'existing' });

      const response = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: validPlan,
      });

      expect(response.status).toBe(409);
      expect(mocks.recordNonAction).toHaveBeenCalledOnce();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('rejects malformed requests before durable writes', async () => {
      const missing = await request(app, 'POST', '/api/routines', {
        schedule: '0 9 * * *',
        plan: validPlan,
      });
      const invalidSchedule = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: 'not-a-cron',
        plan: validPlan,
      });
      const missingAction = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: { action: {} },
      });

      expect([missing.status, invalidSchedule.status, missingAction.status]).toEqual([400, 400, 400]);
      expect(mocks.recordNonAction).not.toHaveBeenCalled();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it.each([
      ['', 'empty'],
      ['   ', 'whitespace'],
      ['x'.repeat(129), 'overlong'],
      ['send_email\nignored', 'control-character'],
      [42, 'non-string'],
    ])('rejects %s action types before typed artifacts are built (%s)', async (actionType, _label) => {
      const response = await request(app, 'POST', '/api/routines', {
        userId: USER_ID,
        schedule: '0 9 * * *',
        plan: { action: { actionType } },
      });

      expect(response.status).toBe(400);
      expect(mocks.evaluatePolicy).not.toHaveBeenCalled();
      expect(mocks.recordNonAction).not.toHaveBeenCalled();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('can retry after an atomic audit failure without touching the adapter', async () => {
      mocks.recordNonAction
        .mockRejectedValueOnce(new Error('audit transaction rolled back'))
        .mockResolvedValueOnce({ created: true, decisionId: 'decision-1' });
      const requestBody = { userId: USER_ID, schedule: '0 9 * * *', plan: validPlan };

      const first = await request(app, 'POST', '/api/routines', requestBody);
      const retry = await request(app, 'POST', '/api/routines', requestBody);

      expect(first.status).toBe(500);
      expect(retry.status).toBe(503);
      expect(mocks.recordNonAction).toHaveBeenCalledTimes(2);
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });
  });

  describe('GET /:userId', () => {
    it('preserves read-only routine listing', async () => {
      const response = await request(app, 'GET', `/api/routines/${USER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ userId: USER_ID, available: true });
      expect(adapter.listRoutines).toHaveBeenCalledWith(USER_ID);
    });

    it('reports listing unavailable when no adapter is configured', async () => {
      mocks.getAdapter.mockResolvedValueOnce(null);
      const response = await request(app, 'GET', `/api/routines/${USER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ userId: USER_ID, routines: [], available: false });
    });
  });

  describe('DELETE /:routineId', () => {
    it('durably records a deliberate non-action with zero remote calls', async () => {
      const response = await request(app, 'DELETE', '/api/routines/routine-1', { userId: USER_ID });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ routineId: 'routine-1', deleted: false });
      expect(mocks.recordNonAction).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({
          actionType: 'delete_routine',
          reversible: false,
          parameters: { userId: USER_ID, routineId: 'routine-1' },
        }),
        outcome: expect.objectContaining({
          selectedAction: null,
          riskAssessment: null,
          autoExecute: false,
          requiresApproval: false,
          reasoning: expect.stringContaining('durable admission and reconciliation'),
        }),
        explanation: expect.objectContaining({ summary: 'The routine was not deleted.' }),
      }));
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(adapter.listRoutines).not.toHaveBeenCalled();
      expect(adapter.deleteRoutine).not.toHaveBeenCalled();
    });

    it('persists a policy block without touching the remote adapter', async () => {
      mocks.evaluatePolicy.mockResolvedValueOnce({
        allowed: false,
        requiresApproval: false,
        reason: 'Routine changes are disabled by policy.',
      });

      const response = await request(app, 'DELETE', '/api/routines/routine-1', { userId: USER_ID });

      expect(response.status).toBe(403);
      expect(mocks.recordNonAction).toHaveBeenCalledWith(expect.objectContaining({
        outcome: expect.objectContaining({ reasoning: 'Routine changes are disabled by policy.' }),
        explanation: expect.any(Object),
      }));
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('fails closed with no remote calls when the deletion audit transaction fails', async () => {
      mocks.recordNonAction.mockRejectedValueOnce(new Error('audit transaction rolled back'));

      const response = await request(app, 'DELETE', '/api/routines/routine-1', { userId: USER_ID });

      expect(response.status).toBe(500);
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(adapter.listRoutines).not.toHaveBeenCalled();
      expect(adapter.deleteRoutine).not.toHaveBeenCalled();
    });

    it('suppresses deletion replay before child records or remote access', async () => {
      mocks.recordNonAction.mockResolvedValueOnce({ created: false, decisionId: 'existing' });

      const response = await request(app, 'DELETE', '/api/routines/routine-1', { userId: USER_ID });

      expect(response.status).toBe(409);
      expect(mocks.recordNonAction).toHaveBeenCalledOnce();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('rejects an authenticated owner mismatch before reads or writes', async () => {
      app = buildApp('bbbbbbbb-bbbb-cccc-dddd-000000000002');

      const response = await request(app, 'DELETE', '/api/routines/routine-1', { userId: USER_ID });

      expect(response.status).toBe(403);
      expect(mocks.findUser).not.toHaveBeenCalled();
      expect(mocks.recordNonAction).not.toHaveBeenCalled();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });

    it('rejects missing ownership input and malformed routine ids', async () => {
      const missingOwner = await request(app, 'DELETE', '/api/routines/routine-1', {});
      const malformedId = await request(app, 'DELETE', `/api/routines/${'x'.repeat(257)}`, { userId: USER_ID });

      expect([missingOwner.status, malformedId.status]).toEqual([400, 400]);
      expect(mocks.recordNonAction).not.toHaveBeenCalled();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
    });
  });
});
