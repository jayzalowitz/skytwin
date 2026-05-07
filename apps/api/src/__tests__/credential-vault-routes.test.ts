import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockVaultMetaRepo, mockKeyCache } = vi.hoisted(() => ({
  mockVaultMetaRepo: {
    getForUser: vi.fn(),
    create: vi.fn(),
    incrementKeyVersion: vi.fn(),
  },
  mockKeyCache: {
    get: vi.fn(),
    has: vi.fn(),
    set: vi.fn(),
    evict: vi.fn(),
    clear: vi.fn(),
    size: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  credentialVaultMetaRepository: mockVaultMetaRepo,
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
  _resetUnlockRateLimitForTests,
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
  mockKeyCache.has.mockReturnValue(false);
  mockKeyCache.get.mockReturnValue(null);
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
