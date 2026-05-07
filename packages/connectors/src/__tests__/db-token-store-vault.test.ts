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
    updateEncrypted: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockKeyCache(key: Buffer | null = null, forUser = 'user-1') {
  const stored = new Map<string, Buffer>();
  if (key !== null) {
    stored.set(forUser, key);
  }
  return {
    get: vi.fn((userId: string) => stored.get(userId) ?? null),
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

  it('returns plaintext token and triggers lazy migration when vault is unlocked', async () => {
    const cache = createMockKeyCache(key);
    store.setKeyCache(cache);

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-001',
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

    expect(repo.updateEncrypted).toHaveBeenCalledOnce();
    const call = (repo.updateEncrypted as ReturnType<typeof vi.fn>).mock.calls[0] as [string, {
      encryptedAccessToken: Buffer;
      encryptedRefreshToken: Buffer;
      iv: Buffer;
      tag: Buffer;
      keyVersion: number;
    }];
    expect(call[0]).toBe('row-id-001');
    // Packed buffers should be at least IV_LENGTH + TAG_LENGTH + 1 bytes
    expect(call[1].encryptedAccessToken.length).toBeGreaterThan(IV_LENGTH + TAG_LENGTH);
    expect(call[1].encryptedRefreshToken.length).toBeGreaterThan(IV_LENGTH + TAG_LENGTH);
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
    expect(repo.updateEncrypted).not.toHaveBeenCalled();
  });

  it('returns plaintext without migration when vault is NOT unlocked', async () => {
    // No key cache attached — vault is not unlocked
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
    expect(repo.updateEncrypted).not.toHaveBeenCalled();
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

  it('lazyMigrationFailureCounter increments when updateEncrypted throws (observability hook)', async () => {
    const { lazyMigrationFailureCounter } = await import('../oauth/db-token-store.js');
    const startingCount = lazyMigrationFailureCounter.count;

    const cache = createMockKeyCache(key);
    store.setKeyCache(cache);

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-fail',
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

    repo.updateEncrypted.mockRejectedValueOnce(new Error('DB connection lost'));

    // The caller still gets the plaintext (Case 2 returns before the fire-and-forget resolves)
    const result = await store.getToken('user-1', 'google');
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('ya29.plaintext');

    // Wait for the fire-and-forget catch to fire
    await new Promise((r) => setTimeout(r, 20));

    expect(lazyMigrationFailureCounter.count).toBe(startingCount + 1);
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
