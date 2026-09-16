import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbTokenStore } from '../oauth/db-token-store.js';
import { encrypt } from '@skytwin/credential-vault';

const microsoftConfig = {
  clientId: 'microsoft-client',
  clientSecret: '',
  redirectUri: 'http://localhost/callback',
  tenant: 'common',
};

function createMockRepo() {
  return {
    getToken: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
    updateAccessToken: vi.fn(),
    updateAccessTokenIfCurrent: vi.fn().mockResolvedValue(true),
    rotateTokenIfCurrent: vi.fn().mockResolvedValue({}),
    validateVaultSession: vi.fn().mockResolvedValue(true),
    getVaultAuthorityState: vi.fn().mockResolvedValue({
      state: 'absent', generation: null, keyVersion: null,
    }),
    updateEncryptedAccessTokenIfCurrent: vi.fn().mockResolvedValue(true),
    rotateEncryptedTokenIfCurrent: vi.fn().mockResolvedValue({}),
  };
}

function packed(value: string, key: Buffer): Buffer {
  const encrypted = encrypt(value, key);
  return Buffer.concat([encrypted.iv, encrypted.tag, encrypted.ciphertext]);
}

describe('DbTokenStore Microsoft refresh scope authority', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['omitted', {}],
    ['empty', { scope: '' }],
  ])('preserves persisted scopes for an expired grant when provider scope is %s', async (
    _name,
    scopeResponse,
  ) => {
    const repo = createMockRepo();
    repo.getToken.mockResolvedValue({
      id: 'token-row',
      credential_revision: 'revision-1',
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: new Date(Date.now() - 60_000),
      scopes: ['Mail.Read', 'offline_access'],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        expires_in: 3600,
        ...scopeResponse,
      }),
    });
    const store = new DbTokenStore(repo, undefined, microsoftConfig);

    const result = await store.refreshIfExpired('user-1', 'microsoft');

    expect(result.scopes).toEqual(['Mail.Read', 'offline_access']);
    expect(repo.updateAccessTokenIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'token-row',
      userId: 'user-1',
      provider: 'microsoft',
      expectedCredentialRevision: 'revision-1',
      accessToken: 'refreshed-token',
    }));
    expect(repo.updateAccessToken).not.toHaveBeenCalled();
  });

  it('rejects an explicit changed scope set before writing credentials', async () => {
    const repo = createMockRepo();
    repo.getToken.mockResolvedValue({
      id: 'token-row',
      credential_revision: 'revision-1',
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: new Date(Date.now() - 60_000),
      scopes: ['Mail.Read', 'offline_access'],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'narrower-token',
        expires_in: 3600,
        scope: 'offline_access',
      }),
    });
    const store = new DbTokenStore(repo, undefined, microsoftConfig);

    await expect(store.refreshIfExpired('user-1', 'microsoft')).rejects.toThrow(
      /changed or invalid scope grant/,
    );
    expect(repo.updateAccessToken).not.toHaveBeenCalled();
    expect(repo.updateAccessTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('persists a rotated plaintext refresh token under the exact credential revision', async () => {
    const repo = createMockRepo();
    repo.getToken.mockResolvedValue({
      id: 'token-row',
      credential_revision: 'revision-1',
      access_token: 'expired-token',
      refresh_token: 'old-refresh-token',
      expires_at: new Date(Date.now() - 60_000),
      scopes: ['Mail.Read', 'offline_access'],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        scope: 'Mail.Read offline_access',
      }),
    });
    const store = new DbTokenStore(repo, undefined, microsoftConfig);

    await expect(store.refreshIfExpired('user-1', 'microsoft')).resolves.toMatchObject({
      accessToken: 'refreshed-token',
      refreshToken: 'rotated-refresh-token',
    });

    expect(repo.rotateTokenIfCurrent).toHaveBeenCalledWith({
      id: 'token-row',
      userId: 'user-1',
      provider: 'microsoft',
      expectedCredentialRevision: 'revision-1',
      expectedAccessToken: 'expired-token',
      expectedRefreshToken: 'old-refresh-token',
      accessToken: 'refreshed-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: expect.any(Date),
      scopes: ['Mail.Read', 'offline_access'],
    });
    expect(repo.updateAccessTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('persists encrypted refresh-token rotation with both revision and vault-generation fences', async () => {
    const key = Buffer.alloc(32, 7);
    const repo = createMockRepo();
    repo.getVaultAuthorityState.mockResolvedValue({
      state: 'unlocked', generation: 'vault-generation-1', keyVersion: 1,
    });
    repo.getToken.mockResolvedValue({
      id: 'token-row',
      credential_revision: 'revision-1',
      access_token: null,
      refresh_token: null,
      expires_at: new Date(Date.now() - 60_000),
      scopes: ['Mail.Read', 'offline_access'],
      encrypted_access_token: packed('expired-token', key),
      encrypted_refresh_token: packed('old-refresh-token', key),
      encryption_key_version: 1,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        scope: 'Mail.Read offline_access',
      }),
    });
    const store = new DbTokenStore(repo, undefined, microsoftConfig);
    store.setKeyCache({
      get: vi.fn(() => key),
      getGeneration: vi.fn(() => 'vault-generation-1'),
      has: vi.fn(() => true),
      set: vi.fn(),
    });

    await expect(store.refreshIfExpired('user-1', 'microsoft')).resolves.toMatchObject({
      refreshToken: 'rotated-refresh-token',
    });

    expect(repo.validateVaultSession).toHaveBeenCalledWith('user-1', 'vault-generation-1');
    expect(repo.rotateEncryptedTokenIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'token-row',
      expectedCredentialRevision: 'revision-1',
      expectedVaultGeneration: 'vault-generation-1',
      encryptedAccessToken: expect.any(Buffer),
      encryptedRefreshToken: expect.any(Buffer),
    }));
    expect(repo.updateEncryptedAccessTokenIfCurrent).not.toHaveBeenCalled();
  });
});
