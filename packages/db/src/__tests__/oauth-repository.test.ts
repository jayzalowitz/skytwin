import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn((...args: unknown[]) => mockQuery(...args));

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>) =>
    fn({ query: mockClientQuery }),
}));

const {
  oauthRepository,
  CredentialDispatchConflictError,
  CredentialDisconnectInProgressError,
  CredentialVaultLockedError,
  OAuthAccountBindingConflictError,
} = await import(
  '../repositories/oauth-repository.js'
);
const { digestProviderSubject } = await import('../repositories/connected-account-repository.js');

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
    dispatch_generation: string;
    dispatch_state: 'active' | 'disconnecting';
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
    dispatch_generation: overrides.dispatch_generation ?? '22222222-2222-4222-8222-222222222222',
    dispatch_state: overrides.dispatch_state ?? 'active',
  };
}

describe('oauthRepository (multi-account)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTokenByAccount', () => {
    it('keys on (userId, provider, accountEmail)', async () => {
      const row = fakeRow({ account_email: 'work@example.com', dispatch_state: 'disconnecting' });
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
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT id FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('user_credential_vault_meta')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT t.* FROM oauth_tokens AS t')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [row], rowCount: 1 });
      });

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

      const [sql, args] = mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes('ON CONFLICT (user_id, provider, account_email)'))!;
      expect(sql).toContain('ON CONFLICT (user_id, provider, account_email)');
      expect(sql).toContain('encrypted_access_token = EXCLUDED.encrypted_access_token');
      expect(sql).toContain('encrypted_refresh_token = EXCLUDED.encrypted_refresh_token');
      expect(sql).toContain('connector_account_id');
      expect(mockQuery.mock.calls.some(([statement]) =>
        String(statement).includes('INSERT INTO connected_accounts'))).toBe(true);
      expect(args).toEqual([
        'user-1',
        'google',
        'work@example.com',
        'sub-123',
        'access-1',
        'refresh-1',
        row.expires_at,
        ['gmail.readonly'],
        null,
        null,
        null,
        null,
        1,
        'tok-1',
      ]);
    });

    it('stores a reconnect encrypted when a matching vault generation is active', async () => {
      const encryptedAccessToken = Buffer.from('new-access-cipher');
      const encryptedRefreshToken = Buffer.from('new-refresh-cipher');
      const row = fakeRow({ account_email: 'work@example.com' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT id FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('user_credential_vault_meta')) {
          return Promise.resolve({ rows: [{
            current_key_version: 7,
            vault_state: 'unlocked',
            vault_generation: 'vault-generation-7',
          }] });
        }
        if (sql.includes('SELECT l.* FROM credential_dispatch_leases')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('SELECT * FROM execution_dispatch_ambiguities')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('INSERT INTO explanation_records')) {
          return Promise.resolve({ rows: [{ id: 'explanation-1' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO execution_dispatch_ambiguities')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes('UPDATE credential_dispatch_leases')) {
          return Promise.resolve({ rows: [{ id: 'lease-1' }], rowCount: 1 });
        }
        if (sql.includes('SELECT count(*) AS active_count')) {
          return Promise.resolve({ rows: [{ active_count: '0', retry_after: null }], rowCount: 1 });
        }
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [row] });
        if (sql.includes('INSERT INTO connected_accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-1' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO oauth_tokens')) {
          return Promise.resolve({ rows: [row], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      await oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'work@example.com',
        accessToken: 'plaintext-must-not-persist', refreshToken: 'plaintext-must-not-persist',
        expiresAt: row.expires_at, scopes: ['openid'],
        credentialStorage: {
          mode: 'encrypted', encryptedAccessToken, encryptedRefreshToken, keyVersion: 7,
          vaultGeneration: 'vault-generation-7',
        },
      });
      const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO oauth_tokens'))!;
      expect(insert[1]).toEqual(expect.arrayContaining([
        null, encryptedAccessToken, encryptedRefreshToken, 7,
      ]));
      expect(JSON.stringify(insert[1])).not.toContain('plaintext-must-not-persist');
    });

    it('refuses a plaintext downgrade or stale vault-key generation', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT id FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('user_credential_vault_meta')) {
          return Promise.resolve({ rows: [{
            current_key_version: 8,
            vault_state: 'unlocked',
            vault_generation: 'vault-generation-8',
          }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      const base = {
        userId: 'user-1', provider: 'google', accountEmail: 'work@example.com',
        accessToken: 'plain-access', refreshToken: 'plain-refresh',
        expiresAt: new Date(), scopes: ['openid'],
      };
      await expect(oauthRepository.saveTokenForAccount(base))
        .rejects.toBeInstanceOf(CredentialVaultLockedError);
      await expect(oauthRepository.saveTokenForAccount({
        ...base,
        credentialStorage: {
          mode: 'encrypted', encryptedAccessToken: Buffer.from('a'),
          encryptedRefreshToken: Buffer.from('r'), keyVersion: 7,
          vaultGeneration: 'vault-generation-7',
        },
      })).rejects.toBeInstanceOf(CredentialVaultLockedError);
      expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO oauth_tokens')))
        .toBe(false);
    });

    it('blocks reconnects and new provider accounts while remote revocation is fenced', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes("dispatch_state = 'disconnecting'")) {
          return Promise.resolve({ rows: [{ id: 'tok-fenced' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1',
        provider: 'google',
        accountEmail: 'new@example.com',
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: new Date(),
        scopes: ['openid'],
      })).rejects.toBeInstanceOf(CredentialDisconnectInProgressError);
      expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO oauth_tokens')))
        .toBe(false);
    });

    it('fails closed when a case-insensitive display identity is ambiguous', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes("dispatch_state = 'disconnecting'")) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('user_credential_vault_meta')) return Promise.resolve({ rows: [] });
        if (sql.includes('lower(account_email) = lower($3)')) {
          return Promise.resolve({
            rows: [fakeRow({ id: 'tok-a' }), fakeRow({ id: 'tok-b' })],
            rowCount: 2,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'A@example.com',
        accountProviderId: 'sub', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).rejects.toBeInstanceOf(OAuthAccountBindingConflictError);
      expect(mockQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO connected_accounts'))).toBe(false);
    });

    it('rejects a display email already bound to a different verified subject', async () => {
      const token = fakeRow({ connector_account_id: 'account-old' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes("dispatch_state = 'disconnecting'")) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('user_credential_vault_meta')) return Promise.resolve({ rows: [] });
        if (sql.includes('lower(account_email) = lower($3)')) {
          return Promise.resolve({ rows: [token], rowCount: 1 });
        }
        if (sql.includes('active_count')) {
          return Promise.resolve({ rows: [{ active_count: '0', retry_after: null }], rowCount: 1 });
        }
        if (sql.includes('FROM connected_accounts')) {
          return Promise.resolve({
            rows: [{
              id: 'account-old', identity_verified: true,
              provider_subject_digest: 'not-the-new-digest',
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'a@example.com',
        accountProviderId: 'new-subject', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).rejects.toBeInstanceOf(OAuthAccountBindingConflictError);
      expect(mockQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO connected_accounts'))).toBe(false);
    });

    it('rebinds the existing credential when a verified subject changes display email', async () => {
      const oldToken = fakeRow({
        id: 'tok-stable-subject',
        account_email: 'old@example.com',
        account_provider_id: 'stable-subject',
        connector_account_id: 'account-stable',
      });
      const saved = fakeRow({
        ...oldToken,
        account_email: 'new@example.com',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes("dispatch_state = 'disconnecting'")) return Promise.resolve({ rows: [] });
        if (sql.includes('user_credential_vault_meta')) return Promise.resolve({ rows: [] });
        if (sql.includes('lower(account_email) = lower($3)')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT t.* FROM oauth_tokens AS t')) {
          return Promise.resolve({ rows: [oldToken], rowCount: 1 });
        }
        if (sql.includes('active_count')) {
          return Promise.resolve({ rows: [{ active_count: '0', retry_after: null }] });
        }
        if (sql.includes('SELECT * FROM connected_accounts')) {
          return Promise.resolve({ rows: [{
            id: 'account-stable',
            identity_verified: true,
            provider_subject_digest: digestProviderSubject('google', 'stable-subject'),
          }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO connected_accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-stable' }], rowCount: 1 });
        }
        if (sql.includes('SET account_email = $1')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO oauth_tokens')) {
          return Promise.resolve({ rows: [saved], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'new@example.com',
        accountProviderId: 'stable-subject', accessToken: 'new-access', refreshToken: 'new-refresh',
        expiresAt: saved.expires_at, scopes: ['gmail.readonly'],
      })).resolves.toMatchObject({ id: 'tok-stable-subject', account_email: 'new@example.com' });

      const emailRebind = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('SET account_email = $1'));
      expect(emailRebind?.[1]).toEqual([
        'new@example.com', 'tok-stable-subject', 'user-1', 'google',
      ]);
      const insertedArgs = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO oauth_tokens'))?.[1] as unknown[];
      expect(insertedArgs[13]).toBe('account-stable');
    });

    it('retries a serialization failure around the complete identity transaction', async () => {
      let failOnce = true;
      const row = fakeRow();
      mockQuery.mockImplementation((sql: string) => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(Object.assign(new Error('retry'), { code: '40001' }));
        }
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT id FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('user_credential_vault_meta')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT t.* FROM oauth_tokens AS t')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO connected_accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-1' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO oauth_tokens')) {
          return Promise.resolve({ rows: [row], rowCount: 1 });
        }
        return Promise.resolve({ rows: [{ active_count: '0', retry_after: null }], rowCount: 1 });
      });

      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'a@example.com',
        accountProviderId: 'sub', accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date(), scopes: [],
      })).resolves.toMatchObject({ id: 'tok-1' });
      expect(mockQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('SELECT id FROM users'))).toHaveLength(2);
    });
  });

  describe('deleteAccount', () => {
    it('deletes a single (user, provider, account_email) row', async () => {
      const row = fakeRow({ account_email: 'work@example.com' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('active_count')) return Promise.resolve({ rows: [{ active_count: '0', retry_after: null }] });
        if (sql.includes('id = ANY($3::UUID[])')) {
          return Promise.resolve({
            rows: [{ ...row, dispatch_state: 'disconnecting' }],
            rowCount: 1,
          });
        }
        if (sql.includes("AND dispatch_state = 'disconnecting'")) {
          return Promise.resolve({ rows: [{ ...row, dispatch_state: 'disconnecting' }], rowCount: 1 });
        }
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [row] });
        if (sql.includes('DELETE FROM oauth_tokens')) return Promise.resolve({ rows: [], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const result = await oauthRepository.deleteAccount('user-1', 'google', 'work@example.com');

      expect(result).toBe(true);
      const deleteCall = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('DELETE FROM oauth_tokens'))!;
      expect(deleteCall[1]).toEqual(['user-1', 'google', ['tok-1']]);
      expect(mockQuery.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM connector_health'))).toBe(true);
      expect(mockQuery.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE connected_accounts AS ca'))).toBe(true);
    });

    it('returns false when no row matched', async () => {
      mockQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('SELECT id FROM users')
          ? { rows: [{ id: 'user-1' }] }
          : { rows: [], rowCount: 0 }));
      const result = await oauthRepository.deleteAccount('user-1', 'google', 'nope@example.com');
      expect(result).toBe(false);
    });
  });

  describe('dispatch fencing', () => {
    it('durably fences new leases and returns a typed pending disconnect', async () => {
      const retryAfter = new Date(Date.now() + 30_000);
      const row = fakeRow({ account_email: 'work@example.com' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [row] });
        if (sql.includes('active_count')) return Promise.resolve({ rows: [{ active_count: '1', retry_after: retryAfter }] });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      await expect(oauthRepository.beginDisconnect(
        'user-1', 'google', 'work@example.com',
      )).resolves.toEqual({ status: 'pending', retryAfter });
      const statements = mockQuery.mock.calls.map(([sql]) => String(sql));
      expect(statements.findIndex((sql) => sql.includes("dispatch_state = 'disconnecting'")))
        .toBeLessThan(statements.findIndex((sql) => sql.includes('active_count')));
      expect(statements.some((sql) => sql.includes('DELETE FROM oauth_tokens'))).toBe(false);
    });

    it('refuses reconnect/rotation while an exact row has an active lease', async () => {
      const retryAfter = new Date(Date.now() + 30_000);
      const row = fakeRow({ account_email: 'work@example.com' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [row] });
        if (sql.includes('active_count')) return Promise.resolve({ rows: [{ active_count: '1', retry_after: retryAfter }] });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      await expect(oauthRepository.saveTokenForAccount({
        userId: 'user-1', provider: 'google', accountEmail: 'work@example.com',
        accessToken: 'new-access', refreshToken: 'new-refresh',
        expiresAt: new Date(Date.now() + 60_000), scopes: [],
      })).rejects.toBeInstanceOf(CredentialDispatchConflictError);
      expect(mockQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO oauth_tokens'))).toBe(false);
    });
  });

  describe('rotateTokenIfCurrent', () => {
    it('rejects a provider refresh write whose credential revision lost to reconnect or rotation', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(oauthRepository.updateAccessTokenIfCurrent({
        id: 'tok-1', userId: 'user-1', provider: 'google',
        expectedCredentialRevision: 'stale-revision',
        accessToken: 'late-access', expiresAt: new Date('2026-09-13T03:00:00Z'),
      })).resolves.toBe(false);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(String(sql)).toContain('credential_revision = $6');
      expect(String(sql)).toContain("state IN ('request_started', 'ambiguous')");
      expect(String(sql)).toContain('l.provider = oauth_tokens.provider');
      expect(String(sql)).toContain('user_credential_vault_meta');
      expect(String(sql)).not.toContain('l.expires_at > now()');
      expect(params).toContain('stale-revision');
    });

    it('binds a late refresh write to the exact row revision and refresh grant', async () => {
      const expiresAt = new Date('2026-09-13T03:00:00Z');
      const oldRow = fakeRow({ access_token: 'old-access', refresh_token: 'old-refresh' });
      const newRow = fakeRow({ access_token: 'new-access', refresh_token: 'new-refresh' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [oldRow] });
        if (sql.includes('active_count')) return Promise.resolve({ rows: [{ active_count: '0', retry_after: null }] });
        if (sql.includes('UPDATE oauth_tokens')) return Promise.resolve({ rows: [newRow], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      await expect(oauthRepository.rotateTokenIfCurrent({
        id: 'tok-1', userId: 'user-1', provider: 'google',
        expectedAccessToken: 'old-access', expectedRefreshToken: 'old-refresh',
        expectedCredentialRevision: fakeRow().credential_revision,
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt,
        scopes: ['gmail.readonly'],
      })).resolves.toMatchObject({ access_token: 'new-access' });

      const [sql, params] = mockQuery.mock.calls.find(([statement]) =>
        String(statement).includes('AND access_token IS NOT DISTINCT FROM $8'))!;
      expect(sql).toContain('AND access_token IS NOT DISTINCT FROM $8');
      expect(sql).toContain('AND refresh_token = $9');
      expect(sql).toContain('user_credential_vault_meta');
      expect(params).toEqual([
        'new-access', 'new-refresh', expiresAt, ['gmail.readonly'],
        'tok-1', 'user-1', 'google', 'old-access', 'old-refresh', oldRow.credential_revision,
      ]);
    });

    it('returns null when disconnect or rotation invalidates the exact refresh authority', async () => {
      mockQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('SELECT id FROM users')
          ? { rows: [{ id: 'user-1' }] }
          : { rows: [], rowCount: 0 }));
      await expect(oauthRepository.rotateTokenIfCurrent({
        id: 'tok-1', userId: 'user-1', provider: 'google',
        expectedAccessToken: 'old-access', expectedRefreshToken: 'old-refresh',
        expectedCredentialRevision: fakeRow().credential_revision,
        accessToken: 'late-access', refreshToken: 'old-refresh', expiresAt: new Date(), scopes: [],
      })).resolves.toBeNull();
    });
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
    expect(sql).toContain('ca.identity_verified = true');
    expect(sql).toContain('user_credential_vault_meta');
    expect(sql).toContain('v.user_id = t.user_id');
    expect(args[5]).toBe('11111111-1111-4111-8111-111111111111');
  });

  describe('saveToken (legacy)', () => {
    it('reuses the existing row\'s account_email for backward-compat', async () => {
      // First call: getToken finds an existing row.
      const existing = fakeRow({ account_email: 'a@example.com', account_provider_id: 'sub-7' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
        if (sql.includes('SELECT * FROM oauth_tokens') && !sql.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: [existing], rowCount: 1 });
        }
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO connected_accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-1' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO oauth_tokens')) return Promise.resolve({ rows: [existing], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
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
      const upsertArgs = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO oauth_tokens'))![1] as unknown[];
      expect(upsertArgs[0]).toBe('user-1');
      expect(upsertArgs[1]).toBe('google');
      expect(upsertArgs[2]).toBe('a@example.com');
      expect(upsertArgs[3]).toBe('sub-7');
    });

    it('looks up the user\'s primary email when no existing row exists', async () => {
      // No existing oauth_tokens row.
      const saved = fakeRow({ account_email: 'fresh@example.com' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT email FROM users')) {
          return Promise.resolve({ rows: [{ email: 'fresh@example.com' }], rowCount: 1 });
        }
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-fresh' }] });
        if (sql.includes('SELECT * FROM oauth_tokens')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO connected_accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-fresh' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO oauth_tokens')) return Promise.resolve({ rows: [saved], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await oauthRepository.saveToken(
        'user-fresh',
        'google',
        'access',
        'refresh',
        new Date(),
        [],
      );

      const lookupArgs = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('SELECT email FROM users'))![1] as unknown[];
      expect(lookupArgs).toEqual(['user-fresh']);

      const upsertArgs = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO oauth_tokens'))![1] as unknown[];
      expect(upsertArgs[2]).toBe('fresh@example.com');
      expect(upsertArgs[3]).toBeNull();
    });

    it('falls back to empty account_email when the user row is missing', async () => {
      const saved = fakeRow({ account_email: '' });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-orphan' }] });
        if (sql.includes('SELECT * FROM oauth_tokens') || sql.includes('SELECT email FROM users')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('INSERT INTO connected_accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-orphan' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO oauth_tokens')) return Promise.resolve({ rows: [saved], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await oauthRepository.saveToken(
        'user-orphan',
        'google',
        'access',
        'refresh',
        new Date(),
        [],
      );

      const upsertArgs = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO oauth_tokens'))![1] as unknown[];
      expect(upsertArgs[2]).toBe('');
    });
  });
});
