import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SIGNAL_DIGEST_V1_PROVIDER_KEY,
  SIGNAL_DIGEST_V1_SCHEMA_VERSION,
} from '@skytwin/routines';

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

describe.runIf(cockroachAvailable)('adaptive workflow backup on live CockroachDB', () => {
  let child: ChildProcess;
  let dataRoot: string;
  let databaseUrl: string;
  let sql: Client;
  let closePool: () => Promise<void>;
  let collectBackup: typeof import('../backup/backup.js')['collectBackup'];
  let restoreBackup: typeof import('../backup/backup.js')['restoreBackup'];
  let workflowRepository: typeof import('../repositories/workflow-repository.js')['workflowRepository'];
  let workflowWatchProjectionRepository: typeof import('../repositories/workflow-watch-projection-repository.js')['workflowWatchProjectionRepository'];
  let reconcileLegacyWatches: typeof import('../repositories/legacy-watch-workflow-reconciliation-repository.js')['legacyWatchWorkflowReconciliationRepository'];

  beforeAll(async () => {
    const [sqlPort, httpPort] = await reservePorts();
    dataRoot = mkdtempSync(join(tmpdir(), 'skytwin-adaptive-workflow-backup-'));
    databaseUrl = `postgresql://root@127.0.0.1:${sqlPort}/defaultdb?sslmode=disable`;
    child = spawn('cockroach', [
      'start-single-node', '--insecure', `--listen-addr=127.0.0.1:${sqlPort}`,
      `--http-addr=127.0.0.1:${httpPort}`, `--store=${join(dataRoot, 'store')}`,
      `--log-dir=${join(dataRoot, 'logs')}`,
    ], { stdio: 'ignore' });
    await waitForSql(databaseUrl);

    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email STRING NOT NULL,
        name STRING NOT NULL,
        trust_tier STRING NOT NULL,
        autonomy_settings JSONB NOT NULL DEFAULT '{}'::JSONB,
        ironclaw_channel STRING,
        execution_authority_revision UUID NOT NULL DEFAULT gen_random_uuid(),
        language STRING,
        timezone STRING,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE twin_profiles (id UUID PRIMARY KEY, user_id UUID NOT NULL);
      CREATE TABLE preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const { splitSqlStatements } = await import('../migrations/001-initial.js');
    for (const filename of [
      '069-watches.sql',
      '070-watch-runs.sql',
      '089-watch-scheduled-slots.sql',
      '095-adaptive-workflow-foundation.sql',
      '096-watch-workflow-version-pins.sql',
    ]) {
      const migration = readFileSync(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
      for (const statement of splitSqlStatements(migration)) await sql.query(statement);
    }

    process.env['DATABASE_URL'] = databaseUrl;
    const connection = await import('../connection.js');
    closePool = connection.closePool;
    ({ collectBackup, restoreBackup } = await import('../backup/backup.js'));
    ({ workflowRepository } = await import('../repositories/workflow-repository.js'));
    ({ workflowWatchProjectionRepository } = await import(
      '../repositories/workflow-watch-projection-repository.js'
    ));
    ({ legacyWatchWorkflowReconciliationRepository: reconcileLegacyWatches } = await import(
      '../repositories/legacy-watch-workflow-reconciliation-repository.js'
    ));
  }, 120_000);

  afterEach(async () => {
    await sql.query(
      `DELETE FROM users WHERE id IN (
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000003'
      )`,
    );
  });

  afterAll(async () => {
    await closePool?.();
    await sql?.end();
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

  it('round-trips a paused Watch without making it due', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    await sql.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, timezone)
       VALUES ($1, 'backup@example.test', 'Backup User', 'observer', '{}'::JSONB, 'UTC')`,
      [userId],
    );
    const payload = {
      name: 'Invoice digest',
      cadence: 'daily' as const,
      hourOfDay: 9,
      filter: {
        sources: ['gmail'],
        fromContains: [],
        keywords: ['invoice'],
        domains: [],
      },
      action: 'digest' as const,
      summaryInstruction: 'Summarize invoice messages.',
    };
    const draft = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: SIGNAL_DIGEST_V1_PROVIDER_KEY,
      providerSchemaVersion: SIGNAL_DIGEST_V1_SCHEMA_VERSION,
      payload,
      kind: 'initial',
      authoring: {
        version: 1,
        source: 'user',
        sourceReferences: [{ kind: 'message', id: 'message-1' }],
      },
    });
    const projected = await workflowWatchProjectionRepository.materializeVersion({
      userId,
      workflowId: draft.workflow.id,
      versionId: draft.version.id,
      expectedActiveVersionId: null,
      proposalId: draft.proposal.id,
      kind: 'activate',
      sourceText: 'Every morning summarize invoice mail.',
      nextRunAt: new Date('2026-09-17T09:00:00.000Z'),
    });
    expect(projected.success).toBe(true);
    if (!projected.success) throw new Error(`projection failed: ${projected.reason}`);
    await sql.query(
      `UPDATE watches
          SET status = 'paused', next_run_at = NULL,
              created_at = '2026-09-16T08:00:00.000Z',
              last_run_at = '2026-09-16T09:00:00.000Z',
              updated_at = '2026-09-16T10:00:00.000Z'
        WHERE id = $1`,
      [projected.watchId],
    );

    const backup = await collectBackup(userId);
    if (!backup.success) throw new Error(backup.message);
    expect(backup.data.workflows?.[0]?.watchProjection).toMatchObject({
      id: projected.watchId,
      status: 'paused',
      nextRunAt: null,
      sourceText: 'Every morning summarize invoice mail.',
      lastRunAt: '2026-09-16T09:00:00.000Z',
      createdAt: '2026-09-16T08:00:00.000Z',
      updatedAt: '2026-09-16T10:00:00.000Z',
    });
    const exportedProjection = backup.data.workflows?.[0]?.watchProjection;
    if (!exportedProjection) throw new Error('backup omitted Watch projection');

    await sql.query('DELETE FROM users WHERE id = $1', [userId]);
    await expect(restoreBackup(backup.data)).resolves.toMatchObject({
      success: true,
      summary: { counts: { watches: 1 } },
    });
    const restored = await sql.query<{
      id: string;
      source_text: string;
      status: string;
      schedule_revision: string;
      created_at: Date;
      updated_at: Date;
      last_run_at: Date | null;
      next_run_at: Date | null;
    }>(
      `SELECT id, source_text, status, schedule_revision, created_at, updated_at,
              last_run_at, next_run_at
         FROM watches WHERE workflow_id = $1`,
      [draft.workflow.id],
    );
    expect(restored.rows).toHaveLength(1);
    expect(restored.rows[0]).toMatchObject({
      id: projected.watchId,
      source_text: 'Every morning summarize invoice mail.',
      status: 'paused',
      schedule_revision: exportedProjection.scheduleRevision,
      next_run_at: null,
    });
    expect(restored.rows[0]?.created_at.toISOString()).toBe('2026-09-16T08:00:00.000Z');
    expect(restored.rows[0]?.updated_at.toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(restored.rows[0]?.last_run_at?.toISOString()).toBe('2026-09-16T09:00:00.000Z');
  }, 30_000);

  it('round-trips a quarantined invalid legacy Watch with its exact original spec', async () => {
    const userId = '10000000-0000-4000-8000-000000000002';
    const watchId = '20000000-0000-4000-8000-000000000002';
    await sql.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
       VALUES ($1, 'legacy-quarantine@example.test', 'Legacy Quarantine', 'observer', '{}'::JSONB)`,
      [userId],
    );
    await sql.query(
      `INSERT INTO watches
         (id, user_id, name, source_text, cadence, hour_of_day, day_of_week,
          filter, action, status, next_run_at)
       VALUES ($1, $2, 'Unmappable weekly Watch', 'Keep the exact legacy Watch',
               'weekly', NULL, NULL, $3::JSONB, 'notify', 'active', NULL)`,
      [watchId, userId, JSON.stringify({
        sources: ['gmail'], fromContains: ['billing@example.com'],
        keywords: ['invoice'], domains: ['finance'],
      })],
    );
    await expect(reconcileLegacyWatches.reconcileBatch({ limit: 1 })).resolves.toMatchObject({
      legacyWatchesMigrated: 1,
    });

    const backup = await collectBackup(userId);
    if (!backup.success) throw new Error(backup.message);
    const projection = backup.data.workflows?.[0]?.watchProjection;
    expect(projection).toMatchObject({
      kind: 'quarantined_watch_snapshot.v1',
      id: watchId,
      status: 'paused',
      nextRunAt: null,
      snapshot: {
        name: 'Unmappable weekly Watch',
        cadence: 'weekly',
        hourOfDay: null,
        dayOfWeek: null,
        filter: {
          sources: ['gmail'], fromContains: ['billing@example.com'],
          keywords: ['invoice'], domains: ['finance'],
        },
        action: 'notify',
      },
    });

    await sql.query('DELETE FROM users WHERE id = $1', [userId]);
    await expect(restoreBackup(backup.data)).resolves.toMatchObject({
      success: true,
      summary: { counts: { watches: 1 } },
    });
    const restored = await sql.query(
      `SELECT name, source_text, cadence, hour_of_day, day_of_week, filter,
              action, status, next_run_at
         FROM watches WHERE id = $1`,
      [watchId],
    );
    expect(restored.rows[0]).toMatchObject({
      name: 'Unmappable weekly Watch',
      source_text: 'Keep the exact legacy Watch',
      cadence: 'weekly',
      hour_of_day: null,
      day_of_week: null,
      filter: {
        sources: ['gmail'], fromContains: ['billing@example.com'],
        keywords: ['invoice'], domains: ['finance'],
      },
      action: 'notify',
      status: 'paused',
      next_run_at: null,
    });
  }, 30_000);

  it('round-trips a hash-mismatched signal digest as an inert quarantine pin', async () => {
    const userId = '10000000-0000-4000-8000-000000000003';
    await sql.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, timezone)
       VALUES ($1, 'digest-quarantine@example.test', 'Digest Quarantine',
               'observer', '{}'::JSONB, 'UTC')`,
      [userId],
    );
    const draft = await workflowRepository.createDraftWithProposal({
      userId,
      providerKey: SIGNAL_DIGEST_V1_PROVIDER_KEY,
      providerSchemaVersion: SIGNAL_DIGEST_V1_SCHEMA_VERSION,
      payload: {
        name: 'Hash mismatch digest', cadence: 'hourly',
        filter: { sources: ['gmail'], fromContains: [], keywords: [], domains: [] },
        action: 'digest', summaryInstruction: 'Summarize matching mail.',
      },
      kind: 'initial',
      authoring: {
        version: 1,
        source: 'user',
        sourceReferences: [{ kind: 'message', id: 'message-hash-mismatch' }],
      },
    });
    const mismatchedHash = 'a'.repeat(64);
    await sql.query('UPDATE workflow_versions SET content_hash = $2 WHERE id = $1', [
      draft.version.id, mismatchedHash,
    ]);
    const activation = await sql.query<{ id: string }>(
      `INSERT INTO workflow_activation_events
         (workflow_id, user_id, previous_version_id, activated_version_id,
          proposal_id, kind, event_sequence)
       VALUES ($1, $2, NULL, $3, $4, 'activate', 1)
       RETURNING id`,
      [draft.workflow.id, userId, draft.version.id, draft.proposal.id],
    );
    await sql.query(
      `UPDATE workflows
          SET active_version_id = $2, active_activation_event_id = $3
        WHERE id = $1`,
      [draft.workflow.id, draft.version.id, activation.rows[0]!.id],
    );
    await expect(reconcileLegacyWatches.reconcileBatch({ limit: 1 })).resolves.toMatchObject({
      activeWorkflowProjectionsMaterialized: 1,
    });

    const backup = await collectBackup(userId);
    if (!backup.success) throw new Error(backup.message);
    const projection = backup.data.workflows?.[0]?.watchProjection;
    expect(projection).toMatchObject({
      kind: 'quarantined_watch_snapshot.v1',
      status: 'paused',
      nextRunAt: null,
      contentHash: mismatchedHash,
      snapshot: {
        name: 'Workflow projection unavailable',
        cadence: 'hourly',
        action: 'digest',
      },
    });

    await sql.query('DELETE FROM users WHERE id = $1', [userId]);
    await expect(restoreBackup(backup.data)).resolves.toMatchObject({
      success: true,
      summary: { counts: { watches: 1 } },
    });
    const restored = await sql.query(
      `SELECT status, next_run_at, content_hash, name, source_text
         FROM watches WHERE workflow_id = $1`,
      [draft.workflow.id],
    );
    expect(restored.rows[0]).toMatchObject({
      status: 'paused',
      next_run_at: null,
      content_hash: mismatchedHash,
      name: 'Workflow projection unavailable',
      source_text: 'Projection quarantined: content_hash_mismatch',
    });
  }, 30_000);
});
