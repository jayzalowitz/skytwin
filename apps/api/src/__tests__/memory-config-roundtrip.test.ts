/**
 * Real Express round-trip for /api/memory-config, end to end.
 *
 * Unlike `memory-config-routes.test.ts` (which mocks the adapter and only
 * exercises the route handlers), this test exercises:
 *
 *   - the real Express router
 *   - the real `getMemoryPortForUser` factory
 *   - the real `EmbeddedGbrainMemoryPort` (against the in-memory store)
 *   - the real `HybridMemoryPort` diagnostics counters
 *
 * The CRDB-backed paths are stubbed at the lowest level (the `query`
 * function in `@skytwin/db`) so we don't need a database. Everything else
 * runs as it would in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Hoisted mock for @skytwin/db so getPool/query/withTransaction don't try
// to connect to a real CockroachDB. Each query is mapped to a fake-row
// generator that mirrors the brain_* table shapes. ─────────────────────────
const { fakeQuery, fakeWithTransaction, resetFakeDb } = vi.hoisted(() => {
  const settingsByUser = new Map<
    string,
    {
      user_id: string;
      backend: string;
      hybrid_notification_dismissed: boolean;
      routing: Record<string, unknown>;
      updated_at: Date;
    }
  >();
  const pageCount = new Map<string, { total: number; embedded: number }>();
  const resetFakeDb = () => {
    settingsByUser.clear();
    pageCount.clear();
  };

  const fakeQuery = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('FROM brain_settings WHERE user_id')) {
      const userId = String(params?.[0] ?? '');
      const row = settingsByUser.get(userId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('INTO brain_settings')) {
      const userId = String(params?.[0] ?? '');
      const newBackend = (params?.[1] ?? null) as string | null;
      const dismiss = (params?.[2] ?? null) as boolean | null;
      const routingJson = (params?.[3] ?? null) as string | null;
      const existing = settingsByUser.get(userId);
      const merged = {
        user_id: userId,
        backend: newBackend ?? existing?.backend ?? 'gbrain',
        hybrid_notification_dismissed:
          dismiss ?? existing?.hybrid_notification_dismissed ?? false,
        routing: routingJson
          ? (JSON.parse(routingJson) as Record<string, unknown>)
          : existing?.routing ?? {},
        updated_at: new Date(),
      };
      settingsByUser.set(userId, merged);
      return { rows: [merged], rowCount: 1 };
    }
    if (text.includes('count(*)')) {
      const userId = String(params?.[0] ?? '');
      const counts = pageCount.get(userId) ?? { total: 0, embedded: 0 };
      return { rows: [{ total: String(counts.total), embedded: String(counts.embedded) }], rowCount: 1 };
    }
    if (text.includes('FROM brain_embedding_jobs')) {
      return { rows: [{ count: '0' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const fakeWithTransaction = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    return fn({ query: fakeQuery });
  });

  return { fakeQuery, fakeWithTransaction, resetFakeDb };
});

vi.mock('@skytwin/db', () => ({
  query: fakeQuery,
  withTransaction: fakeWithTransaction,
  getPool: () => ({}),
  closePool: vi.fn(),
  healthCheck: vi.fn(async () => ({ healthy: true, latencyMs: 1 })),
  // Repository stubs the routes don't exercise, here so the import doesn't blow up.
  mempalaceRepository: {},
}));

vi.mock('@skytwin/core', async () => {
  const actual: typeof import('@skytwin/core') = await vi.importActual('@skytwin/core');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

import { createMemoryConfigRouter } from '../routes/memory-config.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000099';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/memory-config', createMemoryConfigRouter());
  return app;
}

async function request(
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
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body !== undefined) options.body = JSON.stringify(body);
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
  fakeQuery.mockClear();
  fakeWithTransaction.mockClear();
  resetFakeDb();
});

describe('Real round-trip: GET → POST → GET', () => {
  it('first GET reports gbrain default; POST switches to hybrid; second GET reflects it', async () => {
    const app = buildApp();

    // First GET — should fall through to default 'gbrain' (no settings row yet)
    const r1 = await request(app, 'GET', `/api/memory-config?userId=${USER_ID}`);
    expect(r1.status).toBe(200);
    const body1 = r1.body as { backend: string; capabilities: string[] };
    expect(body1.backend).toBe('gbrain');
    expect(body1.capabilities).toContain('semantic_search');
    expect(body1.capabilities).toContain('episodic'); // gbrain has it natively

    // POST — switch to hybrid
    const r2 = await request(app, 'POST', `/api/memory-config?userId=${USER_ID}`, {
      backend: 'hybrid',
    });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ ok: true, backend: 'hybrid' });

    // Second GET — backend now hybrid, capabilities include both gbrain + mempalace stubs
    const r3 = await request(app, 'GET', `/api/memory-config?userId=${USER_ID}`);
    expect(r3.status).toBe(200);
    const body3 = r3.body as { backend: string; capabilities: string[] };
    expect(body3.backend).toBe('hybrid');
    expect(body3.capabilities).toContain('semantic_search');
    expect(body3.capabilities).toContain('spatial_wings'); // mempalace stub contributes
    expect(body3.capabilities).toContain('aaak_compression');
  }, 30_000);

  it('diagnostics endpoint returns null for gbrain-only and counters for hybrid', async () => {
    const app = buildApp();

    // gbrain → no diagnostics
    await request(app, 'POST', `/api/memory-config?userId=${USER_ID}`, { backend: 'gbrain' });
    const d1 = await request(app, 'GET', `/api/memory-config/diagnostics?userId=${USER_ID}`);
    expect(d1.status).toBe(200);
    expect((d1.body as { diagnostics: unknown }).diagnostics).toBeNull();

    // hybrid → counters present (zero immediately after init)
    await request(app, 'POST', `/api/memory-config?userId=${USER_ID}`, { backend: 'hybrid' });
    const d2 = await request(app, 'GET', `/api/memory-config/diagnostics?userId=${USER_ID}`);
    expect(d2.status).toBe(200);
    const body = d2.body as { backend: string; diagnostics: Record<string, number> };
    expect(body.backend).toBe('hybrid');
    expect(body.diagnostics).toEqual({
      routedPrimary: 0,
      routedSecondary: 0,
      writesPrimaryOk: 0,
      writesSecondaryOk: 0,
      writesSecondaryFailed: 0,
      writesPrimaryFailed: 0,
    });
  }, 30_000);

  it('dismiss-notification persists the flag on a fresh user (default backend STAYS gbrain)', async () => {
    const app = buildApp();

    // No prior settings → dismiss notification → backend should still be gbrain (the bug we fixed)
    const r = await request(
      app,
      'POST',
      `/api/memory-config/dismiss-notification?userId=${USER_ID}`,
    );
    expect(r.status).toBe(200);

    const get = await request(app, 'GET', `/api/memory-config?userId=${USER_ID}`);
    expect(get.status).toBe(200);
    const body = get.body as { backend: string; hybridNotificationDismissed: boolean };
    expect(body.backend).toBe('gbrain'); // not flipped to hybrid
    expect(body.hybridNotificationDismissed).toBe(true);
  }, 30_000);
});

describe('Real round-trip: validation', () => {
  it('rejects invalid userId on GET', async () => {
    const app = buildApp();
    const r = await request(app, 'GET', '/api/memory-config?userId=not-a-uuid');
    expect(r.status).toBe(400);
  });

  it('rejects invalid backend on POST', async () => {
    const app = buildApp();
    const r = await request(app, 'POST', `/api/memory-config?userId=${USER_ID}`, {
      backend: 'something-else',
    });
    expect(r.status).toBe(400);
  });
});
