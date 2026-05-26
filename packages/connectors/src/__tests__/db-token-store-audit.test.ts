/**
 * Tests for the audit-log instrumentation on DbTokenStore (#393).
 *
 * Pins the security contract:
 *   - A successful credential-vault decrypt MUST emit one
 *     `decrypt_oauth_token` row through the audit port.
 *   - The plaintext-fallback paths (vault not unlocked, no token at
 *     all) MUST NOT emit — they don't represent a privilege action.
 *   - A failing audit sink MUST NOT throw or block the legitimate
 *     decrypt. The token returns; the failure is logged but swallowed.
 *
 * Reuses the vault-test scaffolding from db-token-store-vault.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('../oauth/google-oauth.js', () => ({
  refreshAccessToken: vi.fn(),
}));

import { DbTokenStore } from '../oauth/db-token-store.js';
import type { AuditLogPort } from '../oauth/db-token-store.js';
import { encrypt } from '@skytwin/credential-vault';

function makeKey(): Buffer {
  return randomBytes(32);
}

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
  if (key !== null) stored.set(forUser, key);
  return {
    get: vi.fn((u: string) => stored.get(u) ?? null),
    has: vi.fn((u: string) => stored.has(u)),
    set: vi.fn(),
  };
}

const oauthConfig = {
  clientId: 't',
  clientSecret: 's',
  redirectUri: 'http://localhost/cb',
};
const EXPIRES_AT = new Date('2027-01-01T00:00:00Z');

describe('DbTokenStore — audit log (#393)', () => {
  let repo: ReturnType<typeof createMockRepo>;
  let store: DbTokenStore;
  let auditPort: AuditLogPort & { recordAccess: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    repo = createMockRepo();
    store = new DbTokenStore(repo, oauthConfig);
    auditPort = { recordAccess: vi.fn().mockResolvedValue(undefined) };
  });

  it('emits one decrypt_oauth_token row on successful vault decrypt', async () => {
    const key = makeKey();
    store.setKeyCache(createMockKeyCache(key));
    store.setAuditLog(auditPort, 'worker');

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-100',
      access_token: '',
      refresh_token: '',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: packEncrypted(encrypt('ya29.secret', key)),
      encrypted_refresh_token: packEncrypted(encrypt('1//rsecret', key)),
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');
    expect(result?.accessToken).toBe('ya29.secret');

    expect(auditPort.recordAccess).toHaveBeenCalledTimes(1);
    expect(auditPort.recordAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      actor: 'worker',
      action: 'decrypt_oauth_token',
      resourceType: 'oauth_token',
      resourceId: 'row-id-100',
    });
  });

  it('does NOT emit on the plaintext-fallback path (vault not unlocked)', async () => {
    // No setKeyCache call — vault locked
    store.setAuditLog(auditPort, 'worker');
    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-200',
      access_token: 'ya29.plain',
      refresh_token: '1//plain',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');
    expect(result?.accessToken).toBe('ya29.plain');
    expect(auditPort.recordAccess).not.toHaveBeenCalled();
  });

  it('does NOT emit when no token exists for the user', async () => {
    store.setKeyCache(createMockKeyCache(makeKey()));
    store.setAuditLog(auditPort, 'worker');
    repo.getToken.mockResolvedValueOnce(null);

    const result = await store.getToken('user-1', 'google');
    expect(result).toBeNull();
    expect(auditPort.recordAccess).not.toHaveBeenCalled();
  });

  it('returns the decrypted token even when the audit sink rejects (logging miss != deny)', async () => {
    const key = makeKey();
    store.setKeyCache(createMockKeyCache(key));
    const failingPort: AuditLogPort = {
      recordAccess: () => Promise.reject(new Error('CRDB pool exhausted')),
    };
    store.setAuditLog(failingPort, 'worker');

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-300',
      access_token: '',
      refresh_token: '',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: packEncrypted(encrypt('ya29.recover', key)),
      encrypted_refresh_token: packEncrypted(encrypt('1//rrecover', key)),
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');
    expect(result?.accessToken).toBe('ya29.recover');
    // Give the unhandled-rejection guard a tick to surface.
    await new Promise((r) => setTimeout(r, 5));
  });

  it('returns the decrypted token even when the audit sink throws synchronously', async () => {
    const key = makeKey();
    store.setKeyCache(createMockKeyCache(key));
    const throwingPort: AuditLogPort = {
      recordAccess: () => { throw new Error('sync boom'); },
    };
    store.setAuditLog(throwingPort, 'worker');

    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-400',
      access_token: '',
      refresh_token: '',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: packEncrypted(encrypt('ya29.surv', key)),
      encrypted_refresh_token: packEncrypted(encrypt('1//rsurv', key)),
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');
    expect(result?.accessToken).toBe('ya29.surv');
  });

  it('no-ops cleanly when no audit port is attached at all (backwards compat)', async () => {
    const key = makeKey();
    store.setKeyCache(createMockKeyCache(key));
    // setAuditLog deliberately NOT called.
    repo.getToken.mockResolvedValueOnce({
      id: 'row-id-500',
      access_token: '',
      refresh_token: '',
      expires_at: EXPIRES_AT,
      scopes: ['email'],
      encrypted_access_token: packEncrypted(encrypt('ya29.noport', key)),
      encrypted_refresh_token: packEncrypted(encrypt('1//rnp', key)),
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    });

    const result = await store.getToken('user-1', 'google');
    expect(result?.accessToken).toBe('ya29.noport');
  });
});
