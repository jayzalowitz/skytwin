import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const cockroachAvailable = spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;
const migration = readFileSync(
  new URL('../migrations/082-session-token-hash-unique.sql', import.meta.url),
  'utf8',
);
const schema = `
  CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash STRING NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false
  );
  CREATE INDEX idx_sessions_token ON sessions (token_hash) WHERE revoked = false;
`;

function run(sql: string) {
  return spawnSync(
    'cockroach',
    [
      'demo', '--empty', '--insecure', '--sql-port=0', '--http-port=0',
      '--format=csv', '--execute', sql,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
}

describe.runIf(cockroachAvailable)('session token authority migration on CockroachDB', () => {
  it('is idempotent and rejects even a revoked duplicate after migration', () => {
    const result = run(`${schema}\n${migration}\n${migration}\nINSERT INTO sessions (token_hash) VALUES ('unique');\nINSERT INTO sessions (token_hash, revoked) VALUES ('unique', true);`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/duplicate key|unique constraint/i);
  }, 30_000);

  it('refuses ambiguous legacy rows instead of deleting or selecting one', () => {
    const result = run(`${schema}\nINSERT INTO sessions (token_hash, revoked) VALUES ('ambiguous', false), ('ambiguous', true);\n${migration}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/division by zero/i);
  }, 30_000);

  it('refuses a weaker index that occupies the authority index name', () => {
    const result = run(`${schema}\nCREATE INDEX sessions_token_hash_unique_idx ON sessions (token_hash, revoked);\n${migration}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/division by zero/i);
  }, 30_000);

  it('refuses a partial unique index that occupies the authority index name', () => {
    const result = run(`${schema}\nCREATE UNIQUE INDEX sessions_token_hash_unique_idx ON sessions (token_hash) WHERE revoked = false;\n${migration}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/division by zero/i);
  }, 30_000);
});
