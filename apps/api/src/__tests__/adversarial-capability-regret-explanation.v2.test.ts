import { expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mocks = vi.hoisted(() => ({
  getServer: vi.fn(),
  getTargets: vi.fn(),
  recordNonAction: vi.fn(),
  getRouter: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: vi.fn(() => ({ googleConnectionMode: 'experimental' })),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: {
    getById: mocks.getServer,
    listSkillNamesForServer: vi.fn().mockResolvedValue([]),
  },
  appSuggestionRepository: {},
  provenanceRepository: {},
  mcpServerMetricsRepository: {},
  mcpServerChangelogRepository: {},
  executionRepository: { getRollbackTargetsByServer: mocks.getTargets },
  routineNonActionRepository: { record: mocks.recordNonAction },
  oauthRepository: {},
  CredentialDispatchConflictError: class CredentialDispatchConflictError extends Error {},
  query: mocks.query,
}));

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn(function RegistryClient() {
    return { search: vi.fn().mockResolvedValue([]), getAll: vi.fn().mockResolvedValue([]) };
  }),
}));
vi.mock('../execution-setup.js', () => ({ getExecutionRouter: mocks.getRouter }));
vi.mock('../lib/user-llm-client.js', () => ({
  resolveUserLlmClient: vi.fn().mockResolvedValue({
    state: 'no_provider', client: null, reason: 'No provider configured',
  }),
}));
vi.mock('../sse.js', () => ({
  sseManager: {},
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability:promotion-offered',
}));

import { createCapabilitiesRouter } from '../routes/capabilities.js';

const serverId = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const userId = 'ffffffff-eeee-dddd-cccc-000000000001';
const planId = '22222222-2222-4222-8222-222222222222';

function app(): Express {
  const instance = express();
  instance.use(express.json());
  instance.use((request, _response, next) => {
    (request as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  instance.use('/api/capabilities', createCapabilitiesRouter());
  instance.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error.message });
  });
  return instance;
}

async function post(instance: Express): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = instance.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}/api/capabilities/${serverId}/regret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withinHours: 48 }),
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

/**
 * Reserved v2 route contract. Activation replaces only `it.skip` with `it`
 * after the persistence implementation lands, then appends the final source
 * digest and activation commit to the v2 migration fixture.
 */
it.skip('adv-v2-capability-regret-explanation persists report-only evidence', async () => {
  mocks.getServer.mockResolvedValue({
    id: serverId,
    user_id: userId,
    display_name: 'Filesystem',
  });
  mocks.getTargets.mockResolvedValue([{
    actionId: 'action-ccc',
    payload: { reversible: true },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    executionPlanId: planId,
    adapterUsed: 'ironclaw',
  }]);
  mocks.recordNonAction.mockImplementation(async (input: { decision: { id: string } }) => ({
    created: true,
    decisionId: input.decision.id,
  }));

  const response = await post(app());

  expect(response).toMatchObject({
    status: 200,
    body: {
      status: 'report_only',
      code: 'generic_rollback_report_only',
      undone: [],
    },
  });
  expect(mocks.recordNonAction).toHaveBeenCalledWith(expect.objectContaining({
    decision: expect.objectContaining({
      rawData: expect.objectContaining({
        signalId: expect.stringMatching(/^capability-regret-report:[a-f0-9]{64}$/),
        evaluatedTargetCount: 1,
      }),
    }),
    action: expect.objectContaining({
      actionType: 'rollback_capability_actions',
      parameters: expect.objectContaining({
        evaluatedTargets: [expect.objectContaining({
          actionId: 'action-ccc',
          executionPlanId: planId,
          adapterUsed: 'ironclaw',
        })],
      }),
    }),
    risk: expect.objectContaining({ actionId: expect.any(String), overallTier: expect.any(String) }),
    outcome: expect.objectContaining({ selectedAction: null, autoExecute: false }),
    explanation: expect.objectContaining({
      summary: expect.stringContaining('deliberately made no external change'),
    }),
  }));
  expect(mocks.getRouter).not.toHaveBeenCalled();
});
