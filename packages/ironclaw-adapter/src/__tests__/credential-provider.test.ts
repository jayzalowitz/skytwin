import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockOauthRepository, mockCredentialDispatchLeaseRepository, mockCredentialVaultMetaRepository, mockServiceCredentialRepository, mockLoadConfig, mockReadColumn } = vi.hoisted(() => ({
  mockOauthRepository: {
    getToken: vi.fn(),
    getTokenByAccount: vi.fn(),
    rotateTokenIfCurrent: vi.fn(),
    rotateEncryptedTokenIfCurrent: vi.fn(),
    updateEncryptedIfCurrent: vi.fn(),
  },
  mockCredentialDispatchLeaseRepository: {
    bindCredential: vi.fn(),
    terminalize: vi.fn(),
  },
  mockCredentialVaultMetaRepository: { getForUser: vi.fn() },
  mockServiceCredentialRepository: {
    getAsMap: vi.fn(),
  },
  mockLoadConfig: vi.fn(),
  mockReadColumn: vi.fn((_encrypted: Buffer | null, plaintext: string | null) => ({
    success: true as const, value: plaintext ?? '',
  })),
}));

vi.mock('@skytwin/db', () => ({
  oauthRepository: mockOauthRepository,
  executionDispatchLeaseRepository: mockCredentialDispatchLeaseRepository,
  credentialVaultMetaRepository: mockCredentialVaultMetaRepository,
  serviceCredentialRepository: mockServiceCredentialRepository,
  readColumn: mockReadColumn,
  encryptColumn: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

import { DbCredentialProvider, NoopCredentialProvider } from '../credential-provider.js';

describe('DbCredentialProvider', () => {
  const fetchMock = vi.fn();
  let provider: DbCredentialProvider;

  beforeEach(() => {
    provider = new DbCredentialProvider();
    vi.stubGlobal('fetch', fetchMock);
    mockLoadConfig.mockReturnValue({
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    mockOauthRepository.getToken.mockReset();
    mockOauthRepository.getTokenByAccount.mockReset();
    mockOauthRepository.rotateTokenIfCurrent.mockReset();
    mockOauthRepository.rotateEncryptedTokenIfCurrent.mockReset();
    mockOauthRepository.updateEncryptedIfCurrent.mockReset();
    mockCredentialDispatchLeaseRepository.bindCredential.mockReset();
    mockCredentialDispatchLeaseRepository.terminalize.mockReset();
    mockCredentialVaultMetaRepository.getForUser.mockReset();
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue(null);
    mockServiceCredentialRepository.getAsMap.mockReset();
    mockLoadConfig.mockReset();
    mockReadColumn.mockReset();
    mockReadColumn.mockImplementation((_encrypted: Buffer | null, plaintext: string | null) => ({
      success: true as const, value: plaintext ?? '',
    }));
  });

  it('returns a valid (non-expired) token directly without refresh', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() + 120_000),
      scopes: ['email', 'calendar'],
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({ success: true, accessToken: 'access-123' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOauthRepository.rotateTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('selects the exact account and materializes a vault-encrypted access token', async () => {
    const audit = { recordAccess: vi.fn() };
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7), getGeneration: () => 'vault-generation-1',
    }, audit, 'api');
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'unlocked', vault_generation: 'vault-generation-1',
    });
    mockOauthRepository.getTokenByAccount.mockResolvedValue({
      id: 'encrypted-row', credential_revision: 'encrypted-revision',
      account_email: 'work@example.com', access_token: null, refresh_token: null,
      encrypted_access_token: Buffer.from('ciphertext'),
      encrypted_refresh_token: Buffer.from('refresh-ciphertext'),
      expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
    });
    mockReadColumn.mockReturnValueOnce({ success: true, value: 'decrypted-access' });

    await expect(provider.getAccessToken(
      'user_1', 'google', 'work@example.com',
    )).resolves.toMatchObject({
      success: true,
      accessToken: 'decrypted-access',
      oauthTokenId: 'encrypted-row',
      credentialRevision: 'encrypted-revision',
    });
    expect(mockOauthRepository.getTokenByAccount).toHaveBeenCalledWith(
      'user_1', 'google', 'work@example.com',
    );
    expect(mockOauthRepository.getToken).not.toHaveBeenCalled();
    expect(audit.recordAccess).toHaveBeenCalledWith({
      userId: 'user_1',
      actor: 'api',
      action: 'decrypt_oauth_token',
      resourceType: 'oauth_token',
      resourceId: 'encrypted-row',
    });
  });

  it('does not use a plaintext grant for a vault-enabled user while the vault is locked', async () => {
    provider = new DbCredentialProvider({ get: () => null });
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'plaintext-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: 'must-not-dispatch', refresh_token: 'must-not-refresh',
      encrypted_access_token: null, encrypted_refresh_token: null,
      expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      current_key_version: 2, vault_state: 'locked', vault_generation: 'vault-generation-2',
    });

    await expect(provider.getAccessToken('user_1', 'google')).resolves.toEqual({
      success: false,
      error: 'OAuth credential is unavailable while the credential vault is locked.',
    });
    expect(mockReadColumn).not.toHaveBeenCalled();
  });

  it('migrates a live legacy plaintext grant before returning it from an initialized vault', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7), getGeneration: () => 'vault-generation-2',
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      current_key_version: 2, vault_state: 'unlocked', vault_generation: 'vault-generation-2',
    });
    mockOauthRepository.getToken
      .mockResolvedValueOnce({
        id: 'plaintext-row', credential_revision: 'revision-1', account_email: 'a@example.com',
        access_token: 'legacy-access', refresh_token: 'legacy-refresh',
        encrypted_access_token: null, encrypted_refresh_token: null,
        expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
      })
      .mockResolvedValueOnce({
        id: 'plaintext-row', credential_revision: 'revision-2', account_email: 'a@example.com',
        access_token: null, refresh_token: null,
        encrypted_access_token: Buffer.from('encrypted-access'),
        encrypted_refresh_token: Buffer.from('encrypted-refresh'),
        expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
      });
    mockOauthRepository.updateEncryptedIfCurrent.mockResolvedValue(true);
    mockReadColumn.mockReturnValueOnce({ success: true, value: 'legacy-access' });

    await expect(provider.getAccessToken('user_1', 'google')).resolves.toMatchObject({
      success: true, accessToken: 'legacy-access',
      oauthTokenId: 'plaintext-row', credentialRevision: 'revision-2',
      vaultGeneration: 'vault-generation-2',
    });
    expect(mockOauthRepository.updateEncryptedIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'plaintext-row', expectedCredentialRevision: 'revision-1',
      expectedVaultGeneration: 'vault-generation-2', keyVersion: 2,
      encryptedAccessToken: Buffer.from('encrypted:legacy-access'),
      encryptedRefreshToken: Buffer.from('encrypted:legacy-refresh'),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockOauthRepository.rotateTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('migrates an expired legacy grant before refreshing it into encrypted storage', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7), getGeneration: () => 'vault-generation-2',
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      current_key_version: 2, vault_state: 'unlocked', vault_generation: 'vault-generation-2',
    });
    mockOauthRepository.getToken
      .mockResolvedValueOnce({
        id: 'plaintext-row', credential_revision: 'revision-1', account_email: 'a@example.com',
        access_token: 'expired-access', refresh_token: 'legacy-refresh',
        encrypted_access_token: null, encrypted_refresh_token: null,
        expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
      })
      .mockResolvedValueOnce({
        id: 'plaintext-row', credential_revision: 'revision-2', account_email: 'a@example.com',
        access_token: null, refresh_token: null,
        encrypted_access_token: Buffer.from('encrypted-access'),
        encrypted_refresh_token: Buffer.from('encrypted-refresh'),
        expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
      });
    mockOauthRepository.updateEncryptedIfCurrent.mockResolvedValue(true);
    mockReadColumn
      .mockReturnValueOnce({ success: true, value: 'expired-access' })
      .mockReturnValueOnce({ success: true, value: 'legacy-refresh' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'refreshed-access', expires_in: 3600 }),
    });
    mockOauthRepository.rotateEncryptedTokenIfCurrent.mockResolvedValue({
      id: 'plaintext-row', credential_revision: 'revision-3', account_email: 'a@example.com',
    });

    await expect(provider.getAccessToken('user_1', 'google')).resolves.toMatchObject({
      success: true, accessToken: 'refreshed-access', credentialRevision: 'revision-3',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockOauthRepository.rotateEncryptedTokenIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'plaintext-row', expectedCredentialRevision: 'revision-2',
        expectedVaultGeneration: 'vault-generation-2',
        encryptedAccessToken: Buffer.from('encrypted:refreshed-access'),
      }),
    );
    expect(mockOauthRepository.rotateTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('never dispatches a plaintext access sibling once refresh material is encrypted', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7), getGeneration: () => 'vault-generation-1',
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'unlocked', vault_generation: 'vault-generation-1',
    });
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'partial-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: 'stale-plaintext-access', refresh_token: null,
      encrypted_access_token: null, encrypted_refresh_token: Buffer.from('encrypted-refresh'),
      expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
    });
    mockReadColumn
      .mockReturnValueOnce({ success: true, value: '' })
      .mockReturnValueOnce({ success: true, value: 'decrypted-refresh' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'refreshed-access', expires_in: 3600 }),
    });
    mockOauthRepository.rotateEncryptedTokenIfCurrent.mockResolvedValue({
      access_token: null,
      encrypted_access_token: Buffer.from('encrypted-refreshed-access'),
      credential_revision: 'revision-2',
      account_email: 'a@example.com',
    });
    mockReadColumn.mockReturnValueOnce({ success: true, value: 'refreshed-access' });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toMatchObject({ success: true, accessToken: 'refreshed-access' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockReadColumn).not.toHaveBeenCalledWith(
      null,
      'stale-plaintext-access',
      expect.anything(),
    );
  });

  it('never refreshes with a plaintext sibling once access material is encrypted', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7), getGeneration: () => 'vault-generation-1',
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'unlocked', vault_generation: 'vault-generation-1',
    });
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'partial-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: null, refresh_token: 'stale-plaintext-refresh',
      encrypted_access_token: Buffer.from('encrypted-access'), encrypted_refresh_token: null,
      expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
    });
    mockReadColumn
      .mockReturnValueOnce({ success: true, value: 'expired-decrypted-access' })
      .mockReturnValueOnce({ success: true, value: '' });

    await expect(provider.getAccessToken('user_1', 'google')).resolves.toEqual({
      success: false,
      error: 'Google OAuth token is expired and has no refresh token. Reconnect Google.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReadColumn).not.toHaveBeenCalledWith(
      null,
      'stale-plaintext-refresh',
      expect.anything(),
    );
  });

  it('rejects another process cached under the generation preceding a durable lock', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7),
      getGeneration: () => 'generation-before-lock',
    });
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'encrypted-row', credential_revision: 'revision-after-lock',
      account_email: 'a@example.com', access_token: null, refresh_token: null,
      encrypted_access_token: Buffer.from('ciphertext'),
      encrypted_refresh_token: Buffer.from('refresh-ciphertext'),
      expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'locked',
      vault_generation: 'generation-after-lock',
    });

    await expect(provider.getAccessToken('user_1', 'google')).resolves.toEqual({
      success: false,
      error: 'OAuth credential is unavailable while the credential vault is locked.',
    });
    expect(mockReadColumn).not.toHaveBeenCalled();

    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'unlocked',
      vault_generation: 'generation-after-later-unlock',
    });
    await expect(provider.getAccessToken('user_1', 'google')).resolves.toMatchObject({ success: false });
    expect(mockReadColumn).not.toHaveBeenCalled();
  });

  it('returns error when no token found for provider', async () => {
    mockOauthRepository.getToken.mockResolvedValue(null);

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'No OAuth token found for google. Connect the account first.',
    });
  });

  it('returns error when provider is not google and token is expired', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['scope1'],
    });

    const result = await provider.getAccessToken('user_1', 'outlook');

    expect(result).toEqual({
      success: false,
      error: 'OAuth refresh is not implemented for outlook. Reconnect the account.',
    });
  });

  it('returns error when google token is expired and has no refresh_token', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'access-123',
      refresh_token: null,
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'Google OAuth token is expired and has no refresh token. Reconnect Google.',
    });
  });

  it('successfully refreshes an expired Google token', async () => {
    const updatedAt = new Date('2026-09-13T01:00:00Z');
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'token-row-1',
      credential_revision: 'revision-before-refresh',
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email', 'calendar'],
      updated_at: updatedAt,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-456',
        expires_in: 3600,
        refresh_token: 'new-refresh-789',
      }),
    });

    mockOauthRepository.rotateTokenIfCurrent.mockResolvedValue({
      access_token: 'new-access-456',
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({ success: true, accessToken: 'new-access-456' });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');

    expect(mockOauthRepository.rotateTokenIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
        provider: 'google',
        id: 'token-row-1',
        expectedAccessToken: 'old-access',
        expectedRefreshToken: 'refresh-123',
        expectedCredentialRevision: 'revision-before-refresh',
        accessToken: 'new-access-456',
        refreshToken: 'new-refresh-789',
        expiresAt: expect.any(Date),
        scopes: ['email', 'calendar'],
      }),
    );
  });

  it('refreshes an expired vault credential with an exact encrypted revision CAS', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 9), getGeneration: () => 'vault-generation-9',
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'unlocked', vault_generation: 'vault-generation-9',
    });
    mockOauthRepository.getTokenByAccount.mockResolvedValue({
      id: 'encrypted-row', credential_revision: 'encrypted-revision',
      account_email: 'work@example.com', access_token: null, refresh_token: null,
      encrypted_access_token: Buffer.from('old-access-cipher'),
      encrypted_refresh_token: Buffer.from('old-refresh-cipher'),
      expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
    });
    mockReadColumn
      .mockReturnValueOnce({ success: true, value: 'expired-access' })
      .mockReturnValueOnce({ success: true, value: 'decrypted-refresh' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    });
    mockOauthRepository.rotateEncryptedTokenIfCurrent.mockResolvedValue({
      id: 'encrypted-row', credential_revision: 'new-revision', account_email: 'work@example.com',
    });

    await expect(provider.getAccessToken(
      'user_1', 'google', 'work@example.com',
    )).resolves.toMatchObject({ success: true, accessToken: 'new-access' });
    expect(mockOauthRepository.rotateEncryptedTokenIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'encrypted-row', expectedCredentialRevision: 'encrypted-revision',
        expectedVaultGeneration: 'vault-generation-9',
        encryptedAccessToken: Buffer.from('encrypted:new-access'),
      }),
    );
    expect(mockOauthRepository.rotateTokenIfCurrent).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'rotation'])('fails closed when a %s wins while refresh is in flight', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'token-row-1',
      credential_revision: 'revision-before-refresh',
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
      updated_at: new Date('2026-09-13T01:00:00Z'),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'late-access', expires_in: 3600 }),
    });
    // A missing row or changed revision/refresh token both make the exact
    // compare-and-swap update return no row.
    mockOauthRepository.rotateTokenIfCurrent.mockResolvedValue(null);

    await expect(provider.getAccessToken('user_1', 'google')).resolves.toEqual({
      success: false,
      error: 'OAuth credential changed or disconnected while refresh was in flight. Reconnect and retry.',
    });
  });

  it('coalesces implicit and explicit account aliases for one credential refresh', async () => {
    const expired = {
      id: 'token-row',
      credential_revision: 'revision-1',
      account_email: 'work@example.com',
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    };
    mockOauthRepository.getToken.mockResolvedValue(expired);
    mockOauthRepository.getTokenByAccount.mockResolvedValue(expired);

    let resolveRefresh!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    fetchMock.mockReturnValue(pendingFetch);

    mockOauthRepository.rotateTokenIfCurrent.mockResolvedValue({
      access_token: 'new-access-456',
    });

    // Fire two concurrent requests
    const promise1 = provider.getAccessToken('user_1', 'google');
    const promise2 = provider.getAccessToken('user_1', 'google', 'work@example.com');

    // Resolve the single fetch call
    resolveRefresh({
      ok: true,
      json: async () => ({
        access_token: 'new-access-456',
        expires_in: 3600,
      }),
    } as Response);

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toEqual({ success: true, accessToken: 'new-access-456' });
    expect(result2).toEqual({ success: true, accessToken: 'new-access-456' });
    // fetch should have been called only once despite two getAccessToken calls
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('failed refresh clears the lock so subsequent calls can retry', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    // First attempt: fetch fails
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const failResult = await provider.getAccessToken('user_1', 'google');
    expect(failResult).toEqual({
      success: false,
      error: 'Google OAuth refresh failed: HTTP 500 Internal Server Error',
    });

    // Second attempt: fetch succeeds (lock should be cleared)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'retry-access',
        expires_in: 3600,
      }),
    });

    mockOauthRepository.rotateTokenIfCurrent.mockResolvedValue({
      access_token: 'retry-access',
    });

    const retryResult = await provider.getAccessToken('user_1', 'google');
    expect(retryResult).toEqual({ success: true, accessToken: 'retry-access' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to DB credentials when loadConfig returns empty googleClientId/googleClientSecret', async () => {
    mockLoadConfig.mockReturnValue({
      googleClientId: '',
      googleClientSecret: '',
    });

    mockServiceCredentialRepository.getAsMap.mockResolvedValue({
      client_id: 'db-client-id',
      client_secret: 'db-client-secret',
    });

    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-from-db-creds',
        expires_in: 3600,
      }),
    });

    mockOauthRepository.rotateTokenIfCurrent.mockResolvedValue({
      access_token: 'new-access-from-db-creds',
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({ success: true, accessToken: 'new-access-from-db-creds' });
    expect(mockServiceCredentialRepository.getAsMap).toHaveBeenCalledWith('google');

    // Verify the fetch used the DB credentials
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('db-client-id');
    expect(body.get('client_secret')).toBe('db-client-secret');
  });

  it('returns error when neither config nor DB has Google client credentials', async () => {
    mockLoadConfig.mockReturnValue({
      googleClientId: '',
      googleClientSecret: '',
    });

    mockServiceCredentialRepository.getAsMap.mockResolvedValue({});

    mockOauthRepository.getToken.mockResolvedValue({
      access_token: 'old-access',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['email'],
    });

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'Google OAuth client credentials are not configured.',
    });
  });

  it('uses the readiness token only after the lease binds its exact row revision', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'token-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: 'read-token',
      refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() + 120_000),
      scopes: ['email'],
    });
    mockCredentialDispatchLeaseRepository.bindCredential.mockResolvedValue({
      success: true,
      grant: {
        accountEmail: 'a@example.com',
        oauthTokenId: 'token-row',
        capability: 'capability',
        leaseGeneration: 'generation',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const input = {
      userId: 'user_1', provider: 'google', decisionId: 'decision_1',
      actionId: 'action_1', executionPlanId: 'plan_1', authorityRevision: 'authority-1',
      policyAuthorityRevision: 'policy-authority-1',
      dispatchCapability: 'dispatch-capability', dispatchLeaseGeneration: 'dispatch-generation',
    };

    await expect(provider.startDispatch(input)).resolves.toMatchObject({
      success: true,
      accessToken: 'read-token',
      capability: 'capability',
    });
    expect(mockCredentialDispatchLeaseRepository.bindCredential).toHaveBeenCalledWith({
      userId: input.userId, provider: input.provider, decisionId: input.decisionId,
      actionId: input.actionId, executionPlanId: input.executionPlanId,
      capability: 'dispatch-capability', leaseGeneration: 'dispatch-generation',
      accountEmail: 'a@example.com',
      expectedOAuthTokenId: 'token-row',
      expectedCredentialRevision: 'revision-1',
      expectedVaultGeneration: undefined,
    });
  });

  it('refreshes an expired token under its exact generic dispatch capability before binding', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'token-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: 'expired-access', refresh_token: 'refresh-123',
      expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'fresh-access', expires_in: 3600,
    }), { status: 200 }));
    mockOauthRepository.rotateTokenIfCurrent.mockResolvedValue({
      id: 'token-row', credential_revision: 'revision-2', account_email: 'a@example.com',
    });
    mockCredentialDispatchLeaseRepository.bindCredential.mockResolvedValue({
      success: true,
      grant: {
        accountEmail: 'a@example.com', oauthTokenId: 'token-row',
        capability: 'dispatch-capability', leaseGeneration: 'dispatch-generation',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const input = {
      userId: 'user_1', provider: 'google', decisionId: 'decision_1',
      actionId: 'action_1', executionPlanId: 'plan_1', authorityRevision: 'authority-1',
      policyAuthorityRevision: 'policy-authority-1',
      dispatchCapability: 'dispatch-capability', dispatchLeaseGeneration: 'dispatch-generation',
    };

    await expect(provider.startDispatch(input)).resolves.toMatchObject({
      success: true, accessToken: 'fresh-access',
    });
    expect(mockOauthRepository.rotateTokenIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCredentialRevision: 'revision-1',
        dispatchProof: {
          userId: 'user_1', provider: 'google', executionPlanId: 'plan_1',
          capability: 'dispatch-capability', leaseGeneration: 'dispatch-generation',
        },
      }),
    );
    expect(mockCredentialDispatchLeaseRepository.bindCredential).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCredentialRevision: 'revision-2' }),
    );
  });

  it('migrates a legacy plaintext token under its exact generic dispatch capability', async () => {
    provider = new DbCredentialProvider({
      get: () => Buffer.alloc(32, 7),
      getGeneration: () => 'vault-generation-1',
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      current_key_version: 2, vault_state: 'unlocked', vault_generation: 'vault-generation-1',
    });
    mockOauthRepository.getToken
      .mockResolvedValueOnce({
        id: 'legacy-row', credential_revision: 'revision-1', account_email: 'a@example.com',
        access_token: 'legacy-access', refresh_token: 'legacy-refresh',
        encrypted_access_token: null, encrypted_refresh_token: null,
        expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
      })
      .mockResolvedValueOnce({
        id: 'legacy-row', credential_revision: 'revision-2', account_email: 'a@example.com',
        access_token: null, refresh_token: null,
        encrypted_access_token: Buffer.from('ciphertext'),
        encrypted_refresh_token: Buffer.from('refresh-ciphertext'),
        expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
      });
    mockOauthRepository.updateEncryptedIfCurrent.mockResolvedValue(true);
    mockReadColumn.mockReturnValueOnce({ success: true, value: 'legacy-access' });
    mockCredentialDispatchLeaseRepository.bindCredential.mockResolvedValue({
      success: true,
      grant: {
        accountEmail: 'a@example.com', oauthTokenId: 'legacy-row',
        capability: 'dispatch-capability', leaseGeneration: 'dispatch-generation',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const input = {
      userId: 'user_1', provider: 'google', decisionId: 'decision_1',
      actionId: 'action_1', executionPlanId: 'plan_1', authorityRevision: 'authority-1',
      policyAuthorityRevision: 'policy-authority-1',
      dispatchCapability: 'dispatch-capability', dispatchLeaseGeneration: 'dispatch-generation',
    };

    await expect(provider.startDispatch(input)).resolves.toMatchObject({
      success: true, accessToken: 'legacy-access',
    });
    expect(mockOauthRepository.updateEncryptedIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCredentialRevision: 'revision-1',
        dispatchProof: {
          userId: 'user_1', provider: 'google', executionPlanId: 'plan_1',
          capability: 'dispatch-capability', leaseGeneration: 'dispatch-generation',
        },
      }),
    );
    expect(mockCredentialDispatchLeaseRepository.bindCredential).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCredentialRevision: 'revision-2' }),
    );
  });

  it('fails closed when the vault key expires during credential binding', async () => {
    let keyLive = true;
    provider = new DbCredentialProvider({
      get: () => keyLive ? Buffer.alloc(32, 7) : null,
      getGeneration: () => keyLive ? 'vault-generation-1' : null,
    });
    mockCredentialVaultMetaRepository.getForUser.mockResolvedValue({
      vault_state: 'unlocked', vault_generation: 'vault-generation-1',
    });
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'encrypted-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: null, refresh_token: null,
      encrypted_access_token: Buffer.from('ciphertext'),
      encrypted_refresh_token: Buffer.from('refresh-ciphertext'),
      expires_at: new Date(Date.now() + 120_000), scopes: [],
    });
    mockReadColumn.mockReturnValueOnce({ success: true, value: 'decrypted-access' });
    mockCredentialDispatchLeaseRepository.bindCredential.mockImplementation(async () => {
      keyLive = false;
      return {
        success: true,
        grant: {
          accountEmail: 'a@example.com', oauthTokenId: 'encrypted-row',
          capability: 'capability', leaseGeneration: 'generation',
          expiresAt: new Date(Date.now() + 60_000),
        },
      };
    });
    mockCredentialDispatchLeaseRepository.terminalize.mockResolvedValue(true);
    const input = {
      userId: 'user_1', provider: 'google', decisionId: 'decision_1',
      actionId: 'action_1', executionPlanId: 'plan_1', authorityRevision: 'authority-1',
      policyAuthorityRevision: 'policy-authority-1',
      dispatchCapability: 'dispatch-capability', dispatchLeaseGeneration: 'dispatch-generation',
    };

    await expect(provider.startDispatch(input)).resolves.toEqual({
      success: false,
      error: 'OAuth credential is unavailable while the credential vault is locked.',
    });
    expect(mockCredentialDispatchLeaseRepository.terminalize).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when disconnect wins before the request-start claim', async () => {
    mockOauthRepository.getToken.mockResolvedValue({
      id: 'token-row', credential_revision: 'revision-1', account_email: 'a@example.com',
      access_token: 'stale-token', refresh_token: 'refresh',
      expires_at: new Date(Date.now() + 120_000), scopes: [],
    });
    mockCredentialDispatchLeaseRepository.bindCredential.mockResolvedValue({
      success: false,
      code: 'credential_unavailable',
      error: 'No active google credential is available for dispatch.',
    });

    await expect(provider.startDispatch({
      userId: 'user_1', provider: 'google', decisionId: 'decision_1',
      actionId: 'action_1', executionPlanId: 'plan_1', authorityRevision: 'authority-1',
      policyAuthorityRevision: 'policy-authority-1',
      dispatchCapability: 'dispatch-capability', dispatchLeaseGeneration: 'dispatch-generation',
    })).resolves.toEqual({
      success: false,
      error: 'No active google credential is available for dispatch.',
    });
  });
});

describe('NoopCredentialProvider', () => {
  it('returns error for any provider', async () => {
    const provider = new NoopCredentialProvider();

    const result = await provider.getAccessToken('user_1', 'google');

    expect(result).toEqual({
      success: false,
      error: 'No credential provider configured for google.',
    });
  });
});
