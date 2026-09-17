import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signalDigestV1ContentHash } from '@skytwin/routines';

const { withTransactionMock, clientQueryMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  clientQueryMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({ withTransaction: withTransactionMock }));

const {
  LEGACY_WATCH_SUMMARY_INSTRUCTION,
  legacyWatchWorkflowReconciliationRepository,
} = await import('../repositories/legacy-watch-workflow-reconciliation-repository.js');

const now = new Date('2026-09-16T12:00:00.000Z');
const userId = '10000000-0000-4000-8000-000000000001';
const watchId = '20000000-0000-4000-8000-000000000001';

function legacyWatch(status: 'active' | 'draft' | 'paused' = 'active') {
  return {
    id: watchId,
    user_id: userId,
    name: '  Invoice   Digest ',
    source_text: 'invoice mail',
    cadence: 'daily',
    hour_of_day: 9,
    day_of_week: null,
    filter: {
      sources: [' Gmail ', 'gmail'],
      fromContains: [],
      keywords: [' Invoice '],
      domains: [],
    },
    action: 'digest',
    status,
    next_run_at: new Date('2026-09-17T09:00:00.000Z'),
    timezone: 'UTC',
  };
}

beforeEach(() => {
  clientQueryMock.mockReset();
  withTransactionMock.mockReset().mockImplementation(
    async (callback: (client: { query: typeof clientQueryMock }) => Promise<unknown>) =>
      callback({ query: clientQueryMock }),
  );
});

describe('legacyWatchWorkflowReconciliationRepository', () => {
  it('atomically migrates an active legacy Watch and leaves historical runs unattributed', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM watches') && sql.includes('workflow_id IS NULL')) {
        return { rows: [legacyWatch()] };
      }
      if (sql.includes('UPDATE workflows')) return { rows: [{ id: 'workflow' }] };
      if (sql.includes('UPDATE watches')) return { rows: [{ id: watchId }] };
      return { rows: [] };
    });

    const result = await legacyWatchWorkflowReconciliationRepository.reconcileBatch({
      limit: 1,
      now,
    });

    expect(result).toEqual({
      legacyWatchesMigrated: 1,
      activeWorkflowProjectionsMaterialized: 0,
      mayHaveMore: true,
    });
    const versionCall = clientQueryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('INSERT INTO workflow_versions'))!;
    const payload = JSON.parse(versionCall[1][5] as string);
    expect(payload).toEqual({
      action: 'digest',
      cadence: 'daily' as const,
      filter: { domains: [], fromContains: [], keywords: ['invoice'], sources: ['gmail'] },
      hourOfDay: 9,
      name: 'Invoice Digest',
      summaryInstruction: LEGACY_WATCH_SUMMARY_INSTRUCTION,
      timezone: 'UTC',
    });
    expect(versionCall[1][6]).toBe(signalDigestV1ContentHash(payload));
    expect(JSON.parse(versionCall[1][7] as string)).toEqual({
      version: 1,
      source: 'migration',
      sourceReferences: [{ kind: 'watch', id: watchId }],
    });
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      (sql as string).includes('INSERT INTO workflow_activation_events'))).toBe(true);
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      (sql as string).includes('watch_runs'))).toBe(false);
    const pinCall = clientQueryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('UPDATE watches'))!;
    expect(pinCall[0]).toContain('user_id = $2');
    expect(pinCall[0]).toContain('workflow_id IS NULL');
    expect(pinCall[1].slice(10, 14)).toEqual([
      'signal_digest.v1', '1', versionCall[1][6], 1,
    ]);
  });

  it('durably quarantines an invalid legacy Watch and continues to the next valid row', async () => {
    let legacyClaim = 0;
    clientQueryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM workflows AS wf')) return { rows: [] };
      if (sql.includes('FROM watches') && sql.includes('workflow_id IS NULL')) {
        legacyClaim += 1;
        return { rows: [{
          ...legacyWatch(),
          id: legacyClaim === 1 ? watchId : '20000000-0000-4000-8000-000000000002',
          name: legacyClaim === 1 ? 'Unsafe\u0000name' : 'Valid digest',
        }] };
      }
      if (sql.includes('UPDATE workflows') || sql.includes('UPDATE watches')) {
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [] };
    });

    const result = await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 2, now });
    expect(result.legacyWatchesMigrated).toBe(2);
    const workflowInserts = clientQueryMock.mock.calls.filter(([sql]) =>
      (sql as string).includes('INSERT INTO workflows'));
    expect(workflowInserts.map((call) => call[1][2])).toEqual([
      'legacy_watch.quarantine.v1', 'signal_digest.v1',
    ]);
    const versionInserts = clientQueryMock.mock.calls.filter(([sql]) =>
      (sql as string).includes('INSERT INTO workflow_versions'));
    expect(JSON.parse(versionInserts[0]![1][5] as string)).toMatchObject({
      kind: 'legacy_watch_quarantine.v1',
      reasonCode: 'invalid_signal_digest_payload',
      sourceWatchId: watchId,
      originalStatus: 'active',
    });
    const quarantineUpdate = clientQueryMock.mock.calls.find(([sql]) =>
      (sql as string).includes("status = CASE WHEN status = 'active' THEN 'paused'"))!;
    expect(quarantineUpdate[0]).toContain('schedule_revision');
    expect(clientQueryMock.mock.calls.filter(([sql]) =>
      (sql as string).includes('workflow_activation_events'))).toHaveLength(1);
  });

  it('clears a stale schedule when quarantining an already-paused invalid Watch', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM watches') && sql.includes('workflow_id IS NULL')) {
        return { rows: [{ ...legacyWatch('paused'), name: 'Unsafe\u0000name' }] };
      }
      if (sql.includes('UPDATE watches')) return { rows: [{ id: watchId }] };
      return { rows: [] };
    });

    await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 1, now });

    const quarantineUpdate = clientQueryMock.mock.calls.find(([sql]) =>
      (sql as string).includes("status = CASE WHEN status = 'active' THEN 'paused'"))!;
    expect(quarantineUpdate[0]).toContain('next_run_at = NULL');
    expect(quarantineUpdate[0]).toContain("status = 'active' OR next_run_at IS NOT NULL");
  });

  it('selects the migrated version while preserving draft scheduling state', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM watches') && sql.includes('workflow_id IS NULL')) {
        return { rows: [legacyWatch('draft')] };
      }
      if (sql.includes('UPDATE workflows')) return { rows: [{ id: 'workflow' }] };
      if (sql.includes('UPDATE watches')) return { rows: [{ id: watchId }] };
      return { rows: [] };
    });

    await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 1, now });

    expect(clientQueryMock.mock.calls.some(([sql]) =>
      (sql as string).includes('SET active_version_id'))).toBe(true);
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      (sql as string).includes('workflow_activation_events'))).toBe(true);
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      (sql as string).includes('workflow_proposals'))).toBe(true);
    const projectionUpdate = clientQueryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('SET name = $3'))!;
    expect(projectionUpdate[0]).toContain(
      "next_run_at = CASE WHEN status = 'active' THEN next_run_at ELSE NULL END",
    );
    expect(projectionUpdate[0]).toContain(
      "status <> 'active' AND next_run_at IS NOT NULL",
    );
  });

  it('derives a missing weekly weekday in the user timezone rather than UTC', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM watches') && sql.includes('workflow_id IS NULL')) {
        return { rows: [{
          ...legacyWatch(),
          cadence: 'weekly',
          day_of_week: null,
          timezone: 'Asia/Tokyo',
          // Sunday 08:00 in Tokyo, but Saturday in UTC.
          next_run_at: new Date('2026-09-19T23:00:00.000Z'),
        }] };
      }
      if (sql.includes('UPDATE workflows') || sql.includes('UPDATE watches')) {
        return { rows: [{ id: watchId }] };
      }
      return { rows: [] };
    });

    await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 1, now });
    const versionCall = clientQueryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('INSERT INTO workflow_versions'))!;
    expect(JSON.parse(versionCall[1][5] as string).dayOfWeek).toBe(0);
  });

  it('reuses generated identities across Cockroach serialization retries', async () => {
    const workflowIds: string[] = [];
    let workflowInsertAttempt = 0;
    withTransactionMock.mockImplementation(async (
      callback: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => {
      return callback({
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM workflows AS wf')) return { rows: [] };
          if (sql.includes('FROM watches')) return { rows: [legacyWatch()] };
          if (sql.includes('INSERT INTO workflows')) {
            workflowInsertAttempt += 1;
            workflowIds.push(params[0] as string);
            if (workflowInsertAttempt === 1) throw Object.assign(new Error('restart'), { code: '40001' });
          }
          if (sql.includes('UPDATE workflows') || sql.includes('UPDATE watches')) {
            return { rows: [{ id: params[0] }] };
          }
          return { rows: [] };
        },
      });
    });

    await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 1, now });
    expect(withTransactionMock).toHaveBeenCalledTimes(3);
    expect(new Set(workflowIds).size).toBe(1);
  });

  it('strictly materializes a missing projection for a restored active workflow', async () => {
    const payload = {
      name: 'Security digest',
      cadence: 'daily' as const,
      hourOfDay: 9,
      action: 'notify' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: [], domains: ['security'] },
      summaryInstruction: 'Summarize security signals with citations.',
    };
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    withTransactionMock.mockImplementation(async (
      callback: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => {
      return callback({
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes('FROM workflows AS wf')) return { rows: [{
            workflow_id: '30000000-0000-4000-8000-000000000001',
            user_id: userId,
            version_id: '40000000-0000-4000-8000-000000000001',
            provider_key: 'signal_digest.v1',
            provider_schema_version: '1',
            canonical_payload: payload,
            content_hash: signalDigestV1ContentHash(payload),
            timezone: 'America/Los_Angeles',
          }] };
          if (sql.includes('SELECT id FROM workflows')) return { rows: [{ id: 'workflow' }] };
          return { rows: [] };
        },
      });
    });

    const result = await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 1, now });
    expect(result.activeWorkflowProjectionsMaterialized).toBe(1);
    const insert = calls.find(({ sql }) => sql.includes('INSERT INTO watches'))!;
    expect(insert.params[9]).toEqual(new Date('2026-09-16T16:00:00.000Z'));
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('quarantines unsupported and invalid restored versions without starving a later valid one', async () => {
    const payload = {
      name: 'Security digest', cadence: 'hourly' as const, action: 'notify' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: [], domains: [] },
      summaryInstruction: 'Summarize matching signals.',
    };
    let candidate = 0;
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    withTransactionMock.mockImplementation(async (
      callback: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => {
      return callback({ query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM workflows AS wf')) {
          candidate += 1;
          const providerSchemaVersion = candidate === 1 ? '2' : '1';
          const contentHash = candidate === 2
            ? '0'.repeat(64)
            : signalDigestV1ContentHash(payload);
          return { rows: [{
            workflow_id: `30000000-0000-4000-8000-00000000000${candidate}`,
            user_id: userId,
            version_id: `40000000-0000-4000-8000-00000000000${candidate}`,
            provider_key: 'signal_digest.v1', provider_schema_version: providerSchemaVersion,
            canonical_payload: payload, content_hash: contentHash,
            timezone: 'UTC',
          }] };
        }
        if (sql.includes('SELECT id FROM workflows')) return { rows: [{ id: 'workflow' }] };
        return { rows: [] };
      } });
    });

    await expect(legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 3, now }))
      .resolves.toMatchObject({ activeWorkflowProjectionsMaterialized: 3 });
    const inserts = calls.filter(({ sql }) => sql.includes('INSERT INTO watches'));
    expect(inserts).toHaveLength(3);
    expect(inserts[0]!.sql).toContain("'paused'");
    expect(inserts[0]!.params[2]).toContain('unsupported_provider_schema:2');
    expect(inserts[1]!.params[2]).toContain('content_hash_mismatch');
    expect(inserts[2]!.sql).toContain("'active'");
  });

  it('is a no-op when a previous reconciliation left no unlinked work', async () => {
    clientQueryMock.mockResolvedValue({ rows: [] });
    await expect(legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 5, now }))
      .resolves.toEqual({
        legacyWatchesMigrated: 0,
        activeWorkflowProjectionsMaterialized: 0,
        mayHaveMore: false,
      });
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      (sql as string).startsWith('INSERT'))).toBe(false);
  });
});
