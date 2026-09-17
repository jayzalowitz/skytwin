import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

const cockroachAvailable =
  spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

const workflowMigration = readFileSync(
  new URL('../migrations/095-adaptive-workflow-foundation.sql', import.meta.url),
  'utf8',
);
const pinMigration = readFileSync(
  new URL('../migrations/096-watch-workflow-version-pins.sql', import.meta.url),
  'utf8',
);

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
  const sql = await reserve(26_000 + (process.pid % 3_000));
  const http = await reserve(46_000 + (process.pid % 3_000));
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

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '10000000-0000-4000-8000-000000000002';
const WORKFLOW = '20000000-0000-4000-8000-000000000001';
const VERSION_ONE = '30000000-0000-4000-8000-000000000001';
const VERSION_TWO = '30000000-0000-4000-8000-000000000002';
const WATCH = '40000000-0000-4000-8000-000000000001';
const HASH_ONE = 'a'.repeat(64);
const HASH_TWO = 'b'.repeat(64);
const PROPOSAL_ONE = '60000000-0000-4000-8000-000000000001';
const PROPOSAL_TWO = '60000000-0000-4000-8000-000000000002';
const EVENT_ONE = '70000000-0000-4000-8000-000000000001';
const EVENT_TWO = '70000000-0000-4000-8000-000000000002';

const setup = `
  CREATE TABLE users (id UUID PRIMARY KEY);
  CREATE TABLE watches (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT watches_id_user_uniq UNIQUE (id, user_id)
  );
  CREATE TABLE watch_runs (
    id UUID PRIMARY KEY,
    watch_id UUID NOT NULL,
    user_id UUID NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    CONSTRAINT watch_runs_watch_owner_fk
      FOREIGN KEY (watch_id, user_id) REFERENCES watches (id, user_id) ON DELETE CASCADE
  );
  INSERT INTO users VALUES ('${OWNER}'), ('${OTHER_OWNER}');
  INSERT INTO watches VALUES ('${WATCH}', '${OWNER}');
  INSERT INTO watch_runs VALUES (
    '50000000-0000-4000-8000-000000000001', '${WATCH}', '${OWNER}', now()
  );
  ${workflowMigration}
  INSERT INTO workflows (id, user_id, provider_key)
    VALUES ('${WORKFLOW}', '${OWNER}', 'signal_digest.v1');
  INSERT INTO workflow_versions (
    id, workflow_id, user_id, version_number, provider_key,
    provider_schema_version, canonical_payload, content_hash,
    parent_version_id, authoring_metadata
  ) VALUES (
    '${VERSION_ONE}', '${WORKFLOW}', '${OWNER}', 1, 'signal_digest.v1',
    '1', '{"name":"v1"}', '${HASH_ONE}', NULL,
    '{"version":1,"source":"migration","sourceReferences":[]}'
  );
  INSERT INTO workflow_proposals (
    id, workflow_id, user_id, base_version_id, proposed_version_id, kind
  ) VALUES ('${PROPOSAL_ONE}', '${WORKFLOW}', '${OWNER}', NULL, '${VERSION_ONE}', 'initial');
  INSERT INTO workflow_activation_events (
    id, workflow_id, user_id, previous_version_id, activated_version_id,
    proposal_id, kind, event_sequence
  ) VALUES ('${EVENT_ONE}', '${WORKFLOW}', '${OWNER}', NULL, '${VERSION_ONE}', '${PROPOSAL_ONE}', 'activate', 1);
  UPDATE workflows
     SET active_version_id = '${VERSION_ONE}', active_activation_event_id = '${EVENT_ONE}'
   WHERE id = '${WORKFLOW}';
`;

describe.runIf(cockroachAvailable)('096 Watch workflow-version pins on CockroachDB', () => {
  it('is rerunnable, leaves historical rows unattributed, and preserves old run pins after activation', async () => {
    const exercise = `
      ${pinMigration}
      ${pinMigration}
      UPDATE watches SET
        workflow_id = '${WORKFLOW}', workflow_version_id = '${VERSION_ONE}',
        workflow_provider_key = 'signal_digest.v1', workflow_provider_schema_version = '1',
        content_hash = '${HASH_ONE}', projection_version = 1
      WHERE id = '${WATCH}';
      INSERT INTO watch_runs (
        id, watch_id, user_id, scheduled_for,
        workflow_id, workflow_version_id, workflow_provider_key,
        workflow_provider_schema_version, content_hash, projection_version,
        workflow_payload_snapshot
      ) VALUES (
        '50000000-0000-4000-8000-000000000002', '${WATCH}', '${OWNER}', now() + INTERVAL '1 second',
        '${WORKFLOW}', '${VERSION_ONE}', 'signal_digest.v1', '1', '${HASH_ONE}', 1,
        '{"name":"v1"}'::JSONB
      );
      INSERT INTO workflow_versions (
        id, workflow_id, user_id, version_number, provider_key,
        provider_schema_version, canonical_payload, content_hash,
        parent_version_id, authoring_metadata
      ) VALUES (
        '${VERSION_TWO}', '${WORKFLOW}', '${OWNER}', 2, 'signal_digest.v1',
        '1', '{"name":"v2"}', '${HASH_TWO}', '${VERSION_ONE}',
        '{"version":1,"source":"user","sourceReferences":[]}'
      );
      INSERT INTO workflow_proposals (
        id, workflow_id, user_id, base_version_id, proposed_version_id, kind
      ) VALUES (
        '${PROPOSAL_TWO}', '${WORKFLOW}', '${OWNER}', '${VERSION_ONE}', '${VERSION_TWO}', 'edit'
      );
      INSERT INTO workflow_activation_events (
        id, workflow_id, user_id, previous_version_id, activated_version_id,
        proposal_id, kind, event_sequence
      ) VALUES (
        '${EVENT_TWO}', '${WORKFLOW}', '${OWNER}', '${VERSION_ONE}', '${VERSION_TWO}', '${PROPOSAL_TWO}', 'activate', 2
      );
      UPDATE workflows
         SET active_version_id = '${VERSION_TWO}', active_activation_event_id = '${EVENT_TWO}'
       WHERE id = '${WORKFLOW}';
      UPDATE watches SET workflow_version_id = '${VERSION_TWO}', content_hash = '${HASH_TWO}'
       WHERE id = '${WATCH}';
      SELECT
        (SELECT workflow_id IS NULL AND workflow_version_id IS NULL
            AND workflow_provider_key IS NULL AND workflow_provider_schema_version IS NULL
            AND content_hash IS NULL AND projection_version IS NULL
           FROM watch_runs WHERE id = '50000000-0000-4000-8000-000000000001') AS legacy_unattributed,
        (SELECT workflow_version_id = '${VERSION_ONE}' AND content_hash = '${HASH_ONE}'
           FROM watch_runs WHERE id = '50000000-0000-4000-8000-000000000002') AS run_stayed_pinned,
        (SELECT workflow_version_id = '${VERSION_TWO}' AND content_hash = '${HASH_TWO}'
           FROM watches WHERE id = '${WATCH}') AS watch_moved,
        EXISTS (
          SELECT 1 FROM [SHOW CONSTRAINTS FROM watch_runs]
           WHERE constraint_name = 'watch_runs_workflow_version_owner_hash_fk'
        ) AS run_owner_hash_fk,
        EXISTS (
          SELECT 1 FROM [SHOW INDEXES FROM watches]
           WHERE index_name = 'watches_one_projection_per_workflow_idx'
        ) AS one_watch_index;
    `;
    const result = await runCockroachDemo(`${setup}\n${exercise}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('t,t,t,t,t');
  }, 30_000);

  it('rejects cross-owner projection attribution', async () => {
    const exercise = `
      ${pinMigration}
      UPDATE watches SET user_id = '${OTHER_OWNER}',
        workflow_id = '${WORKFLOW}', workflow_version_id = '${VERSION_ONE}',
        workflow_provider_key = 'signal_digest.v1', workflow_provider_schema_version = '1',
        content_hash = '${HASH_ONE}', projection_version = 1
      WHERE id = '${WATCH}';
    `;
    const result = await runCockroachDemo(`${setup}\n${exercise}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/foreign key|violates/i);
  }, 30_000);
});
