import { expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mocks = vi.hoisted(() => ({
  findApproval: vi.fn(),
  respond: vi.fn(),
  recordFirstConfirmation: vi.fn(),
  getRiskAssessment: vi.fn(),
  findUser: vi.fn(),
  getPolicies: vi.fn(),
  prepareExecution: vi.fn(),
  executePrepared: vi.fn(),
  admitApprovalExecution: vi.fn(),
  createFeedback: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: {
    findById: mocks.findApproval,
    respond: mocks.respond,
    recordFirstConfirmation: mocks.recordFirstConfirmation,
  },
  decisionRepository: {},
  decisionRepositoryAdapter: { getRiskAssessment: mocks.getRiskAssessment },
  executionAdmissionRepository: { admitApprovalExecution: mocks.admitApprovalExecution },
  executionRepository: {},
  feedbackRepository: { create: mocks.createFeedback },
  mempalaceRepository: {},
  memoryActionOpportunityRepository: {},
  userRepository: { findById: mocks.findUser },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  policyRepositoryAdapter: { getAllPolicies: mocks.getPolicies },
  getPolicyAuthorityRevision: vi.fn(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn(function TwinService() { return {}; }),
}));

vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: vi.fn(async () => ({
    prepareExecution: mocks.prepareExecution,
    executePrepared: mocks.executePrepared,
  })),
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

vi.mock('../middleware/validate-uuid.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/validate-uuid.js')>(
    '../middleware/validate-uuid.js',
  );
  return { ...actual, bindUserIdParamValidator: vi.fn() };
});

vi.mock('../sse.js', () => ({ sseManager: { emit: vi.fn() } }));
vi.mock('../memory-setup.js', () => ({ getMemoryPortForUser: vi.fn() }));
vi.mock('@skytwin/core', async () => {
  const actual = await vi.importActual<typeof import('@skytwin/core')>('@skytwin/core');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { createApprovalsRouter } from '../routes/approvals.js';

const userId = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const actionId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000abc';

function app(): Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/approvals', createApprovalsRouter());
  instance.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error.message });
  });
  return instance;
}

async function approve(instance: Express): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = instance.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}/api/approvals/approval-1/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', userId }),
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

it('adv-v1-approvals-untrusted-account-dual requires dual confirmation without dispatch', async () => {
  const storedAction = {
    id: actionId,
    actionType: 'delete_account',
    description: 'Delete the account',
    domain: 'account',
    parameters: {},
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: false,
    confidence: 'high',
    reasoning: 'An inbound message requested account deletion.',
    provenance: 'untrusted_external',
  };
  mocks.findApproval.mockResolvedValue({
    id: 'approval-1',
    user_id: userId,
    decision_id: 'decision-1',
    candidate_action: storedAction,
    status: 'pending',
    confirmation_level: 'single',
  });
  const risk = {
    actionId,
    overallTier: 'critical',
    dimensions: {},
    reasoning: 'Account deletion is critical.',
    assessedAt: new Date('2026-09-14T00:00:00.000Z'),
  };
  mocks.getRiskAssessment.mockResolvedValue(risk);
  mocks.findUser.mockResolvedValue({ id: userId, trust_tier: 'high_autonomy', autonomy_settings: {} });
  mocks.getPolicies.mockResolvedValue([]);
  mocks.prepareExecution.mockImplementation(async (candidate, sourceRisk) => ({
    handle: {},
    adapterName: 'direct',
    planId: '44444444-4444-4444-8444-444444444444',
    riskAssessment: sourceRisk,
    streaming: false,
    routingDecision: { selectedAdapter: 'direct', reasoning: `Prepared ${candidate.actionType}.` },
  }));

  const response = await approve(app());
  const preparedCandidate = mocks.prepareExecution.mock.calls[0]?.[0];
  const prepared = await mocks.prepareExecution.mock.results[0]?.value;

  expect({ response, preparedCandidate, prepared, sideEffects: {
    prepared: mocks.prepareExecution.mock.calls.length,
    responded: mocks.respond.mock.calls.length,
    feedback: mocks.createFeedback.mock.calls.length,
    admitted: mocks.admitApprovalExecution.mock.calls.length,
    dispatched: mocks.executePrepared.mock.calls.length,
  } }).toMatchObject({
    response: { status: 409, body: { error: 'confirmation_level_changed' } },
    preparedCandidate: {
      actionType: 'delete_account',
      parameters: {},
      reversible: false,
      provenance: 'untrusted_external',
    },
    prepared: {
      adapterName: 'direct',
      routingDecision: { selectedAdapter: 'direct' },
    },
    sideEffects: { prepared: 1, responded: 0, feedback: 0, admitted: 0, dispatched: 0 },
  });
});
