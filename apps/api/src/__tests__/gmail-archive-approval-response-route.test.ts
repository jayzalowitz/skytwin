import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';

const {
  approvalRepo,
  archiveResponder,
  decisionRepo,
  decisionAdapter,
  executionAdmissionRepo,
  executionRepo,
  feedbackRepo,
  mempalaceRepo,
  memoryOpportunityRepo,
  userRepo,
  policyRepo,
  processFeedback,
  getExecutionRouter,
  getMemoryPortForUser,
  sseEmit,
} = vi.hoisted(() => ({
  approvalRepo: {
    findById: vi.fn(),
    respond: vi.fn(),
    recordFirstConfirmation: vi.fn(),
    findPending: vi.fn(),
    findByUser: vi.fn(),
    deleteStaleEscalations: vi.fn(),
  },
  archiveResponder: { respond: vi.fn() },
  decisionRepo: {
    findById: vi.fn(),
    findByIds: vi.fn(),
    getCandidateActionsForDecisions: vi.fn(),
    getOutcomesForDecisions: vi.fn(),
  },
  decisionAdapter: {
    getRiskAssessment: vi.fn(),
    saveRiskAssessment: vi.fn(),
    saveOutcome: vi.fn(),
  },
  executionAdmissionRepo: {
    admitApprovalExecution: vi.fn(),
    isDispatchable: vi.fn(),
    findByScope: vi.fn(),
    observeTerminal: vi.fn(),
    failBeforeDispatch: vi.fn(),
    recordPolicyDenial: vi.fn(),
  },
  executionRepo: { finalizeAdmittedPlan: vi.fn() },
  feedbackRepo: { create: vi.fn() },
  mempalaceRepo: { createEpisode: vi.fn() },
  memoryOpportunityRepo: { markStatus: vi.fn() },
  userRepo: { findById: vi.fn() },
  policyRepo: { getAllPolicies: vi.fn() },
  processFeedback: vi.fn(),
  getExecutionRouter: vi.fn(),
  getMemoryPortForUser: vi.fn(),
  sseEmit: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: approvalRepo,
  gmailArchiveRuntimeRepositories: {
    approvalResponse: archiveResponder,
  },
  decisionRepository: decisionRepo,
  decisionRepositoryAdapter: decisionAdapter,
  executionAdmissionRepository: executionAdmissionRepo,
  executionRepository: executionRepo,
  feedbackRepository: feedbackRepo,
  mempalaceRepository: mempalaceRepo,
  memoryActionOpportunityRepository: memoryOpportunityRepo,
  userRepository: userRepo,
  policyRepositoryAdapter: policyRepo,
  getPolicyAuthorityRevision: vi.fn(),
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: class TwinService {
    processFeedback = processFeedback;
  },
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: class PolicyEvaluator {},
}));

vi.mock('@skytwin/execution-router', () => ({
  AmbiguousExecutionError: class AmbiguousExecutionError extends Error {},
  NoRequestExecutionError: class NoRequestExecutionError extends Error {},
}));

vi.mock('../execution-setup.js', () => ({ getExecutionRouter }));
vi.mock('../memory-setup.js', () => ({ getMemoryPortForUser }));
vi.mock('../sse.js', () => ({
  sseManager: { emit: sseEmit, addClient: vi.fn(), removeClient: vi.fn() },
}));
vi.mock('@skytwin/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createApprovalsRouter } from '../routes/approvals.js';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPROVAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DECISION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CANDIDATE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function canonicalCandidate(): Record<string, unknown> {
  return {
    id: CANDIDATE_ID,
    decisionId: DECISION_ID,
    actionType: 'archive_email',
    description: 'Propose moving this message out of the Inbox.',
    domain: 'email',
    parameters: {
      schema: 'gmail_inbox_mutation_v1',
      messageRefId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      operation: 'archive',
    },
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: 'moderate',
    reasoning: 'The trusted Gmail decision identifies one opaque, account-bound message target.',
    provenance: 'untrusted_external',
  };
}

function approvalRow(
  userId = USER_ID,
  candidateAction = canonicalCandidate(),
): Record<string, unknown> {
  return {
    id: APPROVAL_ID,
    user_id: userId,
    decision_id: DECISION_ID,
    candidate_action: candidateAction,
    status: 'pending',
    responded_at: null,
  };
}

function successfulResult(action: 'approve' | 'reject', created = true) {
  return {
    ok: true as const,
    created,
    response: {
      approval: {
        ...approvalRow(),
        status: action === 'approve' ? 'approved' : 'rejected',
        responded_at: new Date('2026-09-11T20:00:00.000Z'),
        response: { action, reason: null },
      },
    },
  };
}

function buildApp(
  identity: 'session' | 'development' | 'none' = 'session',
  injectResponder = true,
): Express {
  const app = express();
  app.use(express.json());
  if (identity !== 'none') {
    app.use((req, _res, next) => {
      if (identity === 'session') req.authenticatedUserId = USER_ID;
      else req.developmentAuthBypassed = true;
      next();
    });
  }
  app.use(
    '/api/approvals',
    createApprovalsRouter(
      injectResponder ? { gmailArchiveApprovalResponder: archiveResponder } : {},
    ),
  );
  return app;
}

async function postJson(
  app: Express,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No server address'));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}/api/approvals/${APPROVAL_ID}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (response) => {
        const responseBody = await response.json() as Record<string, unknown>;
        server.close();
        resolve({ status: response.status, body: responseBody });
      }).catch((error) => {
        server.close();
        reject(error);
      });
    });
  });
}

function expectNoGenericSideEffects(): void {
  expect(approvalRepo.respond).not.toHaveBeenCalled();
  expect(approvalRepo.recordFirstConfirmation).not.toHaveBeenCalled();
  expect(decisionRepo.findById).not.toHaveBeenCalled();
  expect(decisionAdapter.getRiskAssessment).not.toHaveBeenCalled();
  expect(decisionAdapter.saveRiskAssessment).not.toHaveBeenCalled();
  expect(decisionAdapter.saveOutcome).not.toHaveBeenCalled();
  expect(feedbackRepo.create).not.toHaveBeenCalled();
  expect(processFeedback).not.toHaveBeenCalled();
  expect(mempalaceRepo.createEpisode).not.toHaveBeenCalled();
  expect(memoryOpportunityRepo.markStatus).not.toHaveBeenCalled();
  expect(getMemoryPortForUser).not.toHaveBeenCalled();
  expect(policyRepo.getAllPolicies).not.toHaveBeenCalled();
  expect(userRepo.findById).not.toHaveBeenCalled();
  expect(getExecutionRouter).not.toHaveBeenCalled();
  expect(executionAdmissionRepo.admitApprovalExecution).not.toHaveBeenCalled();
  expect(executionRepo.finalizeAdmittedPlan).not.toHaveBeenCalled();
  expect(sseEmit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalRepo.findById.mockResolvedValue(approvalRow());
  archiveResponder.respond.mockResolvedValue(successfulResult('approve'));
});

describe('canonical Gmail archive approval response route', () => {
  it.each([
    ['approve', true, false, 'approved'],
    ['reject', true, false, 'rejected'],
    ['approve', false, true, 'approved'],
  ] as const)(
    'records %s consent without claiming execution (created=%s)',
    async (action, created, replayed, approvalStatus) => {
      archiveResponder.respond.mockResolvedValueOnce(successfulResult(action, created));

      const response = await postJson(buildApp(), { action, userId: USER_ID });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        workflow: 'gmail_archive',
        status: 'approval_recorded',
        requestId: APPROVAL_ID,
        action,
        reason: null,
        approval: {
          id: APPROVAL_ID,
          status: approvalStatus,
          respondedAt: '2026-09-11T20:00:00.000Z',
        },
        execution: null,
        replayed,
        processedAt: '2026-09-11T20:00:00.000Z',
      });
      expect(archiveResponder.respond).toHaveBeenCalledWith({
        approvalId: APPROVAL_ID,
        userId: USER_ID,
        action,
      });
      expectNoGenericSideEffects();
    },
  );

  it('accepts body ownership only with the explicit development marker', async () => {
    const response = await postJson(buildApp('development'), {
      action: 'approve',
      userId: USER_ID,
    });

    expect(response.status).toBe(200);
    expect(archiveResponder.respond).toHaveBeenCalledOnce();
    expectNoGenericSideEffects();
  });

  it('uses the dedicated runtime composition port by default', async () => {
    const response = await postJson(buildApp('session', false), {
      action: 'approve',
      userId: USER_ID,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workflow: 'gmail_archive',
      status: 'approval_recorded',
      execution: null,
    });
    expect(archiveResponder.respond).toHaveBeenCalledOnce();
    expectNoGenericSideEffects();
  });

  it('rejects an unprotected direct router mount', async () => {
    const response = await postJson(buildApp('none'), {
      action: 'approve',
      userId: USER_ID,
    });

    expect(response.status).toBe(401);
    expect(response.body['code']).toBe('GMAIL_ARCHIVE_APPROVAL_AUTH_REQUIRED');
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it('rejects authenticated body-owner substitution before lookup', async () => {
    const response = await postJson(buildApp(), {
      action: 'approve',
      userId: OTHER_USER_ID,
    });

    expect(response.status).toBe(403);
    expect(approvalRepo.findById).not.toHaveBeenCalled();
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it('rejects an approval row owned by another user', async () => {
    approvalRepo.findById.mockResolvedValueOnce(approvalRow(OTHER_USER_ID));

    const response = await postJson(buildApp(), { action: 'approve', userId: USER_ID });

    expect(response.status).toBe(403);
    expect(response.body['code']).toBe('GMAIL_ARCHIVE_APPROVAL_FORBIDDEN');
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it('quarantines malformed archive state without entering either responder', async () => {
    approvalRepo.findById.mockResolvedValueOnce(approvalRow(USER_ID, {
      ...canonicalCandidate(),
      parameters: { schema: 'unexpected' },
    }));

    const response = await postJson(buildApp(), { action: 'approve', userId: USER_ID });

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('GMAIL_ARCHIVE_APPROVAL_INVALID_STATE');
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it.each([
    ['invalid_input', 400, 'GMAIL_ARCHIVE_APPROVAL_INVALID_REQUEST'],
    ['not_found', 404, 'GMAIL_ARCHIVE_APPROVAL_NOT_FOUND'],
    ['not_pending_or_expired', 409, 'GMAIL_ARCHIVE_APPROVAL_NOT_PENDING_OR_EXPIRED'],
    ['idempotency_conflict', 409, 'GMAIL_ARCHIVE_APPROVAL_RESPONSE_CONFLICT'],
  ] as const)('maps repository %s truthfully', async (error, status, code) => {
    archiveResponder.respond.mockResolvedValueOnce({ ok: false, error });

    const response = await postJson(buildApp(), { action: 'approve', userId: USER_ID });

    expect(response.status).toBe(status);
    expect(response.body['code']).toBe(code);
    expectNoGenericSideEffects();
  });
});
