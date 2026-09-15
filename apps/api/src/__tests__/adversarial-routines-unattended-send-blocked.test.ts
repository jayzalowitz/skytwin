import { expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  getPolicies: vi.fn(),
  evaluatePolicy: vi.fn(),
  recordNonAction: vi.fn(),
  getAdapter: vi.fn(),
  createRoutine: vi.fn(),
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

vi.mock('../execution-setup.js', () => ({ getIronClawEnhancedAdapter: mocks.getAdapter }));
vi.mock('../middleware/require-ownership.js', () => ({ bindUserIdParamOwnership: vi.fn() }));

import { createRoutinesRouter } from '../routes/routines.js';

const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';

function app(): Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/routines', createRoutinesRouter());
  instance.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error.message });
  });
  return instance;
}

async function register(instance: Express): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = instance.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}/api/routines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          schedule: '0 9 * * *',
          plan: {
            action: {
              actionType: 'send_email',
              parameters: { subject: 'Unattended message' },
              reversible: true,
              costZeroIntent: 'verified_zero',
              provenance: 'user_originated',
            },
          },
        }),
      }).then(async (response) => {
        const body = await response.json();
        server.close();
        resolve({ status: response.status, body });
      }).catch((error) => {
        server.close();
        reject(error);
      });
    });
  });
}

it('adv-v1-routines-unattended-send-blocked records a non-action without adapter access', async () => {
  mocks.findUser.mockResolvedValue({ id: userId, trust_tier: 'high_autonomy', autonomy_settings: {} });
  mocks.getPolicies.mockResolvedValue([]);
  mocks.evaluatePolicy.mockResolvedValue({
    allowed: true,
    requiresApproval: false,
    reason: 'Allowed by current policy.',
  });
  mocks.recordNonAction.mockResolvedValue({ created: true, decisionId: 'decision-1' });
  mocks.getAdapter.mockResolvedValue({ createRoutine: mocks.createRoutine });

  const response = await register(app());
  const recorded = mocks.recordNonAction.mock.calls[0]?.[0] as {
    decision: {
      provenance: string;
      rawData: Record<string, unknown>;
    };
    action: {
      actionType: string;
      parameters: Record<string, unknown>;
      reversible: boolean;
      provenance: string;
    };
    explanation: { evidenceUsed: Array<{ source: string }> };
  };

  expect({
    response,
    recorded,
    calls: {
      policy: mocks.evaluatePolicy.mock.calls.length,
      nonAction: mocks.recordNonAction.mock.calls.length,
      adapterResolutions: mocks.getAdapter.mock.calls.length,
      writes: mocks.createRoutine.mock.calls.length,
    },
  })
    .toMatchObject({
      response: { status: 503, body: { code: 'routine_registration_unavailable' } },
      recorded: {
        decision: {
          provenance: 'user_originated',
          rawData: {
            schedule: '0 9 * * *',
            normalizedAction: {
              actionType: 'send_email',
              parameters: { subject: 'Unattended message', userId },
              reversible: false,
              provenance: 'untrusted_external',
            },
          },
        },
        action: {
          actionType: 'send_email',
          parameters: { subject: 'Unattended message', userId },
          reversible: false,
          costZeroIntent: 'unknown',
          provenance: 'untrusted_external',
        },
        outcome: { autoExecute: false, requiresApproval: false, selectedAction: null },
        explanation: {
          summary: 'The routine was not registered.',
          evidenceUsed: [{ source: 'routine_request' }],
        },
      },
      calls: { policy: 1, nonAction: 1, adapterResolutions: 0, writes: 0 },
    });
});
