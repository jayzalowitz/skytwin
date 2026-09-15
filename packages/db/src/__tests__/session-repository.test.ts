import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../connection.js', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

const { sessionRepository, revalidateSourceKeySessionAuthority } =
  await import('../repositories/session-repository.js');

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  token_hash: 'a'.repeat(64),
  device_name: 'Phone', created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
  last_active_at: new Date(), revoked: false,
};

describe('sessionRepository authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts only one token-hash row and bounds the lookup', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    await expect(sessionRepository.findByTokenHash(row.token_hash)).resolves.toEqual(row);
    expect(mockQuery.mock.calls[0]![0]).toContain('LIMIT 2');
    mockQuery.mockResolvedValueOnce({ rows: [row, { ...row, id: 'other' }] });
    await expect(sessionRepository.findByTokenHash(row.token_hash)).resolves.toBeNull();
  });

  it('atomically authenticates and returns the canonical maintained lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    await expect(sessionRepository.authenticateAndMaintain(row.token_hash))
      .resolves.toEqual({ status: 'active', session: row });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('WITH candidates AS MATERIALIZED');
    expect(sql).toContain("INTERVAL '7 days'");
    expect(sql).toContain('RETURNING session.*');
  });

  it('distinguishes inactive authority from transient database failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(sessionRepository.authenticateAndMaintain(row.token_hash))
      .resolves.toEqual({ status: 'inactive' });
    mockQuery.mockResolvedValueOnce({ rows: [row, { ...row, id: 'other' }] });
    await expect(sessionRepository.authenticateAndMaintain(row.token_hash))
      .resolves.toEqual({ status: 'inactive' });
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(sessionRepository.authenticateAndMaintain(row.token_hash))
      .resolves.toEqual({ status: 'unavailable' });
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(revalidateSourceKeySessionAuthority({
      sessionId: row.id, ownerId: row.user_id, tokenHash: row.token_hash,
      expiresAtMs: row.expires_at.getTime(),
    })).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('migration 082', () => {
  it('rejects duplicates before adding a global unique authority index', () => {
    const sql = readFileSync(new URL('../migrations/082-session-token-hash-unique.sql', import.meta.url), 'utf8');
    expect(sql.indexOf('HAVING count(*) > 1')).toBeLessThan(sql.indexOf('CREATE UNIQUE INDEX'));
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique_idx');
    expect(sql).toContain('ON sessions (token_hash)');
    expect(sql).toContain('migration_082_index_shape_assertion');
    expect(sql).toContain("index_name = 'sessions_token_hash_unique_idx'");
    expect(sql).toContain('catalog_index.indpred IS NULL');
    expect(sql).not.toMatch(/WHERE\s+revoked\s*=\s*false/i);
  });
});
