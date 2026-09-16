import { expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mocks = vi.hoisted(() => ({
  findApproval: vi.fn(),
  respond: vi.fn(),
  getRiskAssessment: vi.fn(),
  findUser: vi.fn(),
  getPolicies: vi.fn(),
  prepareExecution: vi.fn(),
  executePrepared: vi.fn(),
  recordPreflight: vi.fn(),
  admitApprovalExecution: vi.fn(),
  createFeedback: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: {
    findById: mocks.findApproval,
    respond: mocks.respond,
    recordFirstConfirmation: vi.fn(),
  },
  decisionRepository: {},
  decisionRepositoryAdapter: { getRiskAssessment: mocks.getRiskAssessment },
  executionAdmissionRepository: {
    admitApprovalExecution: mocks.admitApprovalExecution,
    recordApprovalPreflightNonAction: mocks.recordPreflight,
  },
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
vi.mock('../middleware/require-ownership.js', () => ({ bindUserIdParamOwnership: vi.fn() }));
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

/**
 * Reserved v2 route contract. Activation replaces only `it.skip` with `it`
 * after the persistence implementation lands, then appends the final source
 * digest and activation commit to the v2 migration fixture.
 */
it.skip('adv-v2-approvals-preflight-explanation persists before returning', async () => {
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
  const sourceRisk = {
    actionId,
    overallTier: 'critical',
    dimensions: {},
    reasoning: 'Account deletion is critical.',
    assessedAt: new Date('2026-09-14T00:00:00.000Z'),
  };
  mocks.findApproval.mockResolvedValue({
    id: 'approval-1',
    user_id: userId,
    decision_id: 'decision-1',
    candidate_action: storedAction,
    status: 'pending',
    confirmation_level: 'single',
  });
  mocks.getRiskAssessment.mockResolvedValue(sourceRisk);
  mocks.findUser.mockResolvedValue({ id: userId, trust_tier: 'high_autonomy', autonomy_settings: {} });
  mocks.getPolicies.mockResolvedValue([]);
  mocks.prepareExecution.mockImplementation(async (candidate, risk) => ({
    handle: {},
    adapterName: 'direct',
    planId: '44444444-4444-4444-8444-444444444444',
    riskAssessment: risk,
    streaming: false,
    routingDecision: { selectedAdapter: 'direct', reasoning: `Prepared ${candidate.actionType}.` },
  }));
  mocks.recordPreflight.mockResolvedValue({
    explanationId: 'preflight-explanation-1',
    evidence: { kind: 'approval_preflight_non_action' },
    created: true,
  });

  const response = await approve(app());

  expect(response).toMatchObject({
    status: 409,
    body: { error: 'confirmation_level_changed' },
  });
  expect(mocks.recordPreflight).toHaveBeenCalledWith(expect.objectContaining({
    approvalId: 'approval-1',
    decisionId: 'decision-1',
    actionId,
    disposition: 'dual_confirmation_required',
    sourceActionSnapshot: storedAction,
    sourceRiskSnapshot: sourceRisk,
    actionSnapshot: expect.objectContaining({
      actionType: 'delete_account',
      reversible: false,
      provenance: 'untrusted_external',
    }),
    riskSnapshot: expect.objectContaining({ actionId, overallTier: 'high' }),
    policySnapshot: expect.objectContaining({ effectiveAllowed: false }),
  }));
  expect(mocks.respond).not.toHaveBeenCalled();
  expect(mocks.createFeedback).not.toHaveBeenCalled();
  expect(mocks.admitApprovalExecution).not.toHaveBeenCalled();
  expect(mocks.executePrepared).not.toHaveBeenCalled();
});
