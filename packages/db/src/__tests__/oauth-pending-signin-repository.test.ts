import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { oauthPendingSigninRepository } = await import(
  '../repositories/oauth-pending-signin-repository.js'
);

describe('oauthPendingSigninRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('remember', () => {
    it('upserts on pending_key and serialises scopes as JSON', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const expiresAt = new Date('2026-05-22T01:00:00Z');
      await oauthPendingSigninRepository.remember({
        pendingKey: 'abc-1234',
        userId: 'user-xyz',
        accountEmail: 'foo@example.com',
        scopes: ['openid', 'email', 'profile'],
        nextHash: '#/connect-gmail',
        expiresAt,
      });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/INSERT INTO oauth_pending_signin/);
      expect(sql).toMatch(/ON CONFLICT \(pending_key\) DO UPDATE/);
      expect(params).toEqual([
        'abc-1234',
        'user-xyz',
        'foo@example.com',
        // Scopes serialised as JSON for the JSONB column — passing a
        // JS array directly would land in pg as a literal text array
        // (`{a,b}`), which is not valid JSON. The server-side INSERT
        // intentionally calls JSON.stringify so the column round-trips
        // cleanly.
        JSON.stringify(['openid', 'email', 'profile']),
        '#/connect-gmail',
        expiresAt,
      ]);
    });
  });

  describe('consume', () => {
    it('atomically deletes and returns the pending row when present and unexpired', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            user_id: 'user-xyz',
            account_email: 'foo@example.com',
            scopes: ['openid', 'email'],
            next_hash: '#/connect-gmail',
            expires_at: new Date('2026-05-22T01:00:00Z'),
          },
        ],
        rowCount: 1,
      });

      const now = new Date('2026-05-22T00:00:00Z');
      const result = await oauthPendingSigninRepository.consume('key-1', now);

      expect(result).toEqual({
        userId: 'user-xyz',
        accountEmail: 'foo@example.com',
        scopes: ['openid', 'email'],
        nextHash: '#/connect-gmail',
      });
      const [sql] = mockQuery.mock.calls[0]!;
      // DELETE...RETURNING is the replay-protection contract: the row
      // is gone after the first read, so a leaked key can only be
      // redeemed once.
      expect(sql).toMatch(/DELETE FROM oauth_pending_signin/);
      expect(sql).toMatch(/RETURNING /);
    });

    it('returns null when the row does not exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      const result = await oauthPendingSigninRepository.consume('key-1');
      expect(result).toBeNull();
    });

    it('returns null when the row is expired (defence-in-depth)', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            user_id: 'user-xyz',
            account_email: 'foo@example.com',
            scopes: [],
            next_hash: null,
            expires_at: new Date('2026-05-22T00:00:00Z'),
          },
        ],
        rowCount: 1,
      });

      // The sweep runs best-effort; consume() must reject an expired
      // row on its own so a stale handoff can't quietly resurface.
      const now = new Date('2026-05-22T00:30:00Z');
      const result = await oauthPendingSigninRepository.consume('key-1', now);
      expect(result).toBeNull();
    });

    it('coerces a malformed scopes column to an empty array', async () => {
      // Defensive: if a row somehow lands with non-array scopes
      // (manual SQL, schema migration mid-flight, etc.), the client
      // shouldn't crash on .map / .filter calls downstream.
      mockQuery.mockResolvedValue({
        rows: [
          {
            user_id: 'user-xyz',
            account_email: 'foo@example.com',
            scopes: 'not-an-array',
            next_hash: null,
            expires_at: new Date('2026-05-22T01:00:00Z'),
          },
        ],
        rowCount: 1,
      });

      const now = new Date('2026-05-22T00:00:00Z');
      const result = await oauthPendingSigninRepository.consume('key-1', now);
      expect(result?.scopes).toEqual([]);
    });
  });

  describe('sweepExpired', () => {
    it('deletes rows past expires_at', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 7 });

      const now = new Date('2026-05-22T00:00:00Z');
      const deleted = await oauthPendingSigninRepository.sweepExpired(now);

      expect(deleted).toBe(7);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/DELETE FROM oauth_pending_signin WHERE expires_at < \$1/);
      expect(params).toEqual([now]);
    });
  });
});
