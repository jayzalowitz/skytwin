import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { oauthPendingSigninRepository, PendingSigninCollisionError } = await import(
  '../repositories/oauth-pending-signin-repository.js'
);

const DIGEST = 'a'.repeat(64);

describe('oauthPendingSigninRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('remember', () => {
    it('stores only a digest with immutable insert semantics', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ pending_key: DIGEST }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const expiresAt = new Date('2026-05-22T01:00:00Z');

      await oauthPendingSigninRepository.remember({
        pendingKeyDigest: DIGEST,
        userId: 'user-xyz',
        accountEmail: 'foo@example.com',
        scopes: ['openid', 'email'],
        nextHash: '#/connect-gmail',
        expiresAt,
      });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/ON CONFLICT \(pending_key\) DO NOTHING/);
      expect(sql).not.toMatch(/DO UPDATE/);
      expect(params).toEqual([
        DIGEST, 'user-xyz', 'foo@example.com', JSON.stringify(['openid', 'email']),
        '#/connect-gmail', expiresAt,
      ]);
    });

    it.each([
      ['same user', 'user-xyz'],
      ['different user', 'other-user'],
    ])('fails a %s digest reuse without mutating the original row', async (_label, userId) => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(oauthPendingSigninRepository.remember({
        pendingKeyDigest: DIGEST,
        userId,
        accountEmail: 'foo@example.com',
        scopes: [],
        nextHash: null,
        expiresAt: new Date('2026-05-22T01:00:00Z'),
      })).rejects.toBeInstanceOf(PendingSigninCollisionError);
      expect(String(mockQuery.mock.calls[0]?.[0])).not.toMatch(/UPDATE SET/);
    });

    it('uses the transaction client and never exposes a destructive consume API', async () => {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [{ pending_key: DIGEST }], rowCount: 1 });
      await oauthPendingSigninRepository.remember({
        pendingKeyDigest: DIGEST,
        userId: 'user-xyz',
        accountEmail: 'foo@example.com',
        scopes: [],
        nextHash: null,
        expiresAt: new Date('2026-05-22T01:00:00Z'),
      }, { query: clientQuery } as never);
      expect(clientQuery).toHaveBeenCalledOnce();
      expect(mockQuery).not.toHaveBeenCalled();
      expect('consume' in oauthPendingSigninRepository).toBe(false);
    });

    it('rejects non-canonical digests before SQL', async () => {
      await expect(oauthPendingSigninRepository.remember({
        pendingKeyDigest: 'raw-capability', userId: 'user-xyz', accountEmail: 'foo@example.com',
        scopes: [], nextHash: null, expiresAt: new Date(),
      })).rejects.toBeInstanceOf(TypeError);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  it('sweeps only expired rows', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 7 });
    const now = new Date('2026-05-22T00:00:00Z');
    expect(await oauthPendingSigninRepository.sweepExpired(now)).toBe(7);
    expect(mockQuery.mock.calls[0]?.[1]).toEqual([now]);
  });

  it('migration 079 purges only legacy raw capabilities and preserves digests on rerun', () => {
    const migration = readFileSync(
      new URL('../migrations/079-oauth-pending-signin-session.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('DELETE FROM oauth_pending_signin');
    expect(migration).toContain('length(pending_key) <> 64');
    expect(migration).toContain("pending_key !~ '^[0-9a-f]{64}$'");
    expect(migration).not.toMatch(/DELETE FROM oauth_pending_signin\s*;/);
  });
});
