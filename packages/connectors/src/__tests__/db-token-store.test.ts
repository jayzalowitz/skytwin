import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DbTokenStore } from '../oauth/db-token-store.js';
import { encrypt } from '@skytwin/credential-vault';

// Mock the google-oauth refresh function
vi.mock('../oauth/google-oauth.js', () => ({
  refreshAccessToken: vi.fn(),
}));

import { refreshAccessToken } from '../oauth/google-oauth.js';

const mockRefresh = vi.mocked(refreshAccessToken);

function createMockRepo() {
  return {
    getToken: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    updateAccessToken: vi.fn(),
    getTokenByConnectorAccount: vi.fn(),
    updateAccessTokenByConnectorAccount: vi.fn(),
    updateEncrypted: vi.fn(),
    updateEncryptedAccessToken: vi.fn(),
  };
}

const oauthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3100/callback',
};

describe('DbTokenStore', () => {
  let repo: ReturnType<typeof createMockRepo>;
  let store: DbTokenStore;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = createMockRepo();
    store = new DbTokenStore(repo, oauthConfig);
  });

  it('getToken returns null when no token exists', async () => {
    repo.getToken.mockResolvedValue(null);
    const result = await store.getToken('user1', 'google');
    expect(result).toBeNull();
    expect(repo.getToken).toHaveBeenCalledWith('user1', 'google');
  });

  it('getToken maps DB row to OAuthTokenSet', async () => {
    const expiresAt = new Date('2026-04-01T00:00:00Z');
    repo.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-456',
      expires_at: expiresAt,
      scopes: ['email', 'calendar'],
    });

    const result = await store.getToken('user1', 'google');
    expect(result).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt,
      scopes: ['email', 'calendar'],
      provider: 'google',
    });
  });

  it('saveToken delegates to repo with correct args', async () => {
    repo.saveToken.mockResolvedValue({});
    const expiresAt = new Date('2026-04-01T00:00:00Z');

    await store.saveToken('user1', 'google', {
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt,
      scopes: ['email'],
      provider: 'google',
    });

    expect(repo.saveToken).toHaveBeenCalledWith(
      'user1', 'google', 'access-123', 'refresh-456', expiresAt, ['email'],
    );
  });

  it('deleteToken delegates to repo', async () => {
    repo.deleteToken.mockResolvedValue(true);
    await store.deleteToken('user1', 'google');
    expect(repo.deleteToken).toHaveBeenCalledWith('user1', 'google');
  });

  it('refreshIfExpired returns existing token if not expired', async () => {
    const futureDate = new Date(Date.now() + 10 * 60 * 1000); // 10 min from now
    repo.getToken.mockResolvedValue({
      access_token: 'valid-token',
      refresh_token: 'refresh-456',
      expires_at: futureDate,
      scopes: ['email'],
    });

    const result = await store.refreshIfExpired('user1', 'google');
    expect(result.accessToken).toBe('valid-token');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshIfExpired refreshes token when expired', async () => {
    const pastDate = new Date(Date.now() - 60 * 1000); // 1 min ago
    repo.getToken.mockResolvedValue({
      access_token: 'expired-token',
      refresh_token: 'refresh-456',
      expires_at: pastDate,
      scopes: ['email'],
    });

    const newExpiry = new Date(Date.now() + 3600 * 1000);
    mockRefresh.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'refresh-456',
      expiresAt: newExpiry,
      scopes: ['email'],
      provider: 'google',
    });

    repo.updateAccessToken.mockResolvedValue({});

    const result = await store.refreshIfExpired('user1', 'google');
    expect(result.accessToken).toBe('new-access-token');
    expect(mockRefresh).toHaveBeenCalledWith(oauthConfig, 'refresh-456', {
      persistedScopes: ['email'],
    });
    expect(repo.updateAccessToken).toHaveBeenCalledWith(
      'user1', 'google', 'new-access-token', newExpiry,
    );
  });

  it('supplies the persisted grant when refreshing so omitted provider scope is preserved', async () => {
    const pastDate = new Date(Date.now() - 60 * 1000);
    const persistedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.modify'];
    repo.getToken.mockResolvedValue({
      access_token: 'expired-token',
      refresh_token: 'refresh-456',
      expires_at: pastDate,
      scopes: persistedScopes,
    });
    const newExpiry = new Date(Date.now() + 3600 * 1000);
    mockRefresh.mockImplementation(async (_config, refreshToken, transport) => ({
      accessToken: 'new-access-token',
      refreshToken,
      expiresAt: newExpiry,
      scopes: [...(transport?.persistedScopes ?? [])],
      provider: 'google',
    }));
    repo.updateAccessToken.mockResolvedValue({});

    const result = await store.refreshIfExpired('user1', 'google');

    expect(result.scopes).toEqual(persistedScopes);
    expect(mockRefresh).toHaveBeenCalledWith(oauthConfig, 'refresh-456', {
      persistedScopes,
    });
  });

  it('refreshIfExpired throws when no token exists', async () => {
    repo.getToken.mockResolvedValue(null);
    await expect(store.refreshIfExpired('user1', 'google')).rejects.toThrow(
      'No OAuth token found',
    );
  });

  it('refreshIfExpired refreshes token within 60s buffer', async () => {
    // Token expires in 30 seconds — within the 60s buffer
    const almostExpired = new Date(Date.now() + 30 * 1000);
    repo.getToken.mockResolvedValue({
      access_token: 'almost-expired',
      refresh_token: 'refresh-456',
      expires_at: almostExpired,
      scopes: ['email'],
    });

    const newExpiry = new Date(Date.now() + 3600 * 1000);
    mockRefresh.mockResolvedValue({
      accessToken: 'refreshed',
      refreshToken: 'refresh-456',
      expiresAt: newExpiry,
      scopes: ['email'],
      provider: 'google',
    });
    repo.updateAccessToken.mockResolvedValue({});

    const result = await store.refreshIfExpired('user1', 'google');
    expect(result.accessToken).toBe('refreshed');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reads only the fixed connector account instead of the latest user token', async () => {
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount.mockResolvedValue({
      access_token: 'account-2-token',
      refresh_token: 'account-2-refresh',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      scopes: ['gmail.readonly'],
    });

    const result = await bound.getToken('user1', 'google');

    expect(result?.accessToken).toBe('account-2-token');
    expect(repo.getTokenByConnectorAccount).toHaveBeenCalledWith('user1', 'google', 'account-2');
    expect(repo.getToken).not.toHaveBeenCalled();
  });

  it('rejects revision-bound materialization on an unbound token store', async () => {
    await expect(store.refreshIfExpiredWithRevision('user1', 'google')).rejects.toThrow(
      /requires a connector account/,
    );
    expect(repo.getToken).not.toHaveBeenCalled();
    expect(repo.getTokenByConnectorAccount).not.toHaveBeenCalled();
  });

  it('returns an unexpired bearer with its exact persisted revision as a frozen snapshot', async () => {
    const revision = '11111111-1111-4111-8111-111111111111';
    const row = {
      id: 'token-2',
      credential_revision: revision,
      access_token: 'valid-token',
      refresh_token: 'refresh',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      scopes: ['gmail.modify'],
    };
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount.mockResolvedValue(row);

    const result = await bound.refreshIfExpiredWithRevision('user1', 'google');

    expect(result).toEqual({
      accessToken: 'valid-token',
      expiresAt: row.expires_at,
      scopes: ['gmail.modify'],
      provider: 'google',
      credentialRevision: revision,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scopes)).toBe(true);
    expect(repo.getTokenByConnectorAccount).toHaveBeenCalledTimes(2);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted row', null],
    ['missing revision', {
      id: 'token-2',
      access_token: 'valid-token',
      refresh_token: 'refresh',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      scopes: ['gmail.modify'],
    }],
    ['malformed revision', {
      id: 'token-2',
      credential_revision: 'not-a-revision',
      access_token: 'valid-token',
      refresh_token: 'refresh',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      scopes: ['gmail.modify'],
    }],
  ])('rejects a %s after initial credential materialization', async (_name, secondRow) => {
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '14141414-1414-4414-8414-141414141414',
        access_token: 'valid-token',
        refresh_token: 'refresh',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        scopes: ['gmail.modify'],
      })
      .mockResolvedValueOnce(secondRow);

    await expect(bound.refreshIfExpiredWithRevision('user1', 'google')).rejects.toThrow(
      /missing its credential revision/,
    );
  });

  it('returns the new persisted revision after an account-bound refresh', async () => {
    const oldRevision = '22222222-2222-4222-8222-222222222222';
    const newRevision = '33333333-3333-4333-8333-333333333333';
    const newExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: oldRevision,
        access_token: 'expired-token',
        refresh_token: 'refresh',
        expires_at: new Date(Date.now() - 1_000),
        scopes: ['gmail.modify'],
      })
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: newRevision,
        access_token: 'new-token',
        refresh_token: 'refresh',
        expires_at: newExpiry,
        scopes: ['gmail.modify'],
      });
    mockRefresh.mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: newExpiry,
      scopes: ['gmail.modify'],
      provider: 'google',
    });
    repo.updateAccessTokenByConnectorAccount.mockResolvedValue(true);

    const result = await bound.refreshIfExpiredWithRevision('user1', 'google');

    expect(result.credentialRevision).toBe(newRevision);
    expect(result.accessToken).toBe('new-token');
    expect(repo.updateAccessTokenByConnectorAccount).toHaveBeenCalledWith(
      'user1', 'google', 'account-2', 'new-token', newExpiry, oldRevision,
    );
  });

  it('accepts a refreshed scope set whose persisted order differs', async () => {
    const newExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '12121212-1212-4212-8212-121212121212',
        access_token: 'expired-token',
        refresh_token: 'refresh',
        expires_at: new Date(Date.now() - 1_000),
        scopes: ['gmail.modify', 'openid'],
      })
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '13131313-1313-4313-8313-131313131313',
        access_token: 'new-token',
        refresh_token: 'refresh',
        expires_at: newExpiry,
        scopes: ['gmail.modify', 'openid'],
      });
    mockRefresh.mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: newExpiry,
      scopes: ['openid', 'gmail.modify'],
      provider: 'google',
    });
    repo.updateAccessTokenByConnectorAccount.mockResolvedValue(true);

    await expect(bound.refreshIfExpiredWithRevision('user1', 'google')).resolves.toMatchObject({
      credentialRevision: '13131313-1313-4313-8313-131313131313',
      scopes: ['gmail.modify', 'openid'],
    });
  });

  it('rejects a concurrent credential change between refresh and revision reread', async () => {
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '44444444-4444-4444-8444-444444444444',
        access_token: 'expired-token',
        refresh_token: 'refresh',
        expires_at: new Date(Date.now() - 1_000),
        scopes: ['gmail.modify'],
      })
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '55555555-5555-4555-8555-555555555555',
        access_token: 'winner-token',
        refresh_token: 'winner-refresh',
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        scopes: ['gmail.modify'],
      });
    mockRefresh.mockResolvedValue({
      accessToken: 'our-token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes: ['gmail.modify'],
      provider: 'google',
    });
    repo.updateAccessTokenByConnectorAccount.mockResolvedValue(true);

    await expect(bound.refreshIfExpiredWithRevision('user1', 'google')).rejects.toThrow(
      /changed during token materialization/,
    );
  });

  it('rejects a same-bearer revision race that changes the persisted scope snapshot', async () => {
    const refreshedExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '88888888-8888-4888-8888-888888888888',
        access_token: 'expired-token',
        refresh_token: 'refresh',
        expires_at: new Date(Date.now() - 1_000),
        scopes: ['gmail.modify'],
      })
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: '99999999-9999-4999-8999-999999999999',
        access_token: 'same-refreshed-token',
        refresh_token: 'refresh',
        expires_at: refreshedExpiry,
        scopes: ['gmail.readonly'],
      });
    mockRefresh.mockResolvedValue({
      accessToken: 'same-refreshed-token',
      refreshToken: 'refresh',
      expiresAt: refreshedExpiry,
      scopes: ['gmail.modify'],
      provider: 'google',
    });
    repo.updateAccessTokenByConnectorAccount.mockResolvedValue(true);

    await expect(bound.refreshIfExpiredWithRevision('user1', 'google')).rejects.toThrow(
      /changed during token materialization/,
    );
  });

  it('returns revision-bound encrypted credentials through the unlocked vault path', async () => {
    const revision = '66666666-6666-4666-8666-666666666666';
    const key = Buffer.alloc(32, 11);
    const pack = (value: string) => {
      const encrypted = encrypt(value, key);
      return Buffer.concat([encrypted.iv, encrypted.tag, encrypted.ciphertext]);
    };
    const row = {
      id: 'token-2',
      credential_revision: revision,
      access_token: null,
      refresh_token: null,
      encrypted_access_token: pack('valid-token'),
      encrypted_refresh_token: pack('refresh'),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      scopes: ['gmail.modify'],
    };
    const audit = { recordAccess: vi.fn() };
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    bound.setKeyCache({ get: () => key, has: () => true, set: () => {} });
    bound.setAuditLog(audit, 'mutation-worker');
    repo.getTokenByConnectorAccount.mockResolvedValue(row);

    await expect(bound.refreshIfExpiredWithRevision('user1', 'google')).resolves.toMatchObject({
      accessToken: 'valid-token',
      credentialRevision: revision,
    });
    expect(audit.recordAccess).toHaveBeenCalledTimes(2);
    expect(audit.recordAccess).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user1',
      actor: 'mutation-worker',
      action: 'decrypt_oauth_token',
      resourceId: 'token-2',
    }));
    expect(repo.updateEncrypted).not.toHaveBeenCalled();
  });

  it('returns the newly persisted revision after an encrypted credential refresh', async () => {
    const oldRevision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newRevision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const key = Buffer.alloc(32, 17);
    const pack = (value: string) => {
      const encrypted = encrypt(value, key);
      return Buffer.concat([encrypted.iv, encrypted.tag, encrypted.ciphertext]);
    };
    const newExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    bound.setKeyCache({ get: () => key, has: () => true, set: () => {} });
    repo.getTokenByConnectorAccount
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: oldRevision,
        access_token: null,
        refresh_token: null,
        encrypted_access_token: pack('expired-token'),
        encrypted_refresh_token: pack('refresh'),
        expires_at: new Date(Date.now() - 1_000),
        scopes: ['gmail.modify'],
      })
      .mockResolvedValueOnce({
        id: 'token-2',
        credential_revision: newRevision,
        access_token: null,
        refresh_token: null,
        encrypted_access_token: pack('new-token'),
        encrypted_refresh_token: pack('refresh'),
        expires_at: newExpiry,
        scopes: ['gmail.modify'],
      });
    mockRefresh.mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: newExpiry,
      scopes: ['gmail.modify'],
      provider: 'google',
    });
    repo.updateEncryptedAccessToken.mockResolvedValue(true);

    await expect(bound.refreshIfExpiredWithRevision('user1', 'google')).resolves.toMatchObject({
      accessToken: 'new-token',
      credentialRevision: newRevision,
    });
    expect(repo.updateEncryptedAccessToken).toHaveBeenCalledWith(
      'token-2', expect.any(Buffer), newExpiry, oldRevision,
    );
  });

  it('preserves ordinary refreshIfExpired lazy migration behavior', async () => {
    const revision = '77777777-7777-4777-8777-777777777777';
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    bound.setKeyCache({ get: () => Buffer.alloc(32, 13), has: () => true, set: () => {} });
    repo.getTokenByConnectorAccount.mockResolvedValue({
      id: 'token-2',
      credential_revision: revision,
      access_token: 'valid-token',
      refresh_token: 'refresh',
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      scopes: ['gmail.modify'],
    });
    repo.updateEncrypted.mockResolvedValue(true);

    await expect(bound.refreshIfExpired('user1', 'google')).resolves.toMatchObject({
      accessToken: 'valid-token',
    });
    await vi.waitFor(() => expect(repo.updateEncrypted).toHaveBeenCalledOnce());
    expect(repo.updateEncrypted).toHaveBeenCalledWith(
      'token-2', expect.objectContaining({ keyVersion: 1 }), revision,
    );
  });

  it('fails refresh when disconnect wins the active-account update race', async () => {
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    repo.getTokenByConnectorAccount.mockResolvedValue({
      id: 'token-2',
      credential_revision: '11111111-1111-4111-8111-111111111111',
      access_token: 'expired',
      refresh_token: 'refresh',
      expires_at: new Date(Date.now() - 1_000),
      scopes: ['gmail.readonly'],
    });
    mockRefresh.mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['gmail.readonly'],
      provider: 'google',
    });
    repo.updateAccessTokenByConnectorAccount.mockResolvedValue(null);

    await expect(bound.refreshIfExpired('user1', 'google')).rejects.toThrow(
      /disconnected during token refresh/,
    );
    expect(repo.getTokenByConnectorAccount).toHaveBeenCalledTimes(1);
    expect(repo.updateAccessTokenByConnectorAccount).toHaveBeenCalledWith(
      'user1', 'google', 'account-2', 'new-token', expect.any(Date),
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('persists one encrypted write when refreshing an unlocked plaintext credential', async () => {
    const revision = '22222222-2222-4222-8222-222222222222';
    const newExpiry = new Date(Date.now() + 3_600_000);
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    bound.setKeyCache({
      get: () => Buffer.alloc(32, 7),
      has: () => true,
      set: () => {},
    });
    repo.getTokenByConnectorAccount.mockResolvedValue({
      id: 'token-2',
      credential_revision: revision,
      access_token: 'expired',
      refresh_token: 'refresh',
      expires_at: new Date(Date.now() - 1_000),
      scopes: ['gmail.readonly'],
    });
    repo.updateEncrypted.mockResolvedValue(true);
    mockRefresh.mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: newExpiry,
      scopes: ['gmail.readonly'],
      provider: 'google',
    });

    await expect(bound.refreshIfExpired('user1', 'google')).resolves.toMatchObject({
      accessToken: 'new-token',
    });
    expect(repo.updateEncrypted).toHaveBeenCalledOnce();
    expect(repo.updateEncrypted).toHaveBeenCalledWith('token-2', expect.objectContaining({
      expiresAt: newExpiry,
      keyVersion: 1,
    }), revision);
    expect(repo.updateAccessTokenByConnectorAccount).not.toHaveBeenCalled();
    expect(repo.getTokenByConnectorAccount).toHaveBeenCalledTimes(1);
  });

  it('holds one vault key snapshot across an encrypted refresh', async () => {
    const revision = '33333333-3333-4333-8333-333333333333';
    const key = Buffer.alloc(32, 9);
    const pack = (value: string) => {
      const encrypted = encrypt(value, key);
      return Buffer.concat([encrypted.iv, encrypted.tag, encrypted.ciphertext]);
    };
    const keyGet = vi.fn()
      .mockReturnValueOnce(key)
      .mockReturnValueOnce(null);
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    bound.setKeyCache({ get: keyGet, has: () => true, set: () => {} });
    repo.getTokenByConnectorAccount.mockResolvedValue({
      id: 'token-2',
      credential_revision: revision,
      access_token: null,
      refresh_token: null,
      encrypted_access_token: pack('expired'),
      encrypted_refresh_token: pack('refresh'),
      expires_at: new Date(Date.now() - 1_000),
      scopes: ['gmail.readonly'],
    });
    repo.updateEncryptedAccessToken.mockResolvedValue(true);
    mockRefresh.mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['gmail.readonly'],
      provider: 'google',
    });

    await expect(bound.refreshIfExpired('user1', 'google')).resolves.toMatchObject({
      accessToken: 'new-token',
    });

    expect(keyGet).toHaveBeenCalledOnce();
    expect(repo.updateEncryptedAccessToken).toHaveBeenCalledWith(
      'token-2', expect.any(Buffer), expect.any(Date), revision,
    );
    expect(repo.updateAccessTokenByConnectorAccount).not.toHaveBeenCalled();
  });

  it('fails before provider refresh when an encrypted credential is locked', async () => {
    const bound = new DbTokenStore(repo, oauthConfig, undefined, 'account-2');
    bound.setKeyCache({ get: () => null, has: () => false, set: () => {} });
    repo.getTokenByConnectorAccount.mockResolvedValue({
      id: 'token-2',
      credential_revision: '44444444-4444-4444-8444-444444444444',
      access_token: null,
      refresh_token: null,
      encrypted_access_token: Buffer.alloc(32),
      encrypted_refresh_token: Buffer.alloc(32),
      expires_at: new Date(Date.now() - 1_000),
      scopes: ['gmail.readonly'],
    });

    await expect(bound.refreshIfExpired('user1', 'google')).rejects.toThrow(
      /unlock the credential vault/,
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(repo.updateAccessTokenByConnectorAccount).not.toHaveBeenCalled();
  });
});
