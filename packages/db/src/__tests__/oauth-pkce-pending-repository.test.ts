import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { oauthPkcePendingRepository } = await import(
  '../repositories/oauth-pkce-pending-repository.js'
);

describe('oauthPkcePendingRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('remember', () => {
    it('upserts on the state primary key (re-issued state overwrites verifier)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const expiresAt = new Date('2026-05-22T01:00:00Z');
      await oauthPkcePendingRepository.remember('state-A', 'verifier-1', expiresAt);

      // We don't want a separate happy-path INSERT and a fallback UPDATE;
      // a single ON CONFLICT upsert is what makes "re-clicking sign-in"
      // safe without raising a 23505.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/INSERT INTO oauth_pkce_pending/);
      expect(sql).toMatch(/ON CONFLICT \(state\) DO UPDATE/);
      expect(sql).toMatch(/code_verifier = EXCLUDED\.code_verifier/);
      expect(sql).toMatch(/expires_at = EXCLUDED\.expires_at/);
      expect(params).toEqual(['state-A', 'verifier-1', expiresAt]);
    });
  });

  describe('consume', () => {
    it('atomically deletes-and-returns the verifier (consume-on-read)', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { code_verifier: 'verifier-1', expires_at: new Date('2026-05-22T01:00:00Z') },
        ],
        rowCount: 1,
      });

      const now = new Date('2026-05-22T00:00:00Z'); // before expiry
      const result = await oauthPkcePendingRepository.consume('state-A', now);

      expect(result).toBe('verifier-1');
      const [sql, params] = mockQuery.mock.calls[0]!;
      // The DELETE...RETURNING is what blocks replay attacks: a callback
      // that fires twice can't redeem the same code twice because the
      // row is gone after the first call.
      expect(sql).toMatch(/DELETE FROM oauth_pkce_pending/);
      expect(sql).toMatch(/RETURNING code_verifier/);
      expect(params).toEqual(['state-A']);
    });

    it('returns undefined when the row does not exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await oauthPkcePendingRepository.consume('missing');

      expect(result).toBeUndefined();
    });

    it('returns undefined when the row has expired (defence-in-depth even if sweep is behind)', async () => {
      // The sweep is best-effort and may lag; consume() must reject an
      // expired verifier on its own so we never replay one Google would
      // refuse anyway.
      mockQuery.mockResolvedValue({
        rows: [
          { code_verifier: 'stale', expires_at: new Date('2026-05-22T00:00:00Z') },
        ],
        rowCount: 1,
      });

      const now = new Date('2026-05-22T00:30:00Z'); // after expiry
      const result = await oauthPkcePendingRepository.consume('state-A', now);

      expect(result).toBeUndefined();
    });
  });

  describe('sweepExpired', () => {
    it('deletes rows past expires_at', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 4 });

      const now = new Date('2026-05-22T00:00:00Z');
      const deleted = await oauthPkcePendingRepository.sweepExpired(now);

      expect(deleted).toBe(4);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/DELETE FROM oauth_pkce_pending WHERE expires_at < \$1/);
      expect(params).toEqual([now]);
    });
  });
});
