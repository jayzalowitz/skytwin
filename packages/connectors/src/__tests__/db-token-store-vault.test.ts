/**
 * db-token-store-vault.test.ts
 *
 * Tests the lazy vault migration path in DbTokenStore.
 * A user with a plaintext token + an unlocked vault should have their token
 * migrated on first read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

// ── Mock google-oauth before imports ─────────────────────────────────────────
vi.mock('../oauth/google-oauth.js', () => ({
  refreshAccessToken: vi.fn(),
}));

import { DbTokenStore } from '../oauth/db-token-store.js';
import { refreshAccessToken } from '../oauth/google-oauth.js';
import { deriveKey, generateSalt, encrypt, IV_LENGTH, TAG_LENGTH } from '@skytwin/credential-vault';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKey(): Buffer {
  return randomBytes(32);
}

/** Pack a ciphertext as [IV][tag][ciphertext] — matches the pack format in db-token-store. */
function packEncrypted(result: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): Buffer {
  return Buffer.concat([result.iv, result.tag, result.ciphertext]);
}

function createMockRepo(overrides: Record<string, unknown> = {}) {
  return {
    getToken: vi.fn(),
    saveToken: vi.fn().mockResolvedValue({}),
    deleteToken: vi.fn().mockResolvedValue(true),
    updateAccessToken: vi.fn().mockResolvedValue({}),
    validateVaultSession: vi.fn().mockResolvedValue(true),
    getVaultAuthorityState: vi.fn().mockResolvedValue({
      state: 'unlocked', generation: 'vault-generation-1', keyVersion: 1,
    }),
    updateAccessTokenIfCurrent: vi.fn().mockResolvedValue(true),
    updateEncryptedIfCurrent: vi.fn().mockResolvedValue(true),
    updateEncryptedAccessTokenIfCurrent: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockKeyCache(
  key: Buffer | null = null,
  forUser = 'user-1',
  generation = 'vault-generation-1',
) {
  const stored = new Map<string, Buffer>();
  if (key !== null) {
    stored.set(forUser, key);
  }
  return {
    get: vi.fn((userId: string) => stored.get(userId) ?? null),
    getGeneration: vi.fn((userId: string) => stored.has(userId) ? generation : null),
    has: vi.fn((userId: string) => stored.has(userId)),
    set: vi.fn((userId: string, k: Buffer) => { stored.set(userId, k); }),
  };
}

const oauthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3100/callback',
};

const EXPIRES_AT = new Date('2027-01-01T00:00:00Z');

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DbTokenStore — lazy vault migration', () => {
  let repo: ReturnType<typeof createMockRepo>;
  let store: DbTokenStore;
  let key: Buffer;

  beforeEach(() => {
    vi.clearAllMocks();
    key = makeKey();
    repo = createMockRepo();
    store = new DbTokenStore(repo, oauthConfig);
  });

  it('uses the current vault version when rotation preceded the first plaintext read', async () => {
    const cache = createMockKeyCache(key);
    store.setKeyCache(cache);
    repo.getVaultAuthorityState.mockResolvedValueOnce({
      state: 'unlocked', generation: 'vault-generation-1', keyVersion: 2,
    });

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-001',
      credential_revision: 'revision-1',
      access_token: 'ya29.plaintext-access-token',
      refresh_token: '1//plaintext-refresh-token',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('ya29.plaintext-access-token');
    expect(result!.refreshToken).toBe('1//plaintext-refresh-token');

    // Give the fire-and-forget migration a chance to run
    await new Promise((r) => setTimeout(r, 10));

    expect(repo.updateEncryptedIfCurrent).toHaveBeenCalledOnce();
    const call = (repo.updateEncryptedIfCurrent as ReturnType<typeof vi.fn>).mock.calls[0] as [{
      id: string;
      encryptedAccessToken: Buffer;
      encryptedRefreshToken: Buffer;
      iv: Buffer;
      tag: Buffer;
      keyVersion: number;
    }];
    expect(call[0].id).toBe('row-id-001');
    expect(call[0]).toMatchObject({
      userId: 'user-1', provider: 'google', expectedCredentialRevision: 'revision-1',
      expectedVaultGeneration: 'vault-generation-1', keyVersion: 2,
    });
    // Packed buffers should be at least IV_LENGTH + TAG_LENGTH + 1 bytes
    expect(call[0].encryptedAccessToken.length).toBeGreaterThan(IV_LENGTH + TAG_LENGTH);
    expect(call[0].encryptedRefreshToken.length).toBeGreaterThan(IV_LENGTH + TAG_LENGTH);
  });

  it('returns decrypted token when encrypted columns are present', async () => {
    const cache = createMockKeyCache(key);
    store.setKeyCache(cache);

    const atPacked = packEncrypted(encrypt('ya29.secret-access-token', key));
    const rtPacked = packEncrypted(encrypt('1//secret-refresh-token', key));

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-002',
      access_token: '', // plaintext cleared after migration
      refresh_token: '',
      expires_at: EXPIRES_AT,
      scopes: ['calendar'],
      encrypted_access_token: atPacked,
      encrypted_refresh_token: rtPacked,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('ya29.secret-access-token');
    expect(result!.refreshToken).toBe('1//secret-refresh-token');

    // No migration needed — encrypted path used directly
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.updateEncryptedIfCurrent).not.toHaveBeenCalled();
  });

  it('returns plaintext without migration when vault is NOT unlocked', async () => {
    // No key cache attached — vault is not unlocked
    repo.getVaultAuthorityState.mockResolvedValueOnce({
      state: 'absent', generation: null, keyVersion: null,
    });
    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-003',
      access_token: 'ya29.plaintext-fallback',
      refresh_token: '1//plaintext-refresh-fallback',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');

    expect(result!.accessToken).toBe('ya29.plaintext-fallback');

    await new Promise((r) => setTimeout(r, 10));
    expect(repo.updateEncryptedIfCurrent).not.toHaveBeenCalled();
  });

  it('does not use a plaintext legacy row after the durable vault is locked', async () => {
    repo.getVaultAuthorityState.mockResolvedValueOnce({
      state: 'locked', generation: 'vault-generation-after-lock', keyVersion: 1,
    });
    repo.getToken.mockResolvedValueOnce({
      id: 'row-plaintext-locked', credential_revision: 'revision-locked',
      access_token: 'plaintext-access', refresh_token: 'plaintext-refresh',
      expires_at: EXPIRES_AT, scopes: ['email'], encrypted_access_token: null,
      encrypted_refresh_token: null, encryption_key_version: 1,
    });

    await expect(store.getToken('user-1', 'google')).rejects.toThrow('unlock the credential vault');
  });

  it('throws when encrypted token is present but vault is locked', async () => {
    const lockedCache = createMockKeyCache(null); // no key
    store.setKeyCache(lockedCache);

    const atPacked = packEncrypted(encrypt('some-token', makeKey()));

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-004',
      access_token: '',
      refresh_token: '',
      expires_at: EXPIRES_AT,
      scopes: [],
      encrypted_access_token: atPacked,
      encrypted_refresh_token: atPacked,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    await expect(store.getToken('user-1', 'google')).rejects.toThrow(
      'credentials unavailable',
    );
  });

  it('never falls back to leftover plaintext or refreshes when ciphertext is locked', async () => {
    store.setKeyCache(createMockKeyCache(null));
    const foreignKey = makeKey();
    repo.getToken.mockResolvedValueOnce({
      id: 'row-dual', credential_revision: 'revision-dual',
      access_token: 'plaintext-access-must-not-win',
      refresh_token: 'plaintext-refresh-must-not-win',
      expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
      encrypted_access_token: packEncrypted(encrypt('encrypted-access', foreignKey)),
      encrypted_refresh_token: packEncrypted(encrypt('encrypted-refresh', foreignKey)),
      encryption_iv: null, encryption_tag: null, encryption_key_version: 1,
    });

    await expect(store.getToken('user-1', 'google')).rejects.toThrow('credentials unavailable');
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(repo.updateAccessTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('rejects a partial encrypted representation even when leftover plaintext and a key exist', async () => {
    store.setKeyCache(createMockKeyCache(key));
    repo.getToken.mockResolvedValueOnce({
      id: 'row-partial', access_token: 'plaintext-access-must-not-win',
      refresh_token: 'plaintext-refresh-must-not-win', expires_at: EXPIRES_AT, scopes: [],
      encrypted_access_token: packEncrypted(encrypt('encrypted-access', key)),
      encrypted_refresh_token: null, encryption_iv: null, encryption_tag: null,
      encryption_key_version: 1,
    });

    await expect(store.getToken('user-1', 'google')).rejects.toThrow('repair the credential vault');
  });

  it('rejects a stale process-local key after another process locks the durable vault', async () => {
    store.setKeyCache(createMockKeyCache(key, 'user-1', 'stale-generation'));
    repo.validateVaultSession.mockResolvedValueOnce(false);
    repo.getToken.mockResolvedValueOnce({
      id: 'row-stale-cache', access_token: null, refresh_token: null,
      expires_at: EXPIRES_AT, scopes: [],
      encrypted_access_token: packEncrypted(encrypt('encrypted-access', key)),
      encrypted_refresh_token: packEncrypted(encrypt('encrypted-refresh', key)),
      encryption_iv: null, encryption_tag: null, encryption_key_version: 1,
    });

    await expect(store.getToken('user-1', 'google')).rejects.toThrow('credentials unavailable');
  });

  it('lazyMigrationFailureCounter increments when updateEncrypted throws (observability hook)', async () => {
    const { lazyMigrationFailureCounter } = await import('../oauth/db-token-store.js');
    const startingCount = lazyMigrationFailureCounter.count;

    const cache = createMockKeyCache(key);
    store.setKeyCache(cache);

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-fail',
      credential_revision: 'revision-fail',
      access_token: 'ya29.plaintext',
      refresh_token: '1//plaintext-refresh',
      expires_at: EXPIRES_AT,
      scopes: [],
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    repo.updateEncryptedIfCurrent.mockRejectedValueOnce(new Error('DB connection lost'));

    // The caller still gets the plaintext (Case 2 returns before the fire-and-forget resolves)
    const result = await store.getToken('user-1', 'google');
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('ya29.plaintext');

    // Wait for the fire-and-forget catch to fire
    await new Promise((r) => setTimeout(r, 20));

    expect(lazyMigrationFailureCounter.count).toBe(startingCount + 1);
  });

  it('binds a delayed lazy migration to the revision read before reconnect or rotation', async () => {
    const cache = createMockKeyCache(key);
    store.setKeyCache(cache);
    repo.updateEncryptedIfCurrent.mockResolvedValueOnce(false);
    repo.getToken.mockResolvedValueOnce({
      id: 'row-stale', credential_revision: 'revision-before-rotation',
      access_token: 'plaintext-access', refresh_token: 'plaintext-refresh',
      expires_at: EXPIRES_AT, scopes: [], encrypted_access_token: null,
      encrypted_refresh_token: null, encryption_key_version: 1,
    });

    await expect(store.getToken('user-1', 'google')).resolves.toMatchObject({
      accessToken: 'plaintext-access',
    });
    await vi.waitFor(() => expect(repo.updateEncryptedIfCurrent).toHaveBeenCalled());
    expect(repo.updateEncryptedIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'row-stale', expectedCredentialRevision: 'revision-before-rotation',
      expectedVaultGeneration: 'vault-generation-1',
    }));
  });

  it('refreshes an expired plaintext row into the vault without racing lazy migration', async () => {
    store.setKeyCache(createMockKeyCache(key));
    repo.getVaultAuthorityState.mockResolvedValue({
      state: 'unlocked', generation: 'vault-generation-1', keyVersion: 2,
    });
    repo.getToken.mockResolvedValueOnce({
      id: 'row-expired-plaintext', credential_revision: 'revision-before-refresh',
      access_token: 'expired-access', refresh_token: 'refresh-secret',
      expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
      encrypted_access_token: null, encrypted_refresh_token: null,
      encryption_iv: null, encryption_tag: null, encryption_key_version: 1,
    });
    vi.mocked(refreshAccessToken).mockResolvedValueOnce({
      accessToken: 'refreshed-access', refreshToken: 'refresh-secret',
      expiresAt: new Date(Date.now() + 3_600_000), scopes: ['email'], provider: 'google',
    });

    await expect(store.refreshIfExpired('user-1', 'google')).resolves.toMatchObject({
      accessToken: 'refreshed-access',
    });

    expect(repo.updateEncryptedIfCurrent).toHaveBeenCalledOnce();
    expect(repo.updateEncryptedIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'row-expired-plaintext',
      expectedCredentialRevision: 'revision-before-refresh',
      expectedVaultGeneration: 'vault-generation-1',
      keyVersion: 2,
    }));
    expect(repo.updateAccessTokenIfCurrent).not.toHaveBeenCalled();
  });

  it('durably migrates a live plaintext row before refreshIfExpired returns it', async () => {
    store.setKeyCache(createMockKeyCache(key));
    repo.getVaultAuthorityState.mockResolvedValue({
      state: 'unlocked', generation: 'vault-generation-1', keyVersion: 2,
    });
    repo.getToken.mockResolvedValueOnce({
      id: 'row-live-plaintext', credential_revision: 'revision-before-migration',
      access_token: 'live-access', refresh_token: 'live-refresh',
      expires_at: new Date(Date.now() + 120_000), scopes: ['email'],
      encrypted_access_token: null, encrypted_refresh_token: null,
      encryption_iv: null, encryption_tag: null, encryption_key_version: 1,
    });

    await expect(store.refreshIfExpired('user-1', 'google')).resolves.toMatchObject({
      accessToken: 'live-access', refreshToken: 'live-refresh',
    });

    expect(repo.updateEncryptedIfCurrent).toHaveBeenCalledOnce();
    expect(repo.updateEncryptedIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'row-live-plaintext', expectedCredentialRevision: 'revision-before-migration',
      expectedVaultGeneration: 'vault-generation-1', keyVersion: 2,
    }));
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a late plaintext refresh after vault initialization wins', async () => {
    repo.getVaultAuthorityState.mockResolvedValueOnce({
      state: 'absent', generation: null, keyVersion: null,
    });
    repo.getToken.mockResolvedValueOnce({
      id: 'row-before-vault-init', credential_revision: 'revision-before-init',
      access_token: 'expired-access', refresh_token: 'refresh-secret',
      expires_at: new Date(Date.now() - 1_000), scopes: ['email'],
      encrypted_access_token: null, encrypted_refresh_token: null,
      encryption_iv: null, encryption_tag: null, encryption_key_version: 1,
    });
    let releaseRefresh!: () => void;
    vi.mocked(refreshAccessToken).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return {
        accessToken: 'late-plaintext-access', refreshToken: 'refresh-secret',
        expiresAt: new Date(Date.now() + 3_600_000), scopes: ['email'], provider: 'google',
      };
    });
    let vaultInitialized = false;
    repo.updateAccessTokenIfCurrent.mockImplementationOnce(async () => !vaultInitialized);

    const pending = store.refreshIfExpired('user-1', 'google');
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
    vaultInitialized = true;
    releaseRefresh();

    await expect(pending).rejects.toThrow('credential changed while refresh was in flight');
    expect(repo.updateAccessTokenIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'row-before-vault-init', expectedCredentialRevision: 'revision-before-init',
    }));
    expect(repo.updateEncryptedIfCurrent).not.toHaveBeenCalled();
  });
});

describe('DbTokenStore — key derivation integration', () => {
  it('derives a key and successfully decrypts a previously encrypted token', async () => {
    const passphrase = 'super-secret-passphrase-123';
    const salt = generateSalt();
    const derivedKey = await deriveKey(passphrase, salt);

    const atPacked = packEncrypted(encrypt('ya29.real-token', derivedKey));
    const rtPacked = packEncrypted(encrypt('1//real-refresh', derivedKey));

    const repo = createMockRepo();
    repo.getToken.mockResolvedValueOnce({
      id: 'row-derived',
      access_token: '',
      refresh_token: '',
      expires_at: new Date('2027-01-01'),
      scopes: ['email'],
      encrypted_access_token: atPacked,
      encrypted_refresh_token: rtPacked,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const store = new DbTokenStore(repo, oauthConfig);

    const cache = createMockKeyCache(derivedKey, 'user-derived');
    store.setKeyCache(cache);

    const result = await store.getToken('user-derived', 'google');
    expect(result!.accessToken).toBe('ya29.real-token');
    expect(result!.refreshToken).toBe('1//real-refresh');
  }, 30_000); // scrypt is slow
});
