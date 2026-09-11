import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    fn({ query: mockClientQuery }),
}));

const { oauthRepository, OAuthAccountBindingConflictError } = await import('../repositories/oauth-repository.js');

function fakeRow(
  overrides: Partial<{
    id: string;
    user_id: string;
    provider: string;
    account_email: string;
    account_provider_id: string | null;
    connector_account_id: string;
    credential_revision: string;
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
    connector_account_id: overrides.connector_account_id ?? 'account-1',
    credential_revision: overrides.credential_revision ?? '11111111-1111-4111-8111-111111111111',
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

  it('lists active connections in deterministic account order for worker selection', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await oauthRepository.listAllConnections();
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('ca.is_active = true');
    expect(sql).toContain('encrypted_refresh_token IS NOT NULL');
    expect(sql).toContain('ORDER BY t.user_id, t.provider, t.updated_at DESC, t.id DESC');
  });

  describe('saveTokenForAccount', () => {
    it('creates a verified account and binds the token atomically', async () => {
      const row = fakeRow({ account_email: 'work@example.com', account_provider_id: 'sub-123' });
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // prior by email
        .mockResolvedValueOnce({ rows: [{ id: 'account-1' }], rowCount: 1 }) // account upsert
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // token by stable account
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 }); // token insert

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

      expect(mockClientQuery.mock.calls[1]![0]).toContain('provider_subject_digest');
      const [sql, args] = mockClientQuery.mock.calls[3]!;
      expect(sql).toContain('connector_account_id');
      expect(sql).toContain('WHERE oauth_tokens.connector_account_id = EXCLUDED.connector_account_id');
      expect(args).toEqual([
        'user-1',
        'google',
        'work@example.com',
        'sub-123',
        'access-1',
        'refresh-1',
        row.expires_at,
        ['gmail.readonly'],
        'account-1',
      ]);
    });

    it('fails closed when a concurrent insert owns the display email under another subject', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // prior by email
        .mockResolvedValueOnce({ rows: [{ id: 'account-new' }], rowCount: 1 }) // account upsert
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // token by stable account
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // guarded conflict update

      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'same@example.com',
        accountProviderId: 'new-subject', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).rejects.toBeInstanceOf(OAuthAccountBindingConflictError);

      expect(mockClientQuery.mock.calls[3]![0]).toContain(
        'WHERE oauth_tokens.connector_account_id = EXCLUDED.connector_account_id',
      );
    });

    it('retires and rebinds a legacy identity in the same transaction', async () => {
      const row = fakeRow({ connector_account_id: 'verified-account' });
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tok-1', connector_account_id: 'legacy-account' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'verified-account' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // cursor transfer
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // stale health removal
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // legacy deactivation
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      await oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'A@Example.com',
        accountProviderId: ' 123 ', accessToken: 'a', refreshToken: 'r',
        expiresAt: row.expires_at, scopes: ['z', 'a', 'z'],
      });

      expect(mockClientQuery.mock.calls[0]![0]).toContain('lower(t.account_email)');
      expect(mockClientQuery.mock.calls[2]![0]).toContain('UPDATE connector_cursors');
      expect(mockClientQuery.mock.calls[3]![0]).toContain('DELETE FROM connector_health');
      expect(mockClientQuery.mock.calls[4]![0]).toContain('is_active = false');
      expect(mockClientQuery.mock.calls[5]![0]).toContain('WHERE id = $8');
      expect(mockClientQuery.mock.calls[5]![1]).toContain('a@example.com');
      expect(mockClientQuery.mock.calls[5]![1]).toContainEqual(['a', 'z']);
    });

    it('fails closed when case-insensitive legacy display identity is ambiguous', async () => {
      mockClientQuery.mockResolvedValueOnce({
        rows: [
          { id: 'tok-a', connector_account_id: 'account-a' },
          { id: 'tok-b', connector_account_id: 'account-b' },
        ],
        rowCount: 2,
      });
      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'a@example.com',
        accountProviderId: 'sub', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).rejects.toBeInstanceOf(OAuthAccountBindingConflictError);
      expect(mockClientQuery.mock.calls[0]![0]).toContain('ORDER BY t.updated_at DESC, t.id DESC');
    });

    it('rejects the same display email bound to a different verified subject', async () => {
      mockClientQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'tok-1', connector_account_id: 'account-old', identity_verified: true,
            provider_subject_digest: 'not-the-new-digest',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: 'account-new' }], rowCount: 1 });
      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'a@example.com',
        accountProviderId: 'new-subject', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).rejects.toBeInstanceOf(OAuthAccountBindingConflictError);
    });

    it('retries a serialization failure around the complete identity transaction', async () => {
      mockClientQuery
        .mockRejectedValueOnce(Object.assign(new Error('retry'), { code: '40001' }))
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: 'account-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [fakeRow()], rowCount: 1 });
      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'a@example.com',
        accountProviderId: 'sub', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).resolves.toMatchObject({ id: 'tok-1' });
      expect(mockClientQuery).toHaveBeenCalledTimes(5);
    });
  });

  describe('deleteAccount', () => {
    it('deletes a single (user, provider, account_email) row', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await oauthRepository.deleteAccount('user-1', 'google', 'work@example.com');

      expect(result).toBe(true);
      expect(mockClientQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('lower(account_email) = lower($3)'),
        ['user-1', 'google', 'work@example.com'],
      );
      expect(mockClientQuery.mock.calls[0]![0]).toContain('DELETE FROM connector_health');
      expect(mockClientQuery.mock.calls[1]![0]).toContain('lower(account_email) = lower($3)');
    });

    it('returns false when no row matched', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await oauthRepository.deleteAccount('user-1', 'google', 'nope@example.com');
      expect(result).toBe(false);
    });
  });

  it('disconnect-all deactivates every active provider identity before deleting secrets', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(oauthRepository.deleteAllForProvider('user-1', 'google')).resolves.toBe(1);
    expect(mockClientQuery.mock.calls[0]![0]).toContain('DELETE FROM connector_health');
    expect(mockClientQuery.mock.calls[1]![0]).toContain('ca.is_active = true');
    expect(mockClientQuery.mock.calls[1]![0]).not.toContain('oauth_tokens');
    expect(mockClientQuery.mock.calls[2]![0]).toContain('DELETE FROM oauth_tokens');
  });

  it('uses credential_revision rather than timestamp equality for account refresh CAS', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await oauthRepository.updateAccessTokenByConnectorAccount(
      'user-1', 'google', 'account-1', 'new-access', new Date(),
      '11111111-1111-4111-8111-111111111111',
    );
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('t.credential_revision = $6');
    expect(sql).not.toContain('t.updated_at = $6');
    expect(args[5]).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('persists expiry in the same revision-checked encrypted credential write', async () => {
    const expiresAt = new Date('2026-09-11T13:00:00.000Z');
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(oauthRepository.updateEncrypted('token-1', {
      encryptedAccessToken: Buffer.from('access'),
      encryptedRefreshToken: Buffer.from('refresh'),
      iv: Buffer.alloc(0),
      tag: Buffer.alloc(0),
      keyVersion: 1,
      expiresAt,
    }, '22222222-2222-4222-8222-222222222222')).resolves.toBe(true);

    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('expires_at              = $6');
    expect(sql).toContain('credential_revision = $8');
    expect(args[5]).toEqual(expiresAt);
    expect(args[7]).toBe('22222222-2222-4222-8222-222222222222');
  });

  describe('saveToken (legacy)', () => {
    it('reuses the existing row\'s account_email for backward-compat', async () => {
      // First call: getToken finds an existing row.
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ account_email: 'a@example.com', account_provider_id: 'sub-7' })],
        rowCount: 1,
      });
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tok-1', connector_account_id: 'account-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'account-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [fakeRow({ account_email: 'a@example.com' })], rowCount: 1 });

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
      const reboundArgs = mockClientQuery.mock.calls[2]![1] as unknown[];
      expect(reboundArgs[0]).toBe('a@example.com');
      expect(reboundArgs[1]).toBe('sub-7');
    });

    it('looks up the user\'s primary email when no existing row exists', async () => {
      // No existing oauth_tokens row.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // SELECT email FROM users — returns the primary email.
      mockQuery.mockResolvedValueOnce({
        rows: [{ email: 'fresh@example.com' }],
        rowCount: 1,
      });
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: 'account-fresh' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [fakeRow({ account_email: 'fresh@example.com' })], rowCount: 1 });

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

      const upsertArgs = mockClientQuery.mock.calls[3]![1] as unknown[];
      expect(upsertArgs[2]).toBe('fresh@example.com');
      expect(upsertArgs[3]).toBeNull();
    });

    it('falls back to empty account_email when the user row is missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockClientQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: 'account-orphan' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [fakeRow({ account_email: '' })], rowCount: 1 });

      await oauthRepository.saveToken(
        'user-orphan',
        'google',
        'access',
        'refresh',
        new Date(),
        [],
      );

      const upsertArgs = mockClientQuery.mock.calls[3]![1] as unknown[];
      expect(upsertArgs[2]).toBe('');
    });
  });
});
