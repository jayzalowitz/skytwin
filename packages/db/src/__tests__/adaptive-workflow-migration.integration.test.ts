import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

const cockroachAvailable =
  spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

async function availablePorts(): Promise<[number, number]> {
  const reserve = (start: number) =>
    new Promise<{ server: ReturnType<typeof createServer>; port: number }>((resolve, reject) => {
      const tryPort = (port: number) => {
        const server = createServer();
        server.once('error', (error: NodeJS.ErrnoException) => {
          server.close();
          if (error.code === 'EADDRINUSE' && port < start + 1_000) tryPort(port + 1);
          else reject(error);
        });
        server.listen(port, '127.0.0.1', () => resolve({ server, port }));
      };
      tryPort(start);
    });
  const sql = await reserve(25_000 + (process.pid % 4_000));
  const http = await reserve(45_000 + (process.pid % 4_000));
  await Promise.all([
    new Promise<void>((resolve) => sql.server.close(() => resolve())),
    new Promise<void>((resolve) => http.server.close(() => resolve())),
  ]);
  return [sql.port, http.port];
}

async function runCockroachDemo(sql: string) {
  const [sqlPort, httpPort] = await availablePorts();
  return spawnSync('cockroach', [
    'demo', '--empty', '--insecure', `--sql-port=${sqlPort}`, `--http-port=${httpPort}`,
    '--format=csv', '--execute', sql,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

describe.runIf(cockroachAvailable)('095 adaptive workflow foundation on CockroachDB', () => {
  it('installs owner-safe immutable history and permits owner cascade deletion', async () => {
    const migration = readFileSync(
      new URL('../migrations/095-adaptive-workflow-foundation.sql', import.meta.url),
      'utf8',
    );
    const setup = `
      CREATE TABLE users (id UUID PRIMARY KEY);
      INSERT INTO users VALUES
        ('10000000-0000-4000-8000-000000000001'),
        ('10000000-0000-4000-8000-000000000002');
    `;
    const exercise = `
      INSERT INTO workflows (id, user_id, provider_key) VALUES
        ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'signal_digest');
      INSERT INTO workflow_versions (
        id, workflow_id, user_id, version_number, provider_key, provider_schema_version,
        canonical_payload, content_hash, parent_version_id, authoring_metadata
      ) VALUES (
        '30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001', 1, 'signal_digest', 'v1',
        '{"keywords":["invoice"]}', '${'a'.repeat(64)}', NULL,
        '{"version":1,"source":"user","sourceReferences":[]}'
      );
      INSERT INTO workflow_proposals (
        id, workflow_id, user_id, base_version_id, proposed_version_id, kind
      ) VALUES (
        '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001', NULL,
        '30000000-0000-4000-8000-000000000001', 'initial'
      );
      INSERT INTO workflow_activation_events (
        id, workflow_id, user_id, previous_version_id, activated_version_id,
        proposal_id, kind, event_sequence
      ) VALUES (
        '50000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        NULL, '30000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001', 'activate', 1
      );
      UPDATE workflows
         SET active_version_id = '30000000-0000-4000-8000-000000000001',
             active_activation_event_id = '50000000-0000-4000-8000-000000000001';
      DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000000001';
      SELECT
        (SELECT count(*) FROM workflows) = 0 AS workflows_purged,
        (SELECT count(*) FROM workflow_versions) = 0 AS versions_purged,
        (SELECT count(*) FROM workflow_proposals) = 0 AS proposals_purged,
        (SELECT count(*) FROM workflow_activation_events) = 0 AS events_purged,
        EXISTS (
          SELECT 1 FROM [SHOW CONSTRAINTS FROM workflows]
          WHERE constraint_name = 'workflows_active_version_owner_provider_fk'
        ) AS active_owner_constraint;
    `;
    const result = await runCockroachDemo(`${setup}\n${migration}\n${exercise}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('t,t,t,t,t');
  }, 30_000);

  it('rejects a version whose owner does not own the workflow', async () => {
    const migration = readFileSync(
      new URL('../migrations/095-adaptive-workflow-foundation.sql', import.meta.url),
      'utf8',
    );
    const sql = `
      CREATE TABLE users (id UUID PRIMARY KEY);
      INSERT INTO users VALUES
        ('10000000-0000-4000-8000-000000000001'),
        ('10000000-0000-4000-8000-000000000002');
      ${migration}
      INSERT INTO workflows (id, user_id, provider_key) VALUES
        ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'signal_digest');
      INSERT INTO workflow_versions (
        workflow_id, user_id, version_number, provider_key, provider_schema_version,
        canonical_payload, content_hash, authoring_metadata
      ) VALUES (
        '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
        1, 'signal_digest', 'v1', '{}', '${'b'.repeat(64)}',
        '{"version":1,"source":"user","sourceReferences":[]}'
      );
    `;
    const result = await runCockroachDemo(sql);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/foreign key|violates/i);
  }, 30_000);

  it('rejects an activation event that bypasses the reviewed proposal boundary', async () => {
    const migration = readFileSync(
      new URL('../migrations/095-adaptive-workflow-foundation.sql', import.meta.url),
      'utf8',
    );
    const sql = `
      CREATE TABLE users (id UUID PRIMARY KEY);
      INSERT INTO users VALUES ('10000000-0000-4000-8000-000000000001');
      ${migration}
      INSERT INTO workflows (id, user_id, provider_key) VALUES
        ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'signal_digest');
      INSERT INTO workflow_versions (
        id, workflow_id, user_id, version_number, provider_key, provider_schema_version,
        canonical_payload, content_hash, authoring_metadata
      ) VALUES (
        '30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001', 1, 'signal_digest', 'v1', '{}',
        '${'c'.repeat(64)}', '{"version":1,"source":"user","sourceReferences":[]}'
      );
      INSERT INTO workflow_activation_events (
        workflow_id, user_id, previous_version_id, activated_version_id,
        proposal_id, kind, event_sequence
      ) VALUES (
        '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        NULL, '30000000-0000-4000-8000-000000000001', NULL, 'activate', 1
      );
    `;
    const result = await runCockroachDemo(sql);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/check constraint|transition_shape/i);
  }, 30_000);
});
