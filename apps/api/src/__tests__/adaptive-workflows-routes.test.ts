import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import { compileSignalDigestV1 } from '@skytwin/routines';
import { createAdaptiveWorkflowService } from '../lib/adaptive-workflow-service.js';
import { createAdaptiveWorkflowsRouter } from '../routes/adaptive-workflows.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const WORKFLOW_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const VERSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000003';
const PREVIOUS_VERSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000004';
const PROPOSAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000005';
const EVENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000006';
const REVISION_VERSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000007';
const REVISION_PROPOSAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000008';

const now = new Date('2026-09-16T12:00:00.000Z');
const payload = {
  name: 'Morning invoice digest',
  cadence: 'daily' as const,
  hourOfDay: 9,
  timezone: 'UTC',
  action: 'digest' as const,
  filter: { sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [] },
  summaryInstruction: 'Summarize matching invoices with totals.',
};
const compiled = compileSignalDigestV1(payload);
if (!compiled.ok) throw new Error('test payload must compile');
const routineSpec = compiled.artifact.routineSpec;
const revisionPayload = {
  ...payload,
  name: 'Morning invoice and receipt digest',
  filter: { ...payload.filter, keywords: ['invoice', 'receipt'] },
};
const revisionCompiled = compileSignalDigestV1(revisionPayload);
if (!revisionCompiled.ok) throw new Error('test revision payload must compile');

const workflow = {
  id: WORKFLOW_ID,
  userId: USER_ID,
  providerKey: 'signal_digest.v1',
  activeVersionId: null,
  createdAt: now,
  updatedAt: now,
};
const version = {
  id: VERSION_ID,
  workflowId: WORKFLOW_ID,
  userId: USER_ID,
  versionNumber: 1,
  providerKey: 'signal_digest.v1',
  providerSchemaVersion: '1',
  canonicalPayload: payload,
  contentHash: compiled.artifact.contentHash,
  parentVersionId: null,
  authoring: { version: 1 as const, source: 'llm_assisted' as const, sourceReferences: [] },
  inference: null,
  createdAt: now,
};
const proposal = {
  id: PROPOSAL_ID,
  workflowId: WORKFLOW_ID,
  userId: USER_ID,
  baseVersionId: null,
  proposedVersionId: VERSION_ID,
  kind: 'initial' as const,
  createdAt: now,
};
const revisionVersion = {
  ...version,
  id: REVISION_VERSION_ID,
  versionNumber: 2,
  canonicalPayload: revisionPayload,
  contentHash: revisionCompiled.artifact.contentHash,
  parentVersionId: VERSION_ID,
  authoring: { version: 1 as const, source: 'user' as const, sourceReferences: [] },
};
const revisionProposal = {
  ...proposal,
  id: REVISION_PROPOSAL_ID,
  baseVersionId: VERSION_ID,
  proposedVersionId: REVISION_VERSION_ID,
  kind: 'edit' as const,
};
const event = {
  id: EVENT_ID,
  workflowId: WORKFLOW_ID,
  userId: USER_ID,
  sequence: 1,
  previousVersionId: null,
  activatedVersionId: VERSION_ID,
  proposalId: PROPOSAL_ID,
  kind: 'activate' as const,
  createdAt: now,
};

function mockService() {
  return {
    readiness: vi.fn(),
    authorSignalDigestDraft: vi.fn(),
    createRevision: vi.fn(),
    reviseFromFeedback: vi.fn(),
    resumableDraft: vi.fn(),
    list: vi.fn(),
    detail: vi.fn(),
    versions: vi.fn(),
    activate: vi.fn(),
    rollbackWorkflowVersion: vi.fn(),
  };
}

function buildApp(service: ReturnType<typeof mockService>): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/adaptive-workflows', createAdaptiveWorkflowsRouter({ service }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
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
        reject(new Error('Could not determine test server port'));
        return;
      }
      const options: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
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

describe('adaptive workflow routes', () => {
  const service = mockService();

  beforeEach(() => vi.clearAllMocks());

  it('reports ready only from the service structured canary', async () => {
    service.readiness.mockResolvedValue({
      state: 'ready', reasoningMode: 'on_device', provider: 'embedded', model: 'managed',
      promptVersion: 1, schemaVersion: 1,
    });
    const response = await request(
      buildApp(service),
      'GET',
      `/api/adaptive-workflows/${USER_ID}/readiness`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ readiness: { state: 'ready', reasoningMode: 'on_device' } });
  });

  it('surfaces local runtime unavailability as 503', async () => {
    service.readiness.mockResolvedValue({
      state: 'runtime_unavailable', reason: 'local runtime unavailable', retryable: true,
    });
    const response = await request(
      buildApp(service),
      'GET',
      `/api/adaptive-workflows/${USER_ID}/readiness`,
    );
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ readiness: { state: 'runtime_unavailable' } });
  });

  it('surfaces a missing or invalid local model artifact as actionable setup', async () => {
    service.readiness.mockResolvedValue({
      state: 'artifact_unavailable', reason: 'managed artifact missing', retryable: false,
    });
    const response = await request(
      buildApp(service),
      'GET',
      `/api/adaptive-workflows/${USER_ID}/readiness`,
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ readiness: { state: 'artifact_unavailable' } });
  });

  it('creates a draft and returns the non-materialized preview', async () => {
    service.authorSignalDigestDraft.mockResolvedValue({
      success: true,
      workflow,
      version,
      proposal,
      preview: {
        summaryInstruction: payload.summaryInstruction,
        summaryInstructionPersisted: true,
        routineSpec,
        contentHash: version.contentHash,
        watchProjection: 'not_materialized',
      },
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/signal-digest-drafts`,
      { description: 'Every morning summarize Gmail invoices.' },
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      workflow: { id: WORKFLOW_ID, activeVersionId: null },
      preview: { summaryInstructionPersisted: true, watchProjection: 'not_materialized' },
    });
  });

  it('does not call authoring for an empty description', async () => {
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/signal-digest-drafts`,
      { description: '  ' },
    );
    expect(response.status).toBe(400);
    expect(service.authorSignalDigestDraft).not.toHaveBeenCalled();
  });

  it('maps policy-blocked authoring without persistence', async () => {
    service.authorSignalDigestDraft.mockResolvedValue({
      success: false,
      kind: 'authoring',
      failure: { success: false, state: 'policy_blocked', reason: 'mode mismatch', retryable: false },
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/signal-digest-drafts`,
      { description: 'Every morning summarize Gmail invoices.' },
    );
    expect(response.status).toBe(403);
  });

  it('returns one safe clarification question without persisting a workflow', async () => {
    service.authorSignalDigestDraft.mockResolvedValue({
      success: false,
      kind: 'authoring',
      failure: {
        success: false,
        state: 'clarification_required',
        reason: 'One essential detail is needed before SkyTwin can prepare a safe workflow.',
        retryable: false,
        missingField: 'cadence',
        question: 'How often should this digest run?',
      },
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/signal-digest-drafts`,
      { description: 'Watch my invoice email.' },
    );
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      failure: {
        state: 'clarification_required',
        missingField: 'cadence',
        question: 'How often should this digest run?',
      },
    });
  });

  it('lists workflows and returns detail plus immutable history', async () => {
    service.list.mockResolvedValue([workflow]);
    service.detail.mockResolvedValue({
      workflow, versions: [version], proposals: [proposal], activationEvents: [], activeVersion: null,
    });
    service.versions.mockResolvedValue([version]);

    const app = buildApp(service);
    expect((await request(app, 'GET', `/api/adaptive-workflows/${USER_ID}`)).body)
      .toMatchObject({ workflows: [{ id: WORKFLOW_ID }] });
    expect((await request(app, 'GET', `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}`)).body)
      .toMatchObject({ workflow: { id: WORKFLOW_ID }, versions: [{ id: VERSION_ID }] });
    expect((await request(app, 'GET', `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/versions`)).body)
      .toMatchObject({ versions: [{ id: VERSION_ID, versionNumber: 1 }] });
  });

  it('returns 404 for an unowned or missing workflow without leaking versions', async () => {
    service.detail.mockResolvedValue(null);
    service.versions.mockResolvedValue(null);
    const app = buildApp(service);
    expect((await request(app, 'GET', `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}`)).status)
      .toBe(404);
    expect((await request(app, 'GET', `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/versions`)).status)
      .toBe(404);
  });

  it('returns a durable unactivated proposal for reload recovery', async () => {
    service.resumableDraft.mockResolvedValue({
      kind: 'initial', workflow, version, proposal, preview: { replay: {} },
    });
    const response = await request(
      buildApp(service),
      'GET',
      `/api/adaptive-workflows/${USER_ID}/resumable-draft`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      candidate: { workflow: { id: WORKFLOW_ID }, proposal: { id: PROPOSAL_ID } },
    });
  });

  it('creates a strictly structured immutable revision without moving the active pointer', async () => {
    service.createRevision.mockResolvedValue({
      success: true,
      workflow,
      parentVersion: version,
      version: revisionVersion,
      proposal: revisionProposal,
      diff: {
        changed: true,
        metadataChanged: true,
        trigger: { changed: false, classification: 'unchanged', broadened: false, reasons: [] },
        filter: { changed: true, classification: 'broadening', broadened: true, reasons: ['keywords added: receipt'] },
        dataScope: { changed: false, classification: 'unchanged', broadened: false, reasons: [] },
        destination: { changed: false, classification: 'unchanged', broadened: false, reasons: [] },
        authorityRelevantBroadening: true,
        requiresExplicitApproval: true,
      },
      replay: { before: {}, after: {} },
      activePointerMoved: false,
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/revisions`,
      { parentVersionId: VERSION_ID, payload: revisionPayload },
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      version: { id: REVISION_VERSION_ID, parentVersionId: VERSION_ID },
      diff: { authorityRelevantBroadening: true, requiresExplicitApproval: true },
      activePointerMoved: false,
    });
    expect(service.createRevision).toHaveBeenCalledWith({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      parentVersionId: VERSION_ID,
      payload: revisionPayload,
    });
  });

  it('rejects revision wrapper fields outside the closed route contract', async () => {
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/revisions`,
      { parentVersionId: VERSION_ID, payload: revisionPayload, activate: true },
    );
    expect(response.status).toBe(400);
    expect(service.createRevision).not.toHaveBeenCalled();
  });

  it('authors a minimal feedback revision without accepting activation fields', async () => {
    service.reviseFromFeedback.mockResolvedValue({
      success: true,
      workflow,
      parentVersion: version,
      version: revisionVersion,
      proposal: { ...revisionProposal, kind: 'feedback' },
      diff: { changed: true, requiresExplicitApproval: true },
      replay: { before: {}, after: {} },
      activePointerMoved: false,
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/feedback-revisions`,
      { parentVersionId: VERSION_ID, feedback: 'Also include receipts.' },
    );
    expect(response.status).toBe(201);
    expect(service.reviseFromFeedback).toHaveBeenCalledWith({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      parentVersionId: VERSION_ID,
      feedback: 'Also include receipts.',
    });

    const rejected = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/feedback-revisions`,
      { parentVersionId: VERSION_ID, feedback: 'Also include receipts.', activate: true },
    );
    expect(rejected.status).toBe(400);
  });

  it('validates transition UUIDs before touching the service', async () => {
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/activate`,
      { versionId: 'not-a-uuid', proposalId: PROPOSAL_ID, expectedActiveVersionId: null },
    );
    expect(response.status).toBe(400);
    expect(service.activate).not.toHaveBeenCalled();
  });

  it('activates the requested version and reports its materialized Watch projection', async () => {
    service.activate.mockResolvedValue({
      success: true,
      workflow: { ...workflow, activeVersionId: VERSION_ID },
      version,
      event,
      preview: {
        routineSpec,
        contentHash: version.contentHash,
        watchProjection: {
          state: 'materialized',
          watchId: 'aaaaaaaa-bbbb-cccc-dddd-000000000009',
          nextRunAt: '2026-09-17T09:00:00.000Z',
          timezone: 'UTC',
        },
      },
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/activate`,
      { versionId: VERSION_ID, proposalId: PROPOSAL_ID, expectedActiveVersionId: null },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      workflow: { activeVersionId: VERSION_ID },
      preview: { watchProjection: { state: 'materialized', timezone: 'UTC' } },
    });
  });

  it('returns 409 on optimistic activation conflict', async () => {
    service.activate.mockResolvedValue({ success: false, reason: 'active_version_conflict' });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/activate`,
      { versionId: VERSION_ID, proposalId: PROPOSAL_ID, expectedActiveVersionId: PREVIOUS_VERSION_ID },
    );
    expect(response.status).toBe(409);
  });

  it('rolls back by rematerializing the prior immutable version', async () => {
    service.rollbackWorkflowVersion.mockResolvedValue({
      success: true,
      workflow: { ...workflow, activeVersionId: VERSION_ID },
      version,
      event: { ...event, kind: 'rollback', proposalId: null, previousVersionId: PREVIOUS_VERSION_ID },
      preview: {
        routineSpec,
        contentHash: version.contentHash,
        watchProjection: {
          state: 'materialized',
          watchId: 'aaaaaaaa-bbbb-cccc-dddd-000000000009',
          nextRunAt: '2026-09-17T09:00:00.000Z',
          timezone: 'UTC',
        },
      },
    });
    const response = await request(
      buildApp(service),
      'POST',
      `/api/adaptive-workflows/${USER_ID}/${WORKFLOW_ID}/rollback`,
      { versionId: VERSION_ID, expectedActiveVersionId: PREVIOUS_VERSION_ID },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      event: { kind: 'rollback' },
      preview: { watchProjection: { state: 'materialized' } },
    });
  });

  it('rejects malformed workflow IDs before repository-backed service calls', async () => {
    const response = await request(
      buildApp(service),
      'GET',
      `/api/adaptive-workflows/${USER_ID}/not-a-uuid`,
    );
    expect(response.status).toBe(400);
    expect(service.detail).not.toHaveBeenCalled();
  });
});

describe('adaptive workflow service composition', () => {
  it('rebuilds the newest unactivated proposal from durable workflow state', async () => {
    const repository = {
      createDraftWithProposal: vi.fn(),
      createVersionWithProposal: vi.fn(),
      getForUser: vi.fn(),
      listForUser: vi.fn().mockResolvedValue([workflow]),
      getVersionForUser: vi.fn(),
      listVersionsForUser: vi.fn().mockResolvedValue([version]),
      listProposalsForUser: vi.fn().mockResolvedValue([proposal]),
      listActivationEventsForUser: vi.fn().mockResolvedValue([]),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      signals: { listInWindowBounded: vi.fn().mockResolvedValue({
        records: [], totalCount: 0, truncated: false,
      }) },
      userLocales: { getLocale: vi.fn().mockResolvedValue({ language: 'en', timezone: 'UTC' }) },
      authoring: {
        probeReadiness: vi.fn(), authorSignalDigest: vi.fn(), reviseSignalDigest: vi.fn(),
        summarizeSignalDigestReplay: vi.fn().mockResolvedValue({
          available: false, text: 'AI summary unavailable',
        }),
      },
      now: () => now,
    });

    await expect(service.resumableDraft(USER_ID)).resolves.toMatchObject({
      kind: 'initial',
      workflow: { id: WORKFLOW_ID, activeVersionId: null },
      version: { id: VERSION_ID },
      proposal: { id: PROPOSAL_ID },
      preview: {
        contentHash: version.contentHash,
        replay: { dataAccess: { kind: 'real_signals', synthetic: false } },
      },
    });
  });

  it('does not resume a proposal that was consumed before a rollback', async () => {
    const rolledBackWorkflow = { ...workflow, activeVersionId: VERSION_ID };
    const repository = {
      createDraftWithProposal: vi.fn(),
      createVersionWithProposal: vi.fn(),
      getForUser: vi.fn(),
      listForUser: vi.fn().mockResolvedValue([rolledBackWorkflow]),
      getVersionForUser: vi.fn(),
      listVersionsForUser: vi.fn().mockResolvedValue([version, revisionVersion]),
      listProposalsForUser: vi.fn().mockResolvedValue([revisionProposal]),
      listActivationEventsForUser: vi.fn().mockResolvedValue([{
        ...event,
        id: 'aaaaaaaa-bbbb-cccc-dddd-000000000009',
        previousVersionId: VERSION_ID,
        activatedVersionId: REVISION_VERSION_ID,
        proposalId: REVISION_PROPOSAL_ID,
      }]),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      signals: { listInWindowBounded: vi.fn().mockResolvedValue({
        records: [], totalCount: 0, truncated: false,
      }) },
      userLocales: { getLocale: vi.fn().mockResolvedValue({ language: 'en', timezone: 'UTC' }) },
      authoring: {
        probeReadiness: vi.fn(), authorSignalDigest: vi.fn(), reviseSignalDigest: vi.fn(),
        summarizeSignalDigestReplay: vi.fn(),
      },
      now: () => now,
    });

    await expect(service.resumableDraft(USER_ID)).resolves.toBeNull();
  });

  it('skips a newer quarantined proposal and resumes the newest valid candidate', async () => {
    const badWorkflowId = 'aaaaaaaa-bbbb-cccc-dddd-000000000099';
    const badWorkflow = {
      ...workflow, id: badWorkflowId,
      createdAt: new Date(now.getTime() + 2_000), updatedAt: new Date(now.getTime() + 2_000),
    };
    const badVersion = {
      ...version, id: 'aaaaaaaa-bbbb-cccc-dddd-000000000098', workflowId: badWorkflowId,
      canonicalPayload: { ...payload, filter: { sources: [], fromContains: [], keywords: [], domains: [] } },
      contentHash: 'f'.repeat(64), createdAt: new Date(now.getTime() + 2_000),
    };
    const badProposal = {
      ...proposal, id: 'aaaaaaaa-bbbb-cccc-dddd-000000000097', workflowId: badWorkflowId,
      proposedVersionId: badVersion.id, createdAt: new Date(now.getTime() + 2_000),
    };
    const repository = {
      createDraftWithProposal: vi.fn(), createVersionWithProposal: vi.fn(), getForUser: vi.fn(),
      listForUser: vi.fn().mockResolvedValue([badWorkflow, workflow]), getVersionForUser: vi.fn(),
      listVersionsForUser: vi.fn(async (workflowId: string) =>
        workflowId === badWorkflowId ? [badVersion] : [version]),
      listProposalsForUser: vi.fn(async (workflowId: string) =>
        workflowId === badWorkflowId ? [badProposal] : [proposal]),
      listActivationEventsForUser: vi.fn().mockResolvedValue([]),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      signals: { listInWindowBounded: vi.fn().mockResolvedValue({
        records: [], totalCount: 0, truncated: false,
      }) },
      userLocales: { getLocale: vi.fn().mockResolvedValue({ language: 'en', timezone: 'UTC' }) },
      authoring: {
        probeReadiness: vi.fn(), authorSignalDigest: vi.fn(), reviseSignalDigest: vi.fn(),
        summarizeSignalDigestReplay: vi.fn().mockResolvedValue({
          available: false, text: 'AI summary unavailable',
        }),
      },
      now: () => now,
    });

    await expect(service.resumableDraft(USER_ID)).resolves.toMatchObject({
      workflow: { id: WORKFLOW_ID }, version: { id: VERSION_ID }, proposal: { id: PROPOSAL_ID },
    });
  });

  it('finds a pending proposal older than twenty workflows', async () => {
    const emptyWorkflows = Array.from({ length: 20 }, (_, index) => ({
      ...workflow,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      createdAt: new Date(now.getTime() + index + 1),
      updatedAt: new Date(now.getTime() + index + 1),
    }));
    const repository = {
      createDraftWithProposal: vi.fn(), createVersionWithProposal: vi.fn(), getForUser: vi.fn(),
      listForUser: vi.fn().mockResolvedValue([...emptyWorkflows, workflow]),
      getVersionForUser: vi.fn(),
      listVersionsForUser: vi.fn(async (workflowId: string) => workflowId === WORKFLOW_ID ? [version] : []),
      listProposalsForUser: vi.fn(async (workflowId: string) => workflowId === WORKFLOW_ID ? [proposal] : []),
      listActivationEventsForUser: vi.fn().mockResolvedValue([]),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      signals: { listInWindowBounded: vi.fn().mockResolvedValue({
        records: [], totalCount: 0, truncated: false,
      }) },
      userLocales: { getLocale: vi.fn().mockResolvedValue({ language: 'en', timezone: 'UTC' }) },
      authoring: {
        probeReadiness: vi.fn(), authorSignalDigest: vi.fn(), reviseSignalDigest: vi.fn(),
        summarizeSignalDigestReplay: vi.fn().mockResolvedValue({
          available: false, text: 'AI summary unavailable',
        }),
      },
      now: () => now,
    });

    await expect(service.resumableDraft(USER_ID)).resolves.toMatchObject({
      workflow: { id: WORKFLOW_ID }, proposal: { id: PROPOSAL_ID },
    });
  });

  it('rejects a no-op rollback as a typed transition without repository writes', async () => {
    const projectionRepository = { materializeVersion: vi.fn() };
    const service = createAdaptiveWorkflowService({ projectionRepository });
    await expect(service.rollbackWorkflowVersion({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      versionId: VERSION_ID,
      expectedActiveVersionId: VERSION_ID,
    })).resolves.toEqual({ success: false, reason: 'not_previously_active' });
    expect(projectionRepository.materializeVersion).not.toHaveBeenCalled();
  });

  it('persists the canonical summary instruction and strips it only from the Watch projection', async () => {
    const authoring = {
      probeReadiness: vi.fn(),
      reviseSignalDigest: vi.fn(),
      summarizeSignalDigestReplay: vi.fn().mockResolvedValue({
        available: false,
        text: 'AI summary unavailable',
      }),
      authorSignalDigest: vi.fn().mockResolvedValue({
        success: true,
        readiness: 'ready',
        intent: {
          schemaVersion: 1,
          intent: 'signal_digest',
          name: payload.name,
          cadence: payload.cadence,
          hourOfDay: payload.hourOfDay,
          dayOfWeek: null,
          filter: payload.filter,
          summaryInstruction: 'Summarize matching invoices with totals.',
        },
        inference: {
          provider: 'embedded', model: 'managed', reasoningMode: 'on_device',
          runtimeVersion: 'llama.cpp-b5000', modelArtifactSha256: '5'.repeat(64),
          prompt: { name: 'workflow-authoring-signal-digest', version: 1, sha256: '1'.repeat(64) },
          schema: { name: 'signal-digest-intent', version: 1, sha256: '2'.repeat(64) },
          inputSha256: '3'.repeat(64), outputSha256: '4'.repeat(64), repairCount: 0, latencyMs: 10,
        },
      }),
    };
    const repository = {
      createDraftWithProposal: vi.fn().mockResolvedValue({ workflow, version, proposal }),
      createVersionWithProposal: vi.fn(),
      getForUser: vi.fn(), listForUser: vi.fn(), getVersionForUser: vi.fn(),
      listVersionsForUser: vi.fn(), listProposalsForUser: vi.fn(),
      listActivationEventsForUser: vi.fn(), activateVersion: vi.fn(), rollbackVersion: vi.fn(),
    };
    const signals = {
      listInWindowBounded: vi.fn().mockResolvedValue({
        records: [{
          id: 'signal-1',
          source: 'gmail',
          timestamp: new Date('2026-09-16T11:00:00.000Z'),
          data: { subject: 'Invoice 42', from: 'billing@example.com' },
        }],
        totalCount: 1,
        truncated: false,
      }),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      authoring,
      signals,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
    });

    const result = await service.authorSignalDigestDraft({
      userId: USER_ID,
      description: 'Every morning summarize Gmail invoices.',
    });

    expect(result).toMatchObject({
      success: true,
      preview: {
        summaryInstruction: 'Summarize matching invoices with totals.',
        summaryInstructionPersisted: true,
        replay: {
          sourceReady: true,
          sourceReadyBasis: 'recent_signal_evidence',
          dataAccess: { kind: 'real_signals', status: 'available', synthetic: false },
          window: {
            start: '2026-09-09T12:00:00.000Z',
            end: '2026-09-16T12:00:00.000Z',
            lookbackHours: 168,
            bounds: '(start,end]',
          },
          simulation: { totalCount: 1, caughtCount: 1, ignoredCount: 0 },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
    });
    expect(repository.createDraftWithProposal).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: expect.objectContaining({
        action: 'digest',
        cadence: 'daily',
        summaryInstruction: 'Summarize matching invoices with totals.',
      }),
      authoring: { version: 1, source: 'llm_assisted', sourceReferences: [] },
      inference: expect.objectContaining({
        reasoningMode: 'on_device',
        runtimeVersion: 'llama.cpp-b5000',
        modelArtifactSha256: '5'.repeat(64),
        requestSha256: '3'.repeat(64),
        responseSha256: '4'.repeat(64),
      }),
      kind: 'initial',
    }));
    const persisted = repository.createDraftWithProposal.mock.calls[0]?.[0];
    expect(persisted.payload.summaryInstruction).toBe('Summarize matching invoices with totals.');
    if (!result.success) throw new Error('draft creation must succeed');
    expect(result.preview.routineSpec).not.toHaveProperty('summaryInstruction');
    expect(signals.listInWindowBounded).toHaveBeenCalledWith(
      USER_ID,
      new Date('2026-09-09T12:00:00.000Z'),
      new Date('2026-09-16T12:00:00.000Z'),
      2_000,
    );
  });

  it('creates an immutable revision with authoritative diff and one shared real-data replay window', async () => {
    const activeWorkflow = { ...workflow, activeVersionId: VERSION_ID };
    const authoring = {
      probeReadiness: vi.fn(),
      authorSignalDigest: vi.fn(),
      reviseSignalDigest: vi.fn(),
      summarizeSignalDigestReplay: vi.fn().mockResolvedValue({
        available: false,
        text: 'AI summary unavailable',
      }),
    };
    const repository = {
      createDraftWithProposal: vi.fn(),
      createVersionWithProposal: vi.fn().mockResolvedValue({
        success: true,
        version: revisionVersion,
        proposal: revisionProposal,
      }),
      getForUser: vi.fn().mockResolvedValue(activeWorkflow),
      listForUser: vi.fn(),
      getVersionForUser: vi.fn().mockResolvedValue(version),
      listVersionsForUser: vi.fn(),
      listProposalsForUser: vi.fn(),
      listActivationEventsForUser: vi.fn(),
      activateVersion: vi.fn(),
      rollbackVersion: vi.fn(),
    };
    const signals = {
      listInWindowBounded: vi.fn().mockResolvedValue({
        records: [{
          id: 'signal-invoice', source: 'gmail', timestamp: new Date('2026-09-16T11:00:00.000Z'),
          data: { subject: 'Invoice 42', from: 'billing@example.com' },
        },
        {
          id: 'signal-receipt', source: 'gmail', timestamp: new Date('2026-09-16T10:00:00.000Z'),
          data: { subject: 'Receipt 99', from: 'store@example.com' },
        }],
        totalCount: 2_500,
        truncated: true,
      }),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      authoring,
      signals,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
    });

    const result = await service.createRevision({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      parentVersionId: VERSION_ID,
      payload: revisionPayload,
    });

    expect(result).toMatchObject({
      success: true,
      workflow: { activeVersionId: VERSION_ID },
      version: { id: REVISION_VERSION_ID, parentVersionId: VERSION_ID },
      proposal: { proposedVersionId: REVISION_VERSION_ID, baseVersionId: VERSION_ID },
      diff: { authorityRelevantBroadening: true, requiresExplicitApproval: true },
      replay: {
        before: {
          dataAccess: { recordsFound: 2_500, recordsEvaluated: 2, truncated: true },
          simulation: { caughtCount: 1, totalCount: 2 },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
        after: {
          dataAccess: { recordsFound: 2_500, recordsEvaluated: 2, truncated: true },
          simulation: { caughtCount: 2, totalCount: 2 },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
      activePointerMoved: false,
    });
    expect(signals.listInWindowBounded).toHaveBeenCalledTimes(1);
    expect(repository.createVersionWithProposal).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      parentVersionId: VERSION_ID,
      payload: expect.objectContaining({
        summaryInstruction: revisionPayload.summaryInstruction,
        filter: expect.objectContaining({ keywords: ['invoice', 'receipt'] }),
      }),
      authoring: { version: 1, source: 'user', sourceReferences: [] },
      inference: null,
      kind: 'edit',
    }));
    expect(repository.activateVersion).not.toHaveBeenCalled();
    expect(repository.rollbackVersion).not.toHaveBeenCalled();
  });

  it('uses atomic initial draft/proposal persistence and degrades replay when signals are unavailable', async () => {
    const authoring = {
      probeReadiness: vi.fn(),
      reviseSignalDigest: vi.fn(),
      summarizeSignalDigestReplay: vi.fn().mockResolvedValue({
        available: false,
        text: 'AI summary unavailable',
      }),
      authorSignalDigest: vi.fn().mockResolvedValue({
        success: true,
        readiness: 'ready',
        intent: {
          schemaVersion: 1,
          intent: 'signal_digest',
          name: payload.name,
          cadence: payload.cadence,
          hourOfDay: payload.hourOfDay,
          dayOfWeek: null,
          filter: payload.filter,
          summaryInstruction: payload.summaryInstruction,
        },
        inference: {
          provider: 'embedded', model: 'managed', reasoningMode: 'on_device',
          runtimeVersion: 'llama.cpp-b5000', modelArtifactSha256: '5'.repeat(64),
          prompt: { name: 'workflow-authoring-signal-digest', version: 1, sha256: '1'.repeat(64) },
          schema: { name: 'signal-digest-intent', version: 1, sha256: '2'.repeat(64) },
          inputSha256: '3'.repeat(64), outputSha256: '4'.repeat(64), repairCount: 0, latencyMs: 10,
        },
      }),
    };
    const repository = {
      createDraftWithProposal: vi.fn().mockResolvedValue({ workflow, version, proposal }),
      createVersionWithProposal: vi.fn(),
      getForUser: vi.fn(), listForUser: vi.fn(), getVersionForUser: vi.fn(),
      listVersionsForUser: vi.fn(),
      listProposalsForUser: vi.fn(),
      listActivationEventsForUser: vi.fn(), activateVersion: vi.fn(), rollbackVersion: vi.fn(),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      authoring,
      signals: {
        listInWindowBounded: vi.fn().mockRejectedValue(new Error('signal store unavailable')),
      },
    });

    await expect(service.authorSignalDigestDraft({
      userId: USER_ID,
      description: 'Every morning summarize Gmail invoices.',
    })).resolves.toMatchObject({
      success: true,
      proposal: { id: PROPOSAL_ID },
      preview: {
        replay: {
          sourceReady: false,
          dataAccess: {
            kind: 'real_signals',
            status: 'unavailable',
            synthetic: false,
            recordsFound: 0,
            recordsEvaluated: 0,
            truncated: false,
          },
          simulation: null,
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
    });
    expect(repository.createDraftWithProposal).toHaveBeenCalledTimes(1);
    expect(repository.createVersionWithProposal).not.toHaveBeenCalled();
    expect(repository.listProposalsForUser).not.toHaveBeenCalled();
  });

  it('atomically materializes the compiled version into Watch activation with the user timezone', async () => {
    const repository = {
      createDraftWithProposal: vi.fn(), createVersionWithProposal: vi.fn(),
      getForUser: vi.fn().mockResolvedValue(workflow),
      listForUser: vi.fn(),
      getVersionForUser: vi.fn().mockResolvedValue(version),
      listVersionsForUser: vi.fn(), listProposalsForUser: vi.fn(),
      listActivationEventsForUser: vi.fn(),
    };
    const projectionRepository = {
      materializeVersion: vi.fn().mockResolvedValue({
        success: true,
        workflow: { ...workflow, activeVersionId: VERSION_ID },
        event,
        watchId: 'aaaaaaaa-bbbb-cccc-dddd-000000000009',
      }),
    };
    const service = createAdaptiveWorkflowService({
      repository,
      projectionRepository,
      userLocales: { getLocale: vi.fn().mockResolvedValue({ language: 'en', timezone: 'UTC' }) },
      now: () => new Date('2026-09-16T12:00:00.000Z'),
    });

    const result = await service.activate({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      versionId: VERSION_ID,
      proposalId: PROPOSAL_ID,
      expectedActiveVersionId: null,
    });

    expect(result).toMatchObject({
      success: true,
      workflow: { activeVersionId: VERSION_ID },
      preview: {
        watchProjection: {
          state: 'materialized',
          watchId: 'aaaaaaaa-bbbb-cccc-dddd-000000000009',
          nextRunAt: '2026-09-17T09:00:00.000Z',
          timezone: 'UTC',
        },
      },
    });
    expect(projectionRepository.materializeVersion).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      workflowId: WORKFLOW_ID,
      versionId: VERSION_ID,
      proposalId: PROPOSAL_ID,
      expectedActiveVersionId: null,
      kind: 'activate',
      sourceText: routineSpec.name,
      nextRunAt: new Date('2026-09-17T09:00:00.000Z'),
    }));
  });
});
