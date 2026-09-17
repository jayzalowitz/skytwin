import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, withTransactionMock, clientQueryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
  clientQueryMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

const { workflowRepository } = await import('../repositories/workflow-repository.js');

const now = new Date('2026-09-16T12:00:00.000Z');
const userId = '10000000-0000-4000-8000-000000000001';
const workflowId = '20000000-0000-4000-8000-000000000001';
const parentVersionId = '30000000-0000-4000-8000-000000000001';
const targetVersionId = '30000000-0000-4000-8000-000000000002';

const workflowRow = {
  id: workflowId,
  user_id: userId,
  provider_key: 'signal_digest',
  active_version_id: parentVersionId,
  created_at: now,
  updated_at: now,
};

const authoring = {
  version: 1 as const,
  source: 'user' as const,
  sourceReferences: [{ kind: 'message' as const, id: 'message-1' }],
};

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  withTransactionMock.mockReset().mockImplementation(
    async (callback: (client: { query: typeof clientQueryMock }) => Promise<unknown>) =>
      callback({ query: clientQueryMock }),
  );
});

describe('workflowRepository', () => {
  it('creates an inactive workflow and immutable version 1 with canonical content', async () => {
    const draftWorkflow = { ...workflowRow, active_version_id: null };
    clientQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO workflows')) {
        return { rows: [{ ...draftWorkflow, id: params[0] as string }] };
      }
      if (sql.includes('INSERT INTO workflow_versions')) {
        return { rows: [{
          id: params[0],
          workflow_id: params[1],
          user_id: params[2],
          version_number: params[3],
          provider_key: params[4],
          provider_schema_version: params[5],
          canonical_payload: JSON.parse(params[6] as string),
          content_hash: params[7],
          parent_version_id: params[8],
          authoring_metadata: JSON.parse(params[9] as string),
          inference_metadata: null,
          created_at: now,
        }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const created = await workflowRepository.createDraft({
      userId,
      providerKey: 'signal_digest',
      providerSchemaVersion: 'v1',
      payload: { z: 2, a: { y: true, x: false } },
      authoring,
    });

    expect(created.workflow.activeVersionId).toBeNull();
    expect(created.version.versionNumber).toBe(1);
    expect(created.version.parentVersionId).toBeNull();
    expect(JSON.stringify(created.version.canonicalPayload))
      .toBe('{"a":{"x":false,"y":true},"z":2}');
    expect(created.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates version 1 and its initial proposal atomically', async () => {
    const draftWorkflow = { ...workflowRow, active_version_id: null };
    clientQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO workflows')) {
        return { rows: [{ ...draftWorkflow, id: params[0] as string }] };
      }
      if (sql.includes('INSERT INTO workflow_versions')) return { rows: [{
        id: params[0], workflow_id: params[1], user_id: params[2], version_number: 1,
        provider_key: params[4], provider_schema_version: params[5],
        canonical_payload: JSON.parse(params[6] as string), content_hash: params[7],
        parent_version_id: null, authoring_metadata: JSON.parse(params[9] as string),
        inference_metadata: null, created_at: now,
      }] };
      if (sql.includes('INSERT INTO workflow_proposals')) return { rows: [{
        id: params[0], workflow_id: params[1], user_id: params[2],
        base_version_id: null, proposed_version_id: params[3], kind: params[4],
        created_at: now,
      }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const created = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: { keywords: ['invoice'] },
      authoring,
    });

    expect(created.workflow.activeVersionId).toBeNull();
    expect(created.version.versionNumber).toBe(1);
    expect(created.proposal).toMatchObject({
      workflowId: created.workflow.id,
      proposedVersionId: created.version.id,
      baseVersionId: null,
      kind: 'initial',
    });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('reuses stable workflow/version IDs across bounded serialization retries', async () => {
    const seenWorkflowIds: string[] = [];
    const seenVersionIds: string[] = [];
    let attempt = 0;
    withTransactionMock.mockImplementation(async (
      callback: (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => {
      attempt += 1;
      return callback({
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('INSERT INTO workflows')) {
            seenWorkflowIds.push(params[0] as string);
            return { rows: [{ ...workflowRow, id: params[0], active_version_id: null }] };
          }
          seenVersionIds.push(params[0] as string);
          if (attempt < 3) throw Object.assign(new Error('restart'), { code: '40001' });
          return { rows: [{
            id: params[0], workflow_id: params[1], user_id: params[2], version_number: 1,
            provider_key: params[4], provider_schema_version: params[5],
            canonical_payload: JSON.parse(params[6] as string), content_hash: params[7],
            parent_version_id: null, authoring_metadata: JSON.parse(params[9] as string),
            inference_metadata: null, created_at: now,
          }] };
        },
      });
    });

    await workflowRepository.createDraft({
      userId,
      providerKey: 'signal_digest',
      providerSchemaVersion: 'v1',
      payload: { keywords: ['invoice'] },
      authoring,
    });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
    expect(new Set(seenWorkflowIds).size).toBe(1);
    expect(new Set(seenVersionIds).size).toBe(1);
  });

  it('creates an active-lineage version and proposal in the same transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [workflowRow] })
      .mockResolvedValueOnce({ rows: [{ version_number: 1 }] })
      .mockResolvedValueOnce({ rows: [{ version_number: 2 }] })
      .mockImplementationOnce(async (_sql: string, params: unknown[]) => ({ rows: [{
        id: params[0], workflow_id: params[1], user_id: params[2], version_number: params[3],
        provider_key: params[4], provider_schema_version: params[5],
        canonical_payload: JSON.parse(params[6] as string), content_hash: params[7],
        parent_version_id: params[8], authoring_metadata: JSON.parse(params[9] as string),
        inference_metadata: null, created_at: now,
      }] }))
      .mockImplementationOnce(async (_sql: string, params: unknown[]) => ({ rows: [{
        id: params[0], workflow_id: params[1], user_id: params[2],
        base_version_id: params[3], proposed_version_id: params[4], kind: params[5],
        created_at: now,
      }] }));

    const result = await workflowRepository.createVersionWithProposal({
      userId,
      workflowId,
      parentVersionId,
      providerSchemaVersion: 'v1',
      payload: { keywords: ['urgent'] },
      authoring,
      kind: 'feedback',
    });

    expect(result).toMatchObject({
      success: true,
      version: { versionNumber: 2, parentVersionId },
      proposal: { baseVersionId: parentVersionId, kind: 'feedback' },
    });
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock.mock.calls[0]![0]).toContain('FOR UPDATE');
  });

  it('rejects a stale revision before inserting a version or proposal', async () => {
    clientQueryMock.mockResolvedValueOnce({
      rows: [{ ...workflowRow, active_version_id: targetVersionId }],
    });

    await expect(workflowRepository.createVersionWithProposal({
      userId,
      workflowId,
      parentVersionId,
      providerSchemaVersion: 'v1',
      payload: { keywords: ['urgent'] },
      authoring,
      kind: 'edit',
    })).resolves.toEqual({ success: false, reason: 'active_version_conflict' });
    expect(clientQueryMock).toHaveBeenCalledTimes(1);
  });

  it('keeps every read owner-scoped', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await workflowRepository.getForUser(workflowId, userId);
    await workflowRepository.getVersionForUser(targetVersionId, workflowId, userId);
    await workflowRepository.listVersionsForUser(workflowId, userId);
    await workflowRepository.listProposalsForUser(workflowId, userId);
    await workflowRepository.listActivationEventsForUser(workflowId, userId);
    for (const [sql, params] of queryMock.mock.calls) {
      expect(sql).toContain('user_id');
      expect(params).toContain(userId);
    }
  });
});
