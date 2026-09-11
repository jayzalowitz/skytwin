import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';

const {
  approvalRepo,
  archiveResponder,
  decisionRepo,
  decisionAdapter,
  feedbackRepo,
  mempalaceRepo,
  memoryOpportunityRepo,
  oauthRepo,
  userRepo,
  policyRepo,
  barrierRepo,
  explanationRepo,
  sessionRepo,
  processFeedback,
  policyEvaluate,
  getExecutionRouter,
  getMemoryPortForUser,
  sseEmit,
  withTransaction,
} = vi.hoisted(() => ({
  approvalRepo: {
    findById: vi.fn(), respond: vi.fn(), recordFirstConfirmation: vi.fn(),
    findPending: vi.fn(), findByUser: vi.fn(), deleteStaleEscalations: vi.fn(),
  },
  archiveResponder: { respond: vi.fn() },
  decisionRepo: {
    findById: vi.fn(), findByIds: vi.fn(), getCandidateActionsForDecisions: vi.fn(),
    getOutcomesForDecisions: vi.fn(),
  },
  decisionAdapter: {
    getRiskAssessment: vi.fn(), saveRiskAssessment: vi.fn(), saveOutcome: vi.fn(),
  },
  feedbackRepo: { create: vi.fn() },
  mempalaceRepo: { createEpisode: vi.fn() },
  memoryOpportunityRepo: { markStatus: vi.fn() },
  oauthRepo: { getToken: vi.fn() },
  userRepo: { findById: vi.fn() },
  policyRepo: {
    getAllPolicies: vi.fn(), getEnabledPolicies: vi.fn(), getPolicy: vi.fn(),
    getPoliciesByDomain: vi.fn(), savePolicy: vi.fn(), updatePolicy: vi.fn(), deletePolicy: vi.fn(),
  },
  barrierRepo: {
    reserve: vi.fn(), markPrepared: vi.fn(), claimPrepared: vi.fn(), markTerminal: vi.fn(),
  },
  explanationRepo: { save: vi.fn() },
  sessionRepo: {
    findByTokenHash: vi.fn(), refreshExpiry: vi.fn(), touchLastActive: vi.fn(),
  },
  processFeedback: vi.fn(),
  policyEvaluate: vi.fn(),
  getExecutionRouter: vi.fn(),
  getMemoryPortForUser: vi.fn(),
  sseEmit: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: approvalRepo,
  gmailArchiveApprovalResponseRepository: archiveResponder,
  decisionRepository: decisionRepo,
  decisionRepositoryAdapter: decisionAdapter,
  feedbackRepository: feedbackRepo,
  mempalaceRepository: mempalaceRepo,
  memoryActionOpportunityRepository: memoryOpportunityRepo,
  oauthRepository: oauthRepo,
  userRepository: userRepo,
  policyRepositoryAdapter: policyRepo,
  preEffectBarrierRepository: barrierRepo,
  explanationRepositoryAdapter: explanationRepo,
  sessionRepository: sessionRepo,
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  withTransaction,
  runWithRequestContext: (_context: unknown, callback: () => unknown) => callback(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: class TwinService {
    processFeedback = processFeedback;
  },
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: class PolicyEvaluator {
    evaluate = policyEvaluate;
  },
}));

vi.mock('@skytwin/execution-router', () => ({
  AmbiguousExecutionError: class AmbiguousExecutionError extends Error {},
  EXECUTION_FAILURE_CODES: {},
  executionFailureCode: vi.fn(() => 'unknown'),
}));

vi.mock('../execution-setup.js', () => ({ getExecutionRouter }));
vi.mock('../memory-setup.js', () => ({ getMemoryPortForUser }));
vi.mock('../sse.js', () => ({
  sseManager: { emit: sseEmit, addClient: vi.fn(), removeClient: vi.fn() },
}));
vi.mock('@skytwin/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const priorBypass = process.env['SKYTWIN_DEV_AUTH_BYPASS'];
process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';

const [{ createApprovalsRouter }, { sessionAuth }, { requireOwnership }, { requestContext }] =
  await Promise.all([
    import('../routes/approvals.js'),
    import('../middleware/session-auth.js'),
    import('../middleware/require-ownership.js'),
    import('../middleware/request-context.js'),
  ]);

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

function approvalRow(userId = USER_ID, candidateAction = canonicalCandidate()) {
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
  const respondedAt = new Date('2026-09-11T20:00:00.000Z');
  return {
    ok: true as const,
    created,
    response: {
      approval: {
        ...approvalRow(),
        status: action === 'approve' ? 'approved' : 'rejected',
        responded_at: respondedAt,
        response: { action, reason: null },
      },
    },
  };
}

function productionApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/approvals',
    sessionAuth,
    requireOwnership,
    requestContext,
    createApprovalsRouter({ gmailArchiveApprovalResponder: archiveResponder }),
  );
  return app;
}

function directApp(marker?: 'development'): Express {
  const app = express();
  app.use(express.json());
  if (marker === 'development') {
    app.use((req, _res, next) => {
      req.developmentAuthBypassed = true;
      next();
    });
  }
  app.use(
    '/api/approvals',
    createApprovalsRouter({ gmailArchiveApprovalResponder: archiveResponder }),
  );
  return app;
}

async function postJson(
  app: Express,
  body: Record<string, unknown>,
  authorization = true,
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
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization: 'Bearer session-token' } : {}),
        },
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
  expect(policyEvaluate).not.toHaveBeenCalled();
  expect(userRepo.findById).not.toHaveBeenCalled();
  expect(oauthRepo.getToken).not.toHaveBeenCalled();
  expect(getExecutionRouter).not.toHaveBeenCalled();
  expect(barrierRepo.reserve).not.toHaveBeenCalled();
  expect(barrierRepo.markPrepared).not.toHaveBeenCalled();
  expect(barrierRepo.claimPrepared).not.toHaveBeenCalled();
  expect(barrierRepo.markTerminal).not.toHaveBeenCalled();
  expect(explanationRepo.save).not.toHaveBeenCalled();
  expect(sseEmit).not.toHaveBeenCalled();
  expect(withTransaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionRepo.findByTokenHash.mockResolvedValue({
    id: 'session-id',
    user_id: USER_ID,
    expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000),
  });
  sessionRepo.touchLastActive.mockResolvedValue(undefined);
  approvalRepo.findById.mockResolvedValue(approvalRow());
  archiveResponder.respond.mockResolvedValue(successfulResult('approve'));
});

afterAll(() => {
  if (priorBypass === undefined) delete process.env['SKYTWIN_DEV_AUTH_BYPASS'];
  else process.env['SKYTWIN_DEV_AUTH_BYPASS'] = priorBypass;
});

describe('canonical Gmail archive approval response route', () => {
  it.each([
    ['approve', true, false, 'approved'],
    ['reject', true, false, 'rejected'],
    ['approve', false, true, 'approved'],
  ] as const)(
    'records %s through the production auth chain (created=%s)',
    async (action, created, replayed, approvalStatus) => {
      archiveResponder.respond.mockResolvedValueOnce(successfulResult(action, created));

      const response = await postJson(productionApp(), { action, userId: USER_ID });

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

  it('accepts body ownership only when the explicit development marker is present', async () => {
    const response = await postJson(
      directApp('development'),
      { action: 'approve', userId: USER_ID },
      false,
    );

    expect(response.status).toBe(200);
    expect(archiveResponder.respond).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      userId: USER_ID,
      action: 'approve',
    });
    expectNoGenericSideEffects();
  });

  it('returns 401 when the dedicated router has neither session identity nor the dev marker', async () => {
    const response = await postJson(
      directApp(),
      { action: 'approve', userId: USER_ID },
      false,
    );

    expect(response.status).toBe(401);
    expect(response.body['code']).toBe('GMAIL_ARCHIVE_APPROVAL_AUTH_REQUIRED');
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it('returns 401 before the router when the production session is missing', async () => {
    const response = await postJson(
      productionApp(),
      { action: 'approve', userId: USER_ID },
      false,
    );

    expect(response.status).toBe(401);
    expect(approvalRepo.findById).not.toHaveBeenCalled();
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it('rejects authenticated body-owner substitution in the ownership middleware', async () => {
    const response = await postJson(productionApp(), {
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

    const response = await postJson(productionApp(), { action: 'approve', userId: USER_ID });

    expect(response.status).toBe(403);
    expect(response.body['code']).toBe('GMAIL_ARCHIVE_APPROVAL_FORBIDDEN');
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });

  it('blocks a malformed reserved shape without entering either responder', async () => {
    approvalRepo.findById.mockResolvedValueOnce(approvalRow(USER_ID, {
      ...canonicalCandidate(),
      parameters: { schema: 'unexpected' },
    }));

    const response = await postJson(productionApp(), { action: 'approve', userId: USER_ID });

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
  ] as const)('maps repository %s without generic side effects', async (error, status, code) => {
    archiveResponder.respond.mockResolvedValueOnce({ ok: false, error });

    const response = await postJson(productionApp(), { action: 'approve', userId: USER_ID });

    expect(response.status).toBe(status);
    expect(response.body['code']).toBe(code);
    expectNoGenericSideEffects();
  });

  it('preserves the initial not-found response without calling the dedicated repository', async () => {
    approvalRepo.findById.mockResolvedValueOnce(null);

    const response = await postJson(productionApp(), { action: 'approve', userId: USER_ID });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Approval request not found' });
    expect(archiveResponder.respond).not.toHaveBeenCalled();
    expectNoGenericSideEffects();
  });
});
