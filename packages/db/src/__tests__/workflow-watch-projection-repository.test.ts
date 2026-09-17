import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileSignalDigestV1 } from '@skytwin/routines';

const { clientQueryMock, withTransactionMock } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  withTransaction: withTransactionMock,
}));

const { workflowWatchProjectionRepository } = await import(
  '../repositories/workflow-watch-projection-repository.js'
);

const userId = '10000000-0000-4000-8000-000000000001';
const workflowId = '20000000-0000-4000-8000-000000000001';
const versionId = '30000000-0000-4000-8000-000000000001';
const proposalId = '40000000-0000-4000-8000-000000000001';
const now = new Date('2026-09-16T16:00:00.000Z');
const canonicalPayload = {
  name: 'Morning invoice digest',
  cadence: 'daily',
  hourOfDay: 8,
  action: 'digest',
  filter: {
    sources: ['gmail'],
    fromContains: [],
    keywords: ['invoice'],
    domains: [],
  },
  summaryInstruction: 'Summarize matching invoices with source citations.',
};
const compilation = compileSignalDigestV1(canonicalPayload);
if (!compilation.ok) throw new Error('Test payload must compile');
const contentHash = compilation.artifact.contentHash;

function input() {
  return {
    userId,
    workflowId,
    versionId,
    expectedActiveVersionId: null,
    proposalId,
    kind: 'activate' as const,
    sourceText: 'Morning invoice digest',
    nextRunAt: new Date('2026-09-17T08:00:00.000Z'),
  };
}

beforeEach(() => {
  clientQueryMock.mockReset();
  withTransactionMock.mockReset().mockImplementation(
    async (callback: (client: { query: typeof clientQueryMock }) => Promise<unknown>) =>
      callback({ query: clientQueryMock }),
  );
});

describe('workflowWatchProjectionRepository', () => {
  it('rejects a no-op rollback before touching version or schedule state', async () => {
    clientQueryMock.mockResolvedValueOnce({ rows: [{
      id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
      active_version_id: versionId, active_activation_event_id: 'event',
      created_at: now, updated_at: now,
    }] });

    await expect(workflowWatchProjectionRepository.materializeVersion({
      ...input(),
      kind: 'rollback',
      proposalId: undefined,
      expectedActiveVersionId: versionId,
    })).resolves.toEqual({ success: false, reason: 'not_previously_active' });
    expect(clientQueryMock).toHaveBeenCalledTimes(1);
  });

  it('atomically creates the pinned Watch, moves the pointer, and appends activation', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{
        id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
        active_version_id: null, created_at: now, updated_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: versionId, provider_key: 'signal_digest.v1',
        provider_schema_version: '1', canonical_payload: canonicalPayload,
        content_hash: contentHash,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: proposalId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementationOnce(async (_sql: string, params: unknown[]) => ({ rows: [{
        id: params[0], workflow_id: workflowId, user_id: userId,
        event_sequence: '1',
        previous_version_id: null, activated_version_id: versionId,
        proposal_id: proposalId, kind: 'activate', created_at: now,
      }] }))
      .mockResolvedValueOnce({ rows: [{
        id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
        active_version_id: versionId, active_activation_event_id: 'event',
        created_at: now, updated_at: now,
      }] });

    await expect(workflowWatchProjectionRepository.materializeVersion(input()))
      .resolves.toMatchObject({
        success: true,
        workflow: { activeVersionId: versionId },
        event: { activatedVersionId: versionId },
      });

    const insertWatch = clientQueryMock.mock.calls[4]!;
    expect(clientQueryMock.mock.calls[2]![0]).toContain('NOT EXISTS');
    expect(clientQueryMock.mock.calls[2]![0]).toContain('consumed.proposal_id');
    expect(insertWatch[0]).toContain('INSERT INTO watches');
    expect(insertWatch[1]).toEqual(expect.arrayContaining([
      workflowId,
      versionId,
      'signal_digest.v1',
      '1',
      contentHash,
      1,
    ]));
    const insertEvent = clientQueryMock.mock.calls[5]!;
    expect(insertEvent[0]).toContain('INSERT INTO workflow_activation_events');
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed before materialization when compiled identity differs from the version', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{
        id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
        active_version_id: null, created_at: now, updated_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: versionId, provider_key: 'signal_digest.v1',
        provider_schema_version: '1', canonical_payload: canonicalPayload,
        content_hash: 'b'.repeat(64),
      }] });

    await expect(workflowWatchProjectionRepository.materializeVersion(input()))
      .resolves.toEqual({ success: false, reason: 'projection_mismatch' });
    expect(clientQueryMock).toHaveBeenCalledTimes(2);
  });

  it('returns the original transition when a committed paused projection response is retried', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{
        id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
        active_version_id: versionId,
        active_activation_event_id: '60000000-0000-4000-8000-000000000001',
        created_at: now, updated_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: versionId, provider_key: 'signal_digest.v1',
        provider_schema_version: '1', canonical_payload: canonicalPayload,
        content_hash: contentHash,
      }] })
      .mockResolvedValueOnce({ rows: [{
        watch_id: '50000000-0000-4000-8000-000000000001',
        event_id: '60000000-0000-4000-8000-000000000001',
        workflow_id: workflowId,
        user_id: userId,
        event_sequence: '1',
        previous_version_id: null,
        activated_version_id: versionId,
        proposal_id: proposalId,
        kind: 'activate',
        created_at: now,
      }] });

    await expect(workflowWatchProjectionRepository.materializeVersion(input()))
      .resolves.toMatchObject({
        success: true,
        workflow: { activeVersionId: versionId },
        event: { proposalId, activatedVersionId: versionId },
        watchId: '50000000-0000-4000-8000-000000000001',
      });
    expect(clientQueryMock).toHaveBeenCalledTimes(3);
    expect(clientQueryMock.mock.calls[2]![0]).not.toContain("w.status = 'active'");
    expect(clientQueryMock.mock.calls[2]![0]).toContain('e.id = $11');
    expect(clientQueryMock.mock.calls[2]![1][10])
      .toBe('60000000-0000-4000-8000-000000000001');
  });

  it('does not mistake an older matching transition for an idempotent retry', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{
        id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
        active_version_id: versionId,
        active_activation_event_id: '70000000-0000-4000-8000-000000000001',
        created_at: now, updated_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: versionId, provider_key: 'signal_digest.v1',
        provider_schema_version: '1', canonical_payload: canonicalPayload,
        content_hash: contentHash,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(workflowWatchProjectionRepository.materializeVersion(input()))
      .resolves.toEqual({ success: false, reason: 'active_version_conflict' });
    expect(clientQueryMock.mock.calls[2]![0]).toContain('e.id = $11');
  });

  it('keeps stable generated identities across Cockroach serialization retries', async () => {
    const eventIds: string[] = [];
    const watchIds: string[] = [];
    let attempt = 0;
    withTransactionMock.mockImplementation(async (
      callback: (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => {
      attempt += 1;
      return callback({
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('SELECT * FROM workflows')) return { rows: [{
            id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
            active_version_id: null, created_at: now, updated_at: now,
          }] };
          if (sql.includes('FROM workflow_versions')) return { rows: [{
            id: versionId, provider_key: 'signal_digest.v1',
            provider_schema_version: '1', canonical_payload: canonicalPayload,
            content_hash: contentHash,
          }] };
          if (sql.includes('FROM workflow_proposals')) return { rows: [{ id: proposalId }] };
          if (sql.includes('SELECT id FROM watches')) return { rows: [] };
          if (sql.includes('INSERT INTO watches')) {
            watchIds.push(params[0] as string);
            return { rows: [] };
          }
          if (sql.includes('UPDATE workflows')) return { rows: [{
            id: workflowId, user_id: userId, provider_key: 'signal_digest.v1',
            active_version_id: versionId, created_at: now, updated_at: now,
          }] };
          if (sql.includes('INSERT INTO workflow_activation_events')) {
            eventIds.push(params[0] as string);
            if (attempt === 1) throw Object.assign(new Error('restart'), { code: '40001' });
            return { rows: [{
              id: params[0], workflow_id: workflowId, user_id: userId,
              event_sequence: '1',
              previous_version_id: null, activated_version_id: versionId,
              proposal_id: proposalId, kind: 'activate', created_at: now,
            }] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      });
    });

    await expect(workflowWatchProjectionRepository.materializeVersion(input()))
      .resolves.toMatchObject({ success: true });
    expect(withTransactionMock).toHaveBeenCalledTimes(2);
    expect(new Set(eventIds).size).toBe(1);
    expect(new Set(watchIds).size).toBe(1);
  });
});
