import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cockroachAvailable =
  spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

async function reservePorts(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  })));
  const ports = servers.map((server) => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to reserve port');
    return address.port;
  }) as [number, number];
  await Promise.all(servers.map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
  return ports;
}

async function waitForSql(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('CockroachDB did not become ready');
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe.runIf(cockroachAvailable)('workflowRepository on live CockroachDB', () => {
  let child: ChildProcess;
  let dataRoot: string;
  let databaseUrl: string;
  let closePool: () => Promise<void>;
  let getPool: typeof import('../connection.js')['getPool'];
  let workflowRepository: typeof import('../repositories/workflow-repository.js')['workflowRepository'];
  let watchRepository: typeof import('../repositories/watch-repository.js')['watchRepository'];
  let workflowWatchProjectionRepository: typeof import('../repositories/workflow-watch-projection-repository.js')['workflowWatchProjectionRepository'];
  let legacyWatchWorkflowReconciliationRepository: typeof import('../repositories/legacy-watch-workflow-reconciliation-repository.js')['legacyWatchWorkflowReconciliationRepository'];

  beforeAll(async () => {
    const [sqlPort, httpPort] = await reservePorts();
    dataRoot = mkdtempSync(join(tmpdir(), 'skytwin-workflow-repository-'));
    databaseUrl = `postgresql://root@127.0.0.1:${sqlPort}/defaultdb?sslmode=disable`;
    child = spawn('cockroach', [
      'start-single-node', '--insecure', `--listen-addr=127.0.0.1:${sqlPort}`,
      `--http-addr=127.0.0.1:${httpPort}`, `--store=${join(dataRoot, 'store')}`,
      `--log-dir=${join(dataRoot, 'logs')}`,
    ], { stdio: 'ignore' });
    await waitForSql(databaseUrl);

    const setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query('CREATE TABLE users (id UUID PRIMARY KEY, timezone STRING)');
    await setup.query(
      `INSERT INTO users VALUES ('10000000-0000-4000-8000-000000000001')`,
    );
    const { splitSqlStatements } = await import('../migrations/001-initial.js');
    for (const filename of [
      '069-watches.sql',
      '070-watch-runs.sql',
      '089-watch-scheduled-slots.sql',
      '095-adaptive-workflow-foundation.sql',
      '096-watch-workflow-version-pins.sql',
      '097-workflow-proposal-idempotency.sql',
    ]) {
      const migration = readFileSync(
        new URL(`../migrations/${filename}`, import.meta.url),
        'utf8',
      );
      for (const statement of splitSqlStatements(migration)) await setup.query(statement);
    }
    await setup.end();

    process.env['DATABASE_URL'] = databaseUrl;
    const connection = await import('../connection.js');
    closePool = connection.closePool;
    getPool = connection.getPool;
    ({ workflowRepository } = await import('../repositories/workflow-repository.js'));
    ({ watchRepository } = await import('../repositories/watch-repository.js'));
    ({ workflowWatchProjectionRepository } = await import(
      '../repositories/workflow-watch-projection-repository.js'
    ));
    ({ legacyWatchWorkflowReconciliationRepository } = await import(
      '../repositories/legacy-watch-workflow-reconciliation-repository.js'
    ));
  }, 120_000);

  afterAll(async () => {
    await closePool?.();
    delete process.env['DATABASE_URL'];
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      if (!(await waitForExit(child, 30_000))) {
        child.kill('SIGKILL');
        await waitForExit(child, 5_000);
      }
    }
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  }, 35_000);

  it('returns one durable draft for concurrent retries with the same idempotency key', async () => {
    const idempotencyKey = '40000000-0000-4000-8000-000000000097';
    const input = {
      userId: '10000000-0000-4000-8000-000000000001',
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: {
        name: 'Concurrent invoice digest', cadence: 'daily' as const,
        hourOfDay: 9, timezone: 'UTC', action: 'digest' as const,
        filter: { sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [] },
        summaryInstruction: 'Summarize concurrent invoice matches.',
      },
      authoring: {
        version: 1 as const,
        source: 'user' as const,
        sourceReferences: [],
      },
      kind: 'initial' as const,
      idempotencyKey,
      requestFingerprint: 'same concurrent request',
    };

    const [left, right] = await Promise.all([
      workflowRepository.createDraftWithProposal(input),
      workflowRepository.createDraftWithProposal(input),
    ]);

    expect(right).toMatchObject({
      workflow: { id: left.workflow.id },
      version: { id: left.version.id },
      proposal: { id: left.proposal.id },
    });
    const persisted = await getPool().query<{ proposals: string; workflows: string; versions: string }>(
      `SELECT
         count(*)::STRING AS proposals,
         count(DISTINCT workflow_id)::STRING AS workflows,
         count(DISTINCT proposed_version_id)::STRING AS versions
       FROM workflow_proposals
       WHERE user_id = $1 AND idempotency_key = $2`,
      [input.userId, idempotencyKey],
    );
    expect(persisted.rows[0]).toEqual({ proposals: '1', workflows: '1', versions: '1' });
  });

  it('admits one concurrent activation, audits it once, and rolls back to an activated version', async () => {
    const authoring = {
      version: 1 as const,
      source: 'user' as const,
      sourceReferences: [{ kind: 'message' as const, id: 'message-1' }],
    };
    const firstPayload = {
      name: 'Invoice digest', cadence: 'daily' as const, hourOfDay: 9, action: 'digest' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [] },
      summaryInstruction: 'Summarize invoices with citations.',
    };
    const draft = await workflowRepository.createDraftWithProposal({
      userId: '10000000-0000-4000-8000-000000000001',
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: firstPayload,
      authoring,
    });
    const initialActivation = await workflowWatchProjectionRepository.materializeVersion({
      userId: draft.workflow.userId,
      workflowId: draft.workflow.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      proposalId: draft.proposal.id,
      kind: 'activate',
      sourceText: firstPayload.name,
      nextRunAt: new Date('2026-09-17T09:00:00.000Z'),
    });
    expect(initialActivation.success).toBe(true);

    const second = await workflowRepository.createVersionWithProposal({
      userId: draft.workflow.userId,
      workflowId: draft.workflow.id,
      parentVersionId: draft.version.id,
      providerSchemaVersion: '1',
      payload: { ...firstPayload, filter: { ...firstPayload.filter, keywords: ['invoice', 'urgent'] } },
      authoring,
      kind: 'edit',
    });
    const third = await workflowRepository.createVersionWithProposal({
      userId: draft.workflow.userId,
      workflowId: draft.workflow.id,
      parentVersionId: draft.version.id,
      providerSchemaVersion: '1',
      payload: { ...firstPayload, filter: { ...firstPayload.filter, domains: ['example.com'] } },
      authoring,
      kind: 'edit',
    });
    expect(second.success).toBe(true);
    expect(third.success).toBe(true);
    if (!second.success || !third.success) throw new Error('version creation failed');
    const competing = await Promise.all([
      workflowWatchProjectionRepository.materializeVersion({
        userId: draft.workflow.userId,
        workflowId: draft.workflow.id,
        versionId: second.version.id,
        expectedActiveVersionId: draft.version.id,
        proposalId: second.proposal.id,
        kind: 'activate',
        sourceText: 'Urgent invoice digest',
        nextRunAt: new Date('2026-09-17T10:00:00.000Z'),
      }),
      workflowWatchProjectionRepository.materializeVersion({
        userId: draft.workflow.userId,
        workflowId: draft.workflow.id,
        versionId: third.version.id,
        expectedActiveVersionId: draft.version.id,
        proposalId: third.proposal.id,
        kind: 'activate',
        sourceText: 'Example.com invoice digest',
        nextRunAt: new Date('2026-09-17T11:00:00.000Z'),
      }),
    ]);
    expect(competing.filter((result) => result.success)).toHaveLength(1);
    expect(competing.filter((result) => !result.success)).toEqual([
      { success: false, reason: 'active_version_conflict' },
    ]);
    const winner = competing.find((result) => result.success);
    if (!winner?.success) throw new Error('activation winner missing');

    const paused = await watchRepository.setStatus(
      winner.watchId,
      draft.workflow.userId,
      'paused',
    );
    expect(paused).toMatchObject({ status: 'paused', nextRunAt: null });

    const rollback = await workflowWatchProjectionRepository.materializeVersion({
      userId: draft.workflow.userId,
      workflowId: draft.workflow.id,
      versionId: draft.version.id,
      expectedActiveVersionId: winner.workflow.activeVersionId!,
      kind: 'rollback',
      sourceText: firstPayload.name,
      nextRunAt: new Date('2026-09-17T12:00:00.000Z'),
    });
    expect(rollback.success).toBe(true);
    if (rollback.success) {
      expect(rollback.workflow.activeVersionId).toBe(draft.version.id);
      expect(rollback.event.kind).toBe('rollback');
      await expect(watchRepository.getForUser(
        rollback.watchId,
        draft.workflow.userId,
      )).resolves.toMatchObject({
        status: 'paused',
        nextRunAt: null,
        workflowVersionId: draft.version.id,
      });
      await expect(workflowWatchProjectionRepository.materializeVersion({
        userId: draft.workflow.userId,
        workflowId: draft.workflow.id,
        versionId: draft.version.id,
        expectedActiveVersionId: winner.workflow.activeVersionId!,
        kind: 'rollback',
        sourceText: firstPayload.name,
        nextRunAt: new Date('2026-09-17T12:00:00.000Z'),
      })).resolves.toMatchObject({
        success: true,
        watchId: rollback.watchId,
        event: { id: rollback.event.id, kind: 'rollback' },
      });
    }
    const winningVersionId = winner.event.activatedVersionId;
    const winningProposal = winningVersionId === second.version.id
      ? second.proposal
      : third.proposal;
    const consumedReplay = await workflowWatchProjectionRepository.materializeVersion({
      userId: draft.workflow.userId,
      workflowId: draft.workflow.id,
      versionId: winningVersionId,
      expectedActiveVersionId: draft.version.id,
      proposalId: winningProposal.id,
      kind: 'activate',
      sourceText: 'Consumed proposal replay',
      nextRunAt: new Date('2026-09-17T13:00:00.000Z'),
    });
    expect(consumedReplay).toEqual({ success: false, reason: 'proposal_not_found' });
    const events = await workflowRepository.listActivationEventsForUser(
      draft.workflow.id,
      draft.workflow.userId,
    );
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.kind)).toEqual(['activate', 'activate', 'rollback']);
  }, 30_000);

  it('retries the complete activation transaction after a live CockroachDB 40001', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const payload = {
      name: 'Retry-safe digest', cadence: 'daily' as const, hourOfDay: 7,
      action: 'digest' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: ['retry'], domains: [] },
      summaryInstruction: 'Summarize retry evidence with citations.',
    };
    const draft = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload,
      authoring: {
        version: 1,
        source: 'user',
        sourceReferences: [{ kind: 'message', id: 'live-40001-retry' }],
      },
    });

    // Arm only the first transaction acquired by materializeVersion. Cockroach
    // itself raises SQLSTATE 40001 on the first statement after BEGIN; SET LOCAL
    // rolls back with that transaction, so the repository's next attempt runs
    // normally against the same live cluster.
    const pool = getPool();
    const connectable = pool as unknown as { connect(): Promise<PoolClient> };
    const originalConnect = connectable.connect.bind(pool);
    let injectedTransactions = 0;
    connectable.connect = async () => {
      const client = await originalConnect();
      if (injectedTransactions > 0) return client;
      injectedTransactions += 1;
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === 'query') {
            return async (text: string, params?: unknown[]) => {
              const result = await target.query(text, params);
              if (text === 'BEGIN') {
                await target.query('SET LOCAL inject_retry_errors_enabled = true');
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    };

    let activated;
    try {
      activated = await workflowWatchProjectionRepository.materializeVersion({
        userId,
        workflowId: draft.workflow.id,
        versionId: draft.version.id,
        expectedActiveVersionId: null,
        proposalId: draft.proposal.id,
        kind: 'activate',
        sourceText: payload.name,
        nextRunAt: new Date('2026-09-17T07:00:00.000Z'),
      });
    } finally {
      connectable.connect = originalConnect;
    }

    expect(injectedTransactions).toBe(1);
    expect(activated).toMatchObject({
      success: true,
      workflow: { activeVersionId: draft.version.id },
      event: {
        sequence: 1,
        previousVersionId: null,
        activatedVersionId: draft.version.id,
        proposalId: draft.proposal.id,
      },
    });
    if (!activated?.success) throw new Error('activation did not recover after 40001');

    const verify = new Client({ connectionString: databaseUrl });
    await verify.connect();
    const durable = await verify.query<{
      active_version_id: string;
      active_activation_event_id: string;
      workflow_version_id: string;
      activation_count: string;
      watch_count: string;
    }>(
      `SELECT wf.active_version_id, wf.active_activation_event_id,
              w.workflow_version_id,
              (SELECT count(*)::STRING FROM workflow_activation_events e
                WHERE e.workflow_id = wf.id) AS activation_count,
              (SELECT count(*)::STRING FROM watches owned
                WHERE owned.workflow_id = wf.id AND owned.user_id = wf.user_id) AS watch_count
         FROM workflows wf
         JOIN watches w ON w.workflow_id = wf.id AND w.user_id = wf.user_id
        WHERE wf.id = $1 AND wf.user_id = $2`,
      [draft.workflow.id, userId],
    );
    await verify.end();
    expect(durable.rows).toEqual([expect.objectContaining({
      active_version_id: draft.version.id,
      active_activation_event_id: activated.event.id,
      workflow_version_id: draft.version.id,
      activation_count: '1',
      watch_count: '1',
    })]);
  }, 30_000);

  it('moves the active pointer and exact Watch projection in one Cockroach transaction', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const authoring = {
      version: 1 as const,
      source: 'user' as const,
      sourceReferences: [{ kind: 'message' as const, id: 'projection-message-1' }],
    };
    const firstPayload = {
      name: 'Invoice digest', cadence: 'daily' as const, hourOfDay: 9, action: 'digest' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [] },
      summaryInstruction: 'Summarize invoices with citations.',
    };
    const draft = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: firstPayload,
      authoring,
    });
    const first = await workflowWatchProjectionRepository.materializeVersion({
      userId,
      workflowId: draft.workflow.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      proposalId: draft.proposal.id,
      kind: 'activate',
      sourceText: firstPayload.name,
      nextRunAt: new Date('2026-09-17T09:00:00.000Z'),
    });
    expect(first.success).toBe(true);
    if (!first.success) throw new Error('initial projection failed');

    const second = await workflowRepository.createVersionWithProposal({
      userId,
      workflowId: draft.workflow.id,
      parentVersionId: draft.version.id,
      providerSchemaVersion: '1',
      payload: { ...firstPayload, filter: { ...firstPayload.filter, keywords: ['invoice', 'receipt'] } },
      authoring,
      kind: 'edit',
    });
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('second version failed');
    const moved = await workflowWatchProjectionRepository.materializeVersion({
      userId,
      workflowId: draft.workflow.id,
      versionId: second.version.id,
      expectedActiveVersionId: draft.version.id,
      proposalId: second.proposal.id,
      kind: 'activate',
      sourceText: 'Invoice and receipt digest',
      nextRunAt: new Date('2026-09-17T10:00:00.000Z'),
    });
    expect(moved).toMatchObject({ success: true, watchId: first.watchId });

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const state = await client.query<{
      active_version_id: string;
      workflow_version_id: string;
      content_hash: string;
      keywords: string[];
    }>(
      `SELECT wf.active_version_id, w.workflow_version_id, w.content_hash,
              ARRAY(SELECT jsonb_array_elements_text(w.filter->'keywords')) AS keywords
         FROM workflows wf JOIN watches w ON w.workflow_id = wf.id
        WHERE wf.id = $1`,
      [draft.workflow.id],
    );
    await client.end();
    expect(state.rows[0]).toMatchObject({
      active_version_id: second.version.id,
      workflow_version_id: second.version.id,
      content_hash: second.version.contentHash,
      keywords: ['invoice', 'receipt'],
    });
  }, 30_000);

  it('backfills legacy Watches without attributing their historical runs', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const legacyWatchId = '50000000-0000-4000-8000-000000000001';
    await client.query(
      `INSERT INTO watches
         (id, user_id, name, source_text, cadence, hour_of_day, filter,
          action, status, next_run_at)
       VALUES ($1, $2, 'Invoice digest', 'invoice mail', 'daily', 9,
               $3::JSONB, 'digest', 'active', $4)`,
      [legacyWatchId, '10000000-0000-4000-8000-000000000001', JSON.stringify({
        sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [],
      }), new Date('2026-09-17T09:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO watch_runs
         (watch_id, user_id, ran_at, action, matched_count, summary, schedule_revision,
          scheduled_for, window_start, window_end, watch_spec, slot_status,
          attempt_count, completed_at)
       SELECT id, user_id, now(), 'digest', 1, 'old result', schedule_revision,
              now(), now(), now(), $2::JSONB, 'completed', 1, now()
         FROM watches WHERE id = $1`,
      [legacyWatchId, JSON.stringify({
        name: 'Invoice digest', cadence: 'daily', hourOfDay: 9, dayOfWeek: null,
        filter: { sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [] },
        action: 'digest',
      })],
    );
    await client.end();

    const result = await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 1 });
    expect(result.legacyWatchesMigrated).toBe(1);

    const verify = new Client({ connectionString: databaseUrl });
    await verify.connect();
    const graph = await verify.query<{
      workflow_id: string;
      workflow_version_id: string;
      active_version_id: string;
      proposal_count: string;
      event_count: string;
    }>(
      `SELECT w.workflow_id, w.workflow_version_id, wf.active_version_id,
              (SELECT count(*)::STRING FROM workflow_proposals p
                WHERE p.workflow_id = w.workflow_id) AS proposal_count,
              (SELECT count(*)::STRING FROM workflow_activation_events e
                WHERE e.workflow_id = w.workflow_id) AS event_count
         FROM watches w JOIN workflows wf ON wf.id = w.workflow_id
        WHERE w.id = $1 AND wf.user_id = w.user_id`,
      [legacyWatchId],
    );
    const historical = await verify.query<{ workflow_id: string | null }>(
      `SELECT workflow_id FROM watch_runs WHERE watch_id = $1`,
      [legacyWatchId],
    );
    await verify.end();
    expect(graph.rows[0]).toMatchObject({ proposal_count: '1', event_count: '1' });
    expect(graph.rows[0]!.active_version_id).toBe(graph.rows[0]!.workflow_version_id);
    expect(historical.rows[0]!.workflow_id).toBeNull();
  }, 30_000);

  it('re-materializes a missing Watch for a restored active signal digest', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const payload = {
      name: 'Restored security digest', cadence: 'daily' as const, hourOfDay: 9,
      action: 'notify' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: [], domains: ['security'] },
      summaryInstruction: 'Summarize security signals with citations.',
    };
    const timezoneClient = new Client({ connectionString: databaseUrl });
    await timezoneClient.connect();
    await timezoneClient.query(`UPDATE users SET timezone = 'America/Los_Angeles' WHERE id = $1`, [userId]);
    await timezoneClient.end();
    const draft = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload,
      authoring: {
        version: 1,
        source: 'import',
        sourceReferences: [{ kind: 'import', id: 'restored-workflow-1' }],
      },
    });
    const activated = await workflowWatchProjectionRepository.materializeVersion({
      userId,
      workflowId: draft.workflow.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      proposalId: draft.proposal.id,
      kind: 'activate',
      sourceText: payload.name,
      nextRunAt: new Date('2026-09-17T09:00:00.000Z'),
    });
    expect(activated.success).toBe(true);
    if (!activated.success) throw new Error('initial projection failed');
    const deleteProjection = new Client({ connectionString: databaseUrl });
    await deleteProjection.connect();
    await deleteProjection.query('DELETE FROM watches WHERE id = $1', [activated.watchId]);
    await deleteProjection.end();

    const result = await legacyWatchWorkflowReconciliationRepository.reconcileBatch({
      limit: 1,
      now: new Date('2026-09-16T12:00:00.000Z'),
    });
    expect(result).toEqual({
      legacyWatchesMigrated: 0,
      activeWorkflowProjectionsMaterialized: 1,
      mayHaveMore: true,
    });

    const verify = new Client({ connectionString: databaseUrl });
    await verify.connect();
    const projection = await verify.query<{
      status: string;
      workflow_version_id: string;
      content_hash: string;
      next_run_at: Date;
    }>(
      `SELECT status, workflow_version_id, content_hash, next_run_at
         FROM watches WHERE workflow_id = $1 AND user_id = $2`,
      [draft.workflow.id, userId],
    );
    await verify.end();
    expect(projection.rows[0]).toMatchObject({
      status: 'active',
      workflow_version_id: draft.version.id,
      content_hash: draft.version.contentHash,
    });
    expect(projection.rows[0]!.next_run_at.toISOString()).toBe('2026-09-16T16:00:00.000Z');
  }, 30_000);

  it('quarantines invalid rows durably and still reconciles later valid work', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const authoring = {
      version: 1 as const,
      source: 'import' as const,
      sourceReferences: [{ kind: 'import' as const, id: 'starvation-live-test' }],
    };
    const invalidWorkflow = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: {
        name: 'Invalid restored digest', cadence: 'hourly', action: 'digest',
        filter: { sources: [], fromContains: [], keywords: [], domains: [] },
        summaryInstruction: 'Summarize matching signals.',
      },
      authoring,
    });
    const validPayload = {
      name: 'Valid restored digest', cadence: 'hourly' as const, action: 'digest' as const,
      filter: { sources: ['gmail'], fromContains: [], keywords: [], domains: [] },
      summaryInstruction: 'Summarize matching signals.',
    };
    const validWorkflow = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: 'signal_digest.v1',
      providerSchemaVersion: '1',
      payload: validPayload,
      authoring,
    });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    for (const draft of [invalidWorkflow, validWorkflow]) {
      const activation = await client.query<{ id: string }>(
        `INSERT INTO workflow_activation_events
           (workflow_id, user_id, previous_version_id, activated_version_id,
            proposal_id, kind, event_sequence)
         VALUES ($1, $2, NULL, $3, $4, 'activate', 1)
         RETURNING id`,
        [draft.workflow.id, userId, draft.version.id, draft.proposal.id],
      );
      await client.query(
        `UPDATE workflows
            SET active_version_id = $2, active_activation_event_id = $3
          WHERE id = $1`,
        [draft.workflow.id, draft.version.id, activation.rows[0]!.id],
      );
    }
    const invalidLegacyId = '50000000-0000-4000-8000-000000000010';
    const validLegacyId = '50000000-0000-4000-8000-000000000011';
    for (const [id, keyword] of [
      [invalidLegacyId, 'unsafe\u0001'],
      [validLegacyId, 'receipt'],
    ]) {
      await client.query(
        `INSERT INTO watches
           (id, user_id, name, source_text, cadence, filter, action, status, next_run_at)
         VALUES ($1, $2, 'Legacy digest', 'legacy source', 'hourly', $3::JSONB,
                 'digest', 'active', now())`,
        [id, userId, JSON.stringify({
          sources: [], fromContains: [], keywords: [keyword], domains: [],
        })],
      );
    }
    await client.end();

    const result = await legacyWatchWorkflowReconciliationRepository.reconcileBatch({ limit: 4 });
    expect(result).toMatchObject({
      activeWorkflowProjectionsMaterialized: 2,
      legacyWatchesMigrated: 2,
    });

    const verify = new Client({ connectionString: databaseUrl });
    await verify.connect();
    const restored = await verify.query<{ workflow_id: string; status: string; source_text: string }>(
      `SELECT workflow_id, status, source_text FROM watches
        WHERE workflow_id = ANY($1) ORDER BY workflow_id`,
      [[invalidWorkflow.workflow.id, validWorkflow.workflow.id]],
    );
    const legacy = await verify.query<{
      id: string;
      status: string;
      provider_key: string;
      active_version_id: string | null;
      reason_code: string | null;
    }>(
      `SELECT w.id, w.status, wf.provider_key, wf.active_version_id,
              wv.canonical_payload->>'reasonCode' AS reason_code
         FROM watches w
         JOIN workflows wf ON wf.id = w.workflow_id
         JOIN workflow_versions wv ON wv.id = w.workflow_version_id
        WHERE w.id = ANY($1) ORDER BY w.id`,
      [[invalidLegacyId, validLegacyId]],
    );
    await verify.end();

    const invalidRestored = restored.rows.find((row) => row.workflow_id === invalidWorkflow.workflow.id)!;
    const validRestored = restored.rows.find((row) => row.workflow_id === validWorkflow.workflow.id)!;
    expect(invalidRestored).toMatchObject({ status: 'paused' });
    expect(invalidRestored.source_text).toContain('invalid_provider_payload');
    expect(validRestored).toMatchObject({ status: 'active' });
    expect(legacy.rows[0]).toMatchObject({
      id: invalidLegacyId,
      status: 'paused',
      provider_key: 'legacy_watch.quarantine.v1',
      active_version_id: null,
      reason_code: 'invalid_signal_digest_payload',
    });
    expect(legacy.rows[1]).toMatchObject({
      id: validLegacyId,
      status: 'active',
      provider_key: 'signal_digest.v1',
    });
  }, 30_000);
});
