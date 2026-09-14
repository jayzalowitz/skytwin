import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mcpServers,
  executions,
  users,
  policies,
  decisions,
  explanations,
  barriers,
  getRouter,
  executeRollback,
  query,
} = vi.hoisted(() => ({
  mcpServers: { getById: vi.fn() },
  executions: { getRollbackTargetsByServer: vi.fn() },
  users: { findById: vi.fn() },
  policies: { getEnabledPolicies: vi.fn(), evaluate: vi.fn() },
  decisions: {
    saveDecision: vi.fn(),
    saveCandidates: vi.fn(),
    saveRiskAssessment: vi.fn(),
    saveOutcome: vi.fn(),
  },
  explanations: { save: vi.fn() },
  barriers: {
    reserve: vi.fn(),
    markPrepared: vi.fn(),
    claimPrepared: vi.fn(),
    markTerminal: vi.fn(),
  },
  getRouter: vi.fn(),
  executeRollback: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mcpServers,
  appSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  executionRepository: executions,
  userRepository: users,
  policyRepositoryAdapter: policies,
  decisionRepositoryAdapter: decisions,
  explanationRepositoryAdapter: explanations,
  preEffectBarrierRepository: barriers,
  mcpServerChangelogRepository: {},
  mcpServerMetricsRepository: {},
  provenanceRepository: {},
  query,
}));

vi.mock('@skytwin/policy-engine', async () => {
  const actual = await vi.importActual<typeof import('@skytwin/policy-engine')>('@skytwin/policy-engine');
  return {
    ...actual,
    PolicyEvaluator: vi.fn(function PolicyEvaluator() { return policies; }),
  };
});

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn(function RegistryClient() {
    return { search: vi.fn().mockResolvedValue([]), getAll: vi.fn().mockResolvedValue([]) };
  }),
}));
vi.mock('../execution-setup.js', () => ({ getExecutionRouter: getRouter }));
vi.mock('../lib/llm-client-factory.js', () => ({ getLlmClientFromConfig: vi.fn() }));
vi.mock('../sse.js', () => ({
  sseManager: {},
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability:promotion-offered',
}));

import { createCapabilitiesRouter } from '../routes/capabilities.js';

const serverId = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const userId = 'ffffffff-eeee-dddd-cccc-000000000001';
const planId = '22222222-2222-4222-8222-222222222222';
const barrierId = '11111111-1111-4111-8111-111111111111';

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
        const responseBody = await response.json();
        server.close();
        resolve({ status: response.status, body: responseBody });
      }).catch((error) => {
        server.close();
        reject(error);
      });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mcpServers.getById.mockResolvedValue({
    id: serverId,
    user_id: userId,
    display_name: 'Filesystem',
  });
  executions.getRollbackTargetsByServer.mockResolvedValue([{
    actionId: 'action-ccc',
    payload: { reversible: true },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    executionPlanId: planId,
    adapterUsed: 'ironclaw',
  }]);
  users.findById.mockResolvedValue({
    id: userId,
    trust_tier: 'high_autonomy',
    autonomy_settings: {},
  });
  policies.getEnabledPolicies.mockResolvedValue([]);
  policies.evaluate.mockResolvedValue({
    allowed: true,
    requiresApproval: false,
    reason: 'Direct request passed policy.',
  });
  decisions.saveDecision.mockImplementation(async (value: unknown) => ({ decision: value, created: true }));
  decisions.saveCandidates.mockImplementation(async (value: unknown) => value);
  decisions.saveRiskAssessment.mockImplementation(async (value: unknown) => value);
  decisions.saveOutcome.mockImplementation(async (value: unknown) => value);
  explanations.save.mockImplementation(async (value: unknown) => value);
  barriers.reserve.mockResolvedValue({
    row: { id: barrierId, status: 'reserved', effect_result: {} },
    created: true,
  });
  barriers.markPrepared.mockResolvedValue({ status: 'prepared' });
  barriers.claimPrepared.mockResolvedValue({ status: 'in_progress' });
  barriers.markTerminal.mockResolvedValue({ status: 'succeeded' });
  executeRollback.mockResolvedValue({
    result: { success: true, message: 'Rolled back by ironclaw' },
    adapterUsed: 'ironclaw',
    noAdapter: false,
  });
  getRouter.mockResolvedValue({
    prepareRollback: vi.fn((action, risk, _owner, exactPlanId, adapterUsed) => ({
      planId: exactPlanId,
      adapterUsed,
      action,
      routingDecision: {
        selectedAdapter: adapterUsed,
        trustProfile: {
          name: adapterUsed,
          reversibilityGuarantee: 'full',
          authModel: 'hmac',
          auditTrail: true,
          riskModifier: 0,
        },
        riskModifierApplied: 0,
        modifiedRiskAssessment: risk,
        fallbackChain: [],
        reasoning: 'Exact rollback adapter selected.',
      },
    })),
    claimPreparedRollback: vi.fn(async () => ({ barrierId })),
    executeAdmittedRollback: executeRollback,
  });
});

it('adv-v1-capability-regret-no-dispatch reports unavailable without rollback side effects', async () => {
  const response = await post(app());

  expect(response).toEqual({
    status: 200,
    body: {
      status: 'report_only',
      code: 'generic_rollback_report_only',
      undone: [],
      unavailable: [{
      actionId: 'action-ccc',
      planId,
      adapterUsed: 'ironclaw',
        result: 'rollback_unavailable',
        message: expect.any(String),
      }],
      irreversible: [],
    },
  });
  expect(getRouter).not.toHaveBeenCalled();
  expect(executeRollback).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalledWith(
    expect.stringContaining('capability_provenance_nodes'),
    expect.anything(),
  );
});
