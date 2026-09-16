import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const seedSource = readFileSync(
  fileURLToPath(new URL('../seeds/seed.ts', import.meta.url)),
  'utf8',
);
const showcaseSource = readFileSync(
  fileURLToPath(new URL('../seeds/demo-showcase.ts', import.meta.url)),
  'utf8',
);

describe('sample connector seed', () => {
  it('creates and binds the synthetic OAuth token to a connector account', () => {
    expect(seedSource).toContain('INSERT INTO connected_accounts');
    expect(seedSource).toContain("'sample:google:alex'");
    expect(seedSource).toContain('connector_account_id, created_at, updated_at');
    expect(seedSource).toContain('connector_account_id = EXCLUDED.connector_account_id');
  });

  it('keeps every showcase OAuth token account-bound', () => {
    expect(showcaseSource).toContain('INSERT INTO connected_accounts');
    expect(showcaseSource).toContain("'sample:google:' || $1::STRING");
    expect(showcaseSource).toContain('connector_account_id, created_at, updated_at');
    expect(showcaseSource).toContain('connector_account_id = EXCLUDED.connector_account_id');
  });
});
