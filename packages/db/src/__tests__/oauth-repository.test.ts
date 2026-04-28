import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { oauthRepository } = await import('../repositories/oauth-repository.js');

function fakeRow(
  overrides: Partial<{
    id: string;
    user_id: string;
    provider: string;
    account_email: string;
    account_provider_id: string | null;
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scopes: string[];
    created_at: Date;
    updated_at: Date;
  }> = {},
) {
  return {
    id: overrides.id ?? 'tok-1',
    user_id: overrides.user_id ?? 'user-1',
    provider: overrides.provider ?? 'google',
    account_email: overrides.account_email ?? 'a@example.com',
    account_provider_id: overrides.account_provider_id ?? null,
    access_token: overrides.access_token ?? 'access-1',
    refresh_token: overrides.refresh_token ?? 'refresh-1',
    expires_at: overrides.expires_at ?? new Date('2026-04-28T07:00:00Z'),
    scopes: overrides.scopes ?? ['gmail.readonly'],
    created_at: overrides.created_at ?? new Date('2026-04-28T05:00:00Z'),
    updated_at: overrides.updated_at ?? new Date('2026-04-28T06:00:00Z'),
  };
}

describe('oauthRepository (multi-account)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTokenByAccount', () => {
    it('keys on (userId, provider, accountEmail)', async () => {
      const row = fakeRow({ account_email: 'work@example.com' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await oauthRepository.getTokenByAccount('user-1', 'google', 'work@example.com');

      expect(result).toEqual(row);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('account_email = $3'),
        ['user-1', 'google', 'work@example.com'],
      );
    });

    it('returns null when no row matches', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      const result = await oauthRepository.getTokenByAccount('user-1', 'google', 'nope@example.com');
      expect(result).toBeNull();
    });
  });

  describe('listAccountsForUser', () => {
    it('returns all rows for (userId, provider) ordered by recency', async () => {
      const rows = [
        fakeRow({ account_email: 'work@example.com' }),
        fakeRow({ account_email: 'personal@example.com', id: 'tok-2' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await oauthRepository.listAccountsForUser('user-1', 'google');

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY updated_at DESC'),
        ['user-1', 'google'],
      );
    });
  });

  describe('saveTokenForAccount', () => {
    it('upserts on (user_id, provider, account_email)', async () => {
      const row = fakeRow({ account_email: 'work@example.com', account_provider_id: 'sub-123' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await oauthRepository.saveTokenForAccount({
        userId: 'user-1',
        provider: 'google',
        accountEmail: 'work@example.com',
        accountProviderId: 'sub-123',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: row.expires_at,
        scopes: ['gmail.readonly'],
      });

      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT (user_id, provider, account_email)');
      expect(args).toEqual([
        'user-1',
        'google',
        'work@example.com',
        'sub-123',
        'access-1',
        'refresh-1',
        row.expires_at,
        ['gmail.readonly'],
      ]);
    });
  });

  describe('deleteAccount', () => {
    it('deletes a single (user, provider, account_email) row', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await oauthRepository.deleteAccount('user-1', 'google', 'work@example.com');

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND account_email = $3'),
        ['user-1', 'google', 'work@example.com'],
      );
    });

    it('returns false when no row matched', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      const result = await oauthRepository.deleteAccount('user-1', 'google', 'nope@example.com');
      expect(result).toBe(false);
    });
  });

  describe('saveToken (legacy)', () => {
    it('reuses the existing row\'s account_email for backward-compat', async () => {
      // First call: getToken finds an existing row.
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ account_email: 'a@example.com', account_provider_id: 'sub-7' })],
        rowCount: 1,
      });
      // Second call: saveTokenForAccount upserts.
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ account_email: 'a@example.com' })],
        rowCount: 1,
      });

      await oauthRepository.saveToken(
        'user-1',
        'google',
        'access-2',
        'refresh-2',
        new Date('2026-04-28T08:00:00Z'),
        ['gmail.readonly'],
      );

      // Second call's SQL should be the multi-account upsert with the
      // existing row's account_email/sub propagated.
      const upsertArgs = mockQuery.mock.calls[1]![1] as unknown[];
      expect(upsertArgs[0]).toBe('user-1');
      expect(upsertArgs[1]).toBe('google');
      expect(upsertArgs[2]).toBe('a@example.com');
      expect(upsertArgs[3]).toBe('sub-7');
    });

    it('looks up the user\'s primary email when no existing row exists', async () => {
      // No existing oauth_tokens row.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // SELECT email FROM users — returns the primary email.
      mockQuery.mockResolvedValueOnce({
        rows: [{ email: 'fresh@example.com' }],
        rowCount: 1,
      });
      // saveTokenForAccount upsert.
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ account_email: 'fresh@example.com' })],
        rowCount: 1,
      });

      await oauthRepository.saveToken(
        'user-fresh',
        'google',
        'access',
        'refresh',
        new Date(),
        [],
      );

      const lookupArgs = mockQuery.mock.calls[1]![1] as unknown[];
      expect(lookupArgs).toEqual(['user-fresh']);

      const upsertArgs = mockQuery.mock.calls[2]![1] as unknown[];
      expect(upsertArgs[2]).toBe('fresh@example.com');
      expect(upsertArgs[3]).toBeNull();
    });

    it('falls back to empty account_email when the user row is missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ account_email: '' })],
        rowCount: 1,
      });

      await oauthRepository.saveToken(
        'user-orphan',
        'google',
        'access',
        'refresh',
        new Date(),
        [],
      );

      const upsertArgs = mockQuery.mock.calls[2]![1] as unknown[];
      expect(upsertArgs[2]).toBe('');
    });
  });
});
