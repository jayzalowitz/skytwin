import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockVaultMetaRepo, mockOAuthRepo, mockWithTransaction, mockKeyCache } = vi.hoisted(() => {
  // Capture the transaction fn so tests can inspect / replace it
  const mockWithTransaction = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({}));

  return {
    mockVaultMetaRepo: {
      getForUser: vi.fn(),
      create: vi.fn(),
      incrementKeyVersion: vi.fn(),
      rotatePassphrase: vi.fn(),
    },
    mockOAuthRepo: {
      listEncryptedForUser: vi.fn(),
      rotateEncrypted: vi.fn(),
    },
    mockWithTransaction,
    mockKeyCache: {
      get: vi.fn(),
      has: vi.fn(),
      set: vi.fn(),
      evict: vi.fn(),
      clear: vi.fn(),
      size: vi.fn(),
    },
  };
});

vi.mock('@skytwin/db', () => ({
  credentialVaultMetaRepository: mockVaultMetaRepo,
  oauthRepository: mockOAuthRepo,
  withTransaction: mockWithTransaction,
}));

// Mock the KeyCache so it returns our mockKeyCache instance
vi.mock('@skytwin/credential-vault', async () => {
  const actual = await vi.importActual('@skytwin/credential-vault') as Record<string, unknown>;
  return {
    ...actual,
    KeyCache: vi.fn(() => mockKeyCache),
  };
});

// ── Import router after mocks ─────────────────────────────────────────────────

import {
  createCredentialVaultRouter,
  checkUnlockRateLimit,
  checkRotateRateLimit,
  _resetUnlockRateLimitForTests,
  _resetRotateRateLimitForTests,
} from '../routes/credential-vault.js';

// ── Test helpers ───────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/api/credential-vault', createCredentialVaultRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function req(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const options: RequestInit = { method, headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      fetch(url, options)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetUnlockRateLimitForTests();
  _resetRotateRateLimitForTests();
  mockKeyCache.has.mockReturnValue(false);
  mockKeyCache.get.mockReturnValue(null);
  // Default withTransaction: execute the fn and return its result
  mockWithTransaction.mockImplementation(
    async (fn: (client: unknown) => Promise<unknown>) => fn({}),
  );
});

// ── GET /status ───────────────────────────────────────────────────────────────

describe('GET /api/credential-vault/status', () => {
  it('returns initialized=false unlocked=false before vault init', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(null);
    mockKeyCache.has.mockReturnValue(false);

    const res = await req(buildApp(), 'GET', '/api/credential-vault/status');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['initialized']).toBe(false);
    expect(body['unlocked']).toBe(false);
  });

  it('returns initialized=true unlocked=false when init done but locked', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce({
      user_id: USER_ID,
      passphrase_salt: Buffer.alloc(32),
      passphrase_hash: Buffer.alloc(32),
      current_key_version: 1,
      created_at: new Date(),
      rotated_at: null,
    });
    mockKeyCache.has.mockReturnValue(false);

    const res = await req(buildApp(), 'GET', '/api/credential-vault/status');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['initialized']).toBe(true);
    expect(body['unlocked']).toBe(false);
  });

  it('returns initialized=true unlocked=true when vault is unlocked', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce({
      user_id: USER_ID,
      passphrase_salt: Buffer.alloc(32),
      passphrase_hash: Buffer.alloc(32),
      current_key_version: 1,
      created_at: new Date(),
      rotated_at: null,
    });
    mockKeyCache.has.mockReturnValue(true);

    const res = await req(buildApp(), 'GET', '/api/credential-vault/status');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['initialized']).toBe(true);
    expect(body['unlocked']).toBe(true);
  });
});

// ── POST /init ────────────────────────────────────────────────────────────────

describe('POST /api/credential-vault/init', () => {
  it('returns 422 when passphrase is too short', async () => {
    const res = await req(buildApp(), 'POST', '/api/credential-vault/init', {
      passphrase: 'short',
    });
    expect(res.status).toBe(422);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/at least/);
  });

  it('returns 422 when passphrase is missing', async () => {
    const res = await req(buildApp(), 'POST', '/api/credential-vault/init', {});
    expect(res.status).toBe(422);
  });

  it('returns 400 when vault already initialised', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce({
      user_id: USER_ID,
      passphrase_salt: Buffer.alloc(32),
      passphrase_hash: Buffer.alloc(32),
      current_key_version: 1,
      created_at: new Date(),
      rotated_at: null,
    });

    const res = await req(buildApp(), 'POST', '/api/credential-vault/init', {
      passphrase: 'valid-passphrase-that-is-long-enough',
    });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/already initialised/);
  });

  it('returns 200 and initialises the vault on success', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(null);
    mockVaultMetaRepo.create.mockResolvedValueOnce({
      user_id: USER_ID,
      passphrase_salt: Buffer.alloc(32),
      passphrase_hash: Buffer.alloc(32),
      current_key_version: 1,
      created_at: new Date(),
      rotated_at: null,
    });

    const res = await req(buildApp(), 'POST', '/api/credential-vault/init', {
      passphrase: 'correct-horse-battery-staple',
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['ok']).toBe(true);
    expect(mockVaultMetaRepo.create).toHaveBeenCalledOnce();
    expect(mockKeyCache.set).toHaveBeenCalledWith(USER_ID, expect.any(Buffer));
  });
});

// ── POST /unlock ──────────────────────────────────────────────────────────────

describe('POST /api/credential-vault/unlock', () => {
  it('returns 404 when vault has not been initialised', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(null);

    const res = await req(buildApp(), 'POST', '/api/credential-vault/unlock', {
      passphrase: 'correct-horse-battery-staple',
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 when passphrase is wrong', async () => {
    // verifyPassphrase will return false because the stored hash won't match
    // We use real crypto here — just craft a non-matching hash
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce({
      user_id: USER_ID,
      passphrase_salt: Buffer.alloc(32, 0x01), // 32 bytes
      passphrase_hash: Buffer.alloc(32, 0xff), // won't match anything real
      current_key_version: 1,
      created_at: new Date(),
      rotated_at: null,
    });

    const res = await req(buildApp(), 'POST', '/api/credential-vault/unlock', {
      passphrase: 'definitely-wrong-passphrase',
    });
    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/[Ww]rong passphrase/);
  });

  it('rate-limits after 5 failed unlock attempts', async () => {
    const app = buildApp();

    // Exhaust the rate limit with wrong-passphrase 401s
    for (let i = 0; i < 5; i++) {
      mockVaultMetaRepo.getForUser.mockResolvedValueOnce({
        user_id: USER_ID,
        passphrase_salt: Buffer.alloc(32, 0x01),
        passphrase_hash: Buffer.alloc(32, 0xff),
        current_key_version: 1,
        created_at: new Date(),
        rotated_at: null,
      });
      await req(app, 'POST', '/api/credential-vault/unlock', {
        passphrase: 'wrong-attempt',
      });
    }

    // 6th attempt should hit rate limit
    const res = await req(app, 'POST', '/api/credential-vault/unlock', {
      passphrase: 'wrong-attempt',
    });
    expect(res.status).toBe(429);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/Too many/);
  });
});

// ── POST /lock ────────────────────────────────────────────────────────────────

describe('POST /api/credential-vault/lock', () => {
  it('returns 200 and evicts the key cache entry', async () => {
    const res = await req(buildApp(), 'POST', '/api/credential-vault/lock');
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['ok']).toBe(true);
    expect(mockKeyCache.evict).toHaveBeenCalledWith(USER_ID);
  });

  it('returns 200 when vault is already locked (idempotent)', async () => {
    // Evict an already-absent entry — should still be 200
    const res = await req(buildApp(), 'POST', '/api/credential-vault/lock');
    expect(res.status).toBe(200);
  });
});

// ── checkUnlockRateLimit unit tests ──────────────────────────────────────────

describe('checkUnlockRateLimit', () => {
  it('allows up to 5 requests per minute', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkUnlockRateLimit('rl-user', now).allowed).toBe(true);
    }
  });

  it('blocks the 6th request within the same window', () => {
    const now = 2_000_000;
    for (let i = 0; i < 5; i++) {
      checkUnlockRateLimit('rl-user-2', now);
    }
    expect(checkUnlockRateLimit('rl-user-2', now).allowed).toBe(false);
  });

  it('allows again after the window resets', () => {
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) {
      checkUnlockRateLimit('rl-user-3', now);
    }
    expect(checkUnlockRateLimit('rl-user-3', now).allowed).toBe(false);
    // Window expires
    expect(checkUnlockRateLimit('rl-user-3', now + 60_001).allowed).toBe(true);
  });

  it('buckets are isolated per user', () => {
    const now = 4_000_000;
    for (let i = 0; i < 5; i++) {
      checkUnlockRateLimit('rl-user-a', now);
    }
    expect(checkUnlockRateLimit('rl-user-a', now).allowed).toBe(false);
    expect(checkUnlockRateLimit('rl-user-b', now).allowed).toBe(true);
  });
});

// ── POST /rotate ──────────────────────────────────────────────────────────────

// Helper: build a meta row with a real passphrase hash derived from a known
// passphrase. Tests that need to verify a passphrase use this.
async function buildMetaRow(passphrase: string) {
  const { deriveKey: realDeriveKey, generateSalt: realGenerateSalt, hashDerivedKey: realHashKey } =
    await import('@skytwin/credential-vault');
  const salt = realGenerateSalt();
  const key = await realDeriveKey(passphrase, salt);
  const hash = realHashKey(key);
  return {
    user_id: USER_ID,
    passphrase_salt: salt,
    passphrase_hash: hash,
    current_key_version: 1,
    created_at: new Date(),
    rotated_at: null,
  };
}

describe('POST /api/credential-vault/rotate', () => {
  it('returns 400 when vault not initialised', async () => {
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(null);

    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: 'current-passphrase-long',
      newPassphrase: 'new-passphrase-long',
    });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/not been initialised/);
  });

  it('returns 422 when newPassphrase is too short', async () => {
    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: 'current-passphrase-long',
      newPassphrase: 'short',
    });
    expect(res.status).toBe(422);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/at least/);
  });

  it('returns 422 when newPassphrase is missing', async () => {
    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: 'current-passphrase-long',
    });
    expect(res.status).toBe(422);
  });

  it('returns 401 when currentPassphrase is wrong', async () => {
    // Use a real derived hash — wrong passphrase will not match
    const meta = await buildMetaRow('correct-current-passphrase-xyz');
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(meta);

    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: 'this-is-the-wrong-passphrase-long',
      newPassphrase: 'new-valid-passphrase-here',
    });
    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/[Ww]rong passphrase/);
  });

  it('returns 429 when rotate rate limit is exceeded', async () => {
    const app = buildApp();

    // Exhaust 5 attempts with wrong passphrase
    for (let i = 0; i < 5; i++) {
      mockVaultMetaRepo.getForUser.mockResolvedValueOnce({
        user_id: USER_ID,
        passphrase_salt: Buffer.alloc(32, 0x01),
        passphrase_hash: Buffer.alloc(32, 0xff), // won't match
        current_key_version: 1,
        created_at: new Date(),
        rotated_at: null,
      });
      await req(app, 'POST', '/api/credential-vault/rotate', {
        currentPassphrase: 'wrong-current-passphrase-long',
        newPassphrase: 'new-valid-passphrase-here',
      });
    }

    // 6th should be rate-limited
    const res = await req(app, 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: 'wrong-current-passphrase-long',
      newPassphrase: 'new-valid-passphrase-here',
    });
    expect(res.status).toBe(429);
    expect((res.body as Record<string, unknown>)['error']).toMatch(/Too many/);
  });

  it('happy path: no encrypted tokens — bumps keyVersion, returns rotated', async () => {
    const passphrase = 'correct-current-passphrase-xyz';
    const meta = await buildMetaRow(passphrase);
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(meta);
    mockOAuthRepo.listEncryptedForUser.mockResolvedValueOnce([]);
    mockVaultMetaRepo.rotatePassphrase.mockResolvedValueOnce(2);

    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: passphrase,
      newPassphrase: 'new-valid-passphrase-here',
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['status']).toBe('rotated');
    expect(body['tokensReencrypted']).toBe(0);
    expect(body['keyVersion']).toBe(2);
    expect(mockKeyCache.set).toHaveBeenCalledWith(USER_ID, expect.any(Buffer));
  });

  it('happy path: re-encrypts token rows and bumps keyVersion', async () => {
    const { encrypt: rEncrypt } = await import('@skytwin/credential-vault');

    const passphrase = 'correct-current-passphrase-xyz';
    const meta = await buildMetaRow(passphrase);

    // Build a valid packed encrypted token using the actual key derived from passphrase
    const { passphrase_salt } = meta;
    const { deriveKey: realDeriveKey } = await import('@skytwin/credential-vault');
    const oldKey = await realDeriveKey(passphrase, passphrase_salt);
    const atResult = rEncrypt('access-token-value', oldKey);
    const rtResult = rEncrypt('refresh-token-value', oldKey);
    const packedAt = Buffer.concat([atResult.iv, atResult.tag, atResult.ciphertext]);
    const packedRt = Buffer.concat([rtResult.iv, rtResult.tag, rtResult.ciphertext]);

    const fakeRow = {
      id: 'row-id-1',
      user_id: USER_ID,
      provider: 'google',
      account_email: 'test@example.com',
      account_provider_id: null,
      access_token: null,
      refresh_token: null,
      expires_at: new Date(),
      scopes: ['email'],
      created_at: new Date(),
      updated_at: new Date(),
      encrypted_access_token: packedAt,
      encrypted_refresh_token: packedRt,
      encryption_iv: null,
      encryption_tag: null,
      encryption_key_version: 1,
    };

    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(meta);
    mockOAuthRepo.listEncryptedForUser.mockResolvedValueOnce([fakeRow]);
    mockOAuthRepo.rotateEncrypted.mockResolvedValueOnce(undefined);
    mockVaultMetaRepo.rotatePassphrase.mockResolvedValueOnce(2);

    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: passphrase,
      newPassphrase: 'new-valid-passphrase-here',
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['status']).toBe('rotated');
    expect(body['tokensReencrypted']).toBe(1);
    expect(body['keyVersion']).toBe(2);
    expect(mockOAuthRepo.rotateEncrypted).toHaveBeenCalledOnce();
    expect(mockKeyCache.set).toHaveBeenCalledWith(USER_ID, expect.any(Buffer));
  });

  it('returns 500 and rolls back when re-encryption throws mid-transaction', async () => {
    const passphrase = 'correct-current-passphrase-xyz';
    const meta = await buildMetaRow(passphrase);
    mockVaultMetaRepo.getForUser.mockResolvedValueOnce(meta);

    // Make withTransaction throw to simulate a mid-transaction failure
    mockWithTransaction.mockImplementationOnce(async () => {
      throw new Error('simulated DB error during rotation');
    });

    const res = await req(buildApp(), 'POST', '/api/credential-vault/rotate', {
      currentPassphrase: passphrase,
      newPassphrase: 'new-valid-passphrase-here',
    });
    expect(res.status).toBe(500);
    // KeyCache must NOT have been updated with the new key
    expect(mockKeyCache.set).not.toHaveBeenCalled();
  });
});

// ── checkRotateRateLimit unit tests ───────────────────────────────────────────

describe('checkRotateRateLimit', () => {
  it('allows up to 5 requests per minute', () => {
    const now = 10_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkRotateRateLimit('rotate-user', now).allowed).toBe(true);
    }
  });

  it('blocks the 6th request within the same window', () => {
    const now = 11_000_000;
    for (let i = 0; i < 5; i++) {
      checkRotateRateLimit('rotate-user-2', now);
    }
    expect(checkRotateRateLimit('rotate-user-2', now).allowed).toBe(false);
  });

  it('allows again after window resets', () => {
    const now = 12_000_000;
    for (let i = 0; i < 5; i++) {
      checkRotateRateLimit('rotate-user-3', now);
    }
    expect(checkRotateRateLimit('rotate-user-3', now).allowed).toBe(false);
    expect(checkRotateRateLimit('rotate-user-3', now + 60_001).allowed).toBe(true);
  });
});
