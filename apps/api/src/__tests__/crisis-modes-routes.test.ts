/**
 * Tests for crisis-modes routes (#194 Child 3 partial — recovery codes + vacation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockRecoveryCodeRepository, mockVacationModeRepository } = vi.hoisted(() => ({
  mockRecoveryCodeRepository: {
    countUnused: vi.fn(),
    listForUser: vi.fn(),
    generateForUser: vi.fn(),
    redeem: vi.fn(),
  },
  mockVacationModeRepository: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  recoveryCodeRepository: mockRecoveryCodeRepository,
  vacationModeRepository: mockVacationModeRepository,
}));

import { createCrisisModesRouter } from '../routes/crisis-modes.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(userId: string | null = USER_ID): Express {
  const app = express();
  app.use(express.json());
  if (userId !== null) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: userId };
      next();
    });
  }
  app.use('/api/crisis-modes', createCrisisModesRouter());
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('no port')); return; }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const opts: RequestInit = { method, headers };
      if (body !== undefined) opts.body = JSON.stringify(body);
      fetch(url, opts).then(async (res) => {
        const json = await res.json().catch(() => null);
        server.close();
        resolve({ status: res.status, body: json as Record<string, unknown> });
      }).catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /:userId/recovery-codes', () => {
  it('returns count + audit-log shape', async () => {
    mockRecoveryCodeRepository.countUnused.mockResolvedValue(7);
    mockRecoveryCodeRepository.listForUser.mockResolvedValue([
      { id: 'r1', createdAt: new Date('2026-05-08'), usedAt: null, usedFor: null },
      { id: 'r2', createdAt: new Date('2026-05-08'), usedAt: new Date('2026-05-09'), usedFor: 'vault-unlock' },
    ]);
    const { status, body } = await req(buildApp(), 'GET', `/api/crisis-modes/${USER_ID}/recovery-codes`);
    expect(status).toBe(200);
    expect(body['unusedCount']).toBe(7);
    const codes = body['codes'] as Array<Record<string, unknown>>;
    expect(codes.length).toBe(2);
    // Hashes must NEVER appear in JSON output.
    expect(JSON.stringify(codes)).not.toContain('code_hash');
  });
});

describe('POST /:userId/recovery-codes/regenerate', () => {
  it('returns plaintext codes once', async () => {
    mockRecoveryCodeRepository.generateForUser.mockResolvedValue([
      'AAAA-BBBB-CCCC-DDDD',
      'EEEE-FFFF-1111-2222',
    ]);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/recovery-codes/regenerate`,
    );
    expect(status).toBe(200);
    const codes = body['codes'] as string[];
    expect(codes.length).toBe(2);
    expect(codes[0]).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(mockRecoveryCodeRepository.generateForUser).toHaveBeenCalledWith(USER_ID, 10);
  });
});

describe('POST /:userId/recovery-codes/redeem', () => {
  it('accepts a valid code', async () => {
    mockRecoveryCodeRepository.redeem.mockResolvedValue({ ok: true, codeId: 'rc-1' });
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/recovery-codes/redeem`,
      { code: 'AAAA-BBBB-CCCC-DDDD' },
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(body['codeId']).toBe('rc-1');
  });

  it('returns 401 with neutral error on invalid code', async () => {
    mockRecoveryCodeRepository.redeem.mockResolvedValue({ ok: false });
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/recovery-codes/redeem`,
      { code: 'WRONG-CODE-XXXX-YYYY' },
    );
    expect(status).toBe(401);
    // Error must NOT distinguish "not found" from "already used" — that
    // would let an attacker probe redemption state.
    expect(body['error']).toMatch(/invalid or already-used/);
  });

  it('rejects empty code', async () => {
    const { status } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/recovery-codes/redeem`,
      { code: '' },
    );
    expect(status).toBe(400);
  });
});

describe('GET /:userId/vacation', () => {
  it('reports active=true when in the future', async () => {
    const future = new Date(Date.now() + 86_400_000);
    mockVacationModeRepository.get.mockResolvedValue({ until: future, active: true });
    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/crisis-modes/${USER_ID}/vacation`,
    );
    expect(status).toBe(200);
    expect(body['active']).toBe(true);
    expect(body['until']).toBe(future.toISOString());
  });

  it('reports active=false when null', async () => {
    mockVacationModeRepository.get.mockResolvedValue({ until: null, active: false });
    const { body } = await req(buildApp(), 'GET', `/api/crisis-modes/${USER_ID}/vacation`);
    expect(body['active']).toBe(false);
    expect(body['until']).toBeNull();
  });
});

describe('POST /:userId/vacation/start', () => {
  it('accepts days payload', async () => {
    mockVacationModeRepository.set.mockResolvedValue(undefined);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/vacation/start`,
      { days: 7 },
    );
    expect(status).toBe(200);
    expect(body['active']).toBe(true);
    expect(typeof body['until']).toBe('string');
    expect(mockVacationModeRepository.set).toHaveBeenCalledWith(USER_ID, expect.any(Date));
  });

  it('accepts ISO until payload', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000);
    mockVacationModeRepository.set.mockResolvedValue(undefined);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/vacation/start`,
      { until: future.toISOString() },
    );
    expect(status).toBe(200);
    expect(body['until']).toBe(future.toISOString());
  });

  it('rejects past until', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/vacation/start`,
      { until: past.toISOString() },
    );
    expect(status).toBe(400);
    expect(body['error']).toMatch(/future/);
  });

  it('rejects days outside 1..90', async () => {
    const r1 = await req(buildApp(), 'POST', `/api/crisis-modes/${USER_ID}/vacation/start`, { days: 0 });
    expect(r1.status).toBe(400);
    const r2 = await req(buildApp(), 'POST', `/api/crisis-modes/${USER_ID}/vacation/start`, { days: 100 });
    expect(r2.status).toBe(400);
  });

  it('rejects until > 90 days out', async () => {
    const farFuture = new Date(Date.now() + 100 * 86_400_000);
    const { status } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/vacation/start`,
      { until: farFuture.toISOString() },
    );
    expect(status).toBe(400);
  });

  it('rejects empty body', async () => {
    const { status } = await req(buildApp(), 'POST', `/api/crisis-modes/${USER_ID}/vacation/start`, {});
    expect(status).toBe(400);
  });
});

describe('POST /:userId/vacation/end', () => {
  it('clears the deadline', async () => {
    mockVacationModeRepository.set.mockResolvedValue(undefined);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/crisis-modes/${USER_ID}/vacation/end`,
    );
    expect(status).toBe(200);
    expect(body['active']).toBe(false);
    expect(body['until']).toBeNull();
    expect(mockVacationModeRepository.set).toHaveBeenCalledWith(USER_ID, null);
  });
});
