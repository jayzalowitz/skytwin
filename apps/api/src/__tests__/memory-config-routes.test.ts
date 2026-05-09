/**
 * E2E route tests for /api/memory-config (#197 AC #6/#7/#8).
 *
 * Mocks the @skytwin/memory-gbrain-crdb-adapter module so the route runs
 * without a live CockroachDB. The behaviour we verify is:
 *   - GET returns 200 with the expected shape (backend, capabilities, index).
 *   - POST persists a backend choice via upsertSettings.
 *   - dismiss-notification toggles the boolean.
 *   - diagnostics returns the hybrid counters when active, null otherwise.
 *
 * These tests live in apps/api so they exercise the full route → factory →
 * adapter wiring on the real Express handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Hoisted mocks (so they apply during module init) ────────────────────────

const { mockGetSettings, mockUpsertSettings, mockCountPages, mockPendingJobs } =
  vi.hoisted(() => ({
    mockGetSettings: vi.fn(),
    mockUpsertSettings: vi.fn(),
    mockCountPages: vi.fn(),
    mockPendingJobs: vi.fn(),
  }));

vi.mock('@skytwin/memory-gbrain-crdb-adapter', async () => {
  const actual: typeof import('@skytwin/memory-gbrain-crdb-adapter') =
    await vi.importActual('@skytwin/memory-gbrain-crdb-adapter');
  return {
    ...actual,
    getSettings: mockGetSettings,
    upsertSettings: mockUpsertSettings,
    countPages: mockCountPages,
    pendingEmbeddingJobs: mockPendingJobs,
  };
});

vi.mock('@skytwin/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createMemoryConfigRouter } from '../routes/memory-config.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const options: RequestInit = { method, headers };
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
  vi.clearAllMocks();
  mockCountPages.mockResolvedValue({ total: 42, embedded: 30 });
  mockPendingJobs.mockResolvedValue(7);
  mockGetSettings.mockResolvedValue(null);
  mockUpsertSettings.mockResolvedValue({
    user_id: USER_ID,
    backend: 'gbrain',
    hybrid_notification_dismissed: false,
    routing: {},
    updated_at: new Date(),
  });
});

describe('GET /api/memory-config', () => {
  it('returns 400 on invalid userId', async () => {
    const app = buildApp();
    const res = await request(app, 'GET', '/api/memory-config?userId=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns 200 with index counts and capabilities (gbrain default)', async () => {
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      userId: string;
      backend: string;
      capabilities: string[];
      index: { totalPages: number; embeddedPages: number; pendingEmbeddingJobs: number };
    };
    expect(body.userId).toBe(USER_ID);
    expect(body.backend).toBe('gbrain');
    expect(body.capabilities).toContain('semantic_search');
    expect(body.index).toEqual({ totalPages: 42, embeddedPages: 30, pendingEmbeddingJobs: 7 });
  });

  it('respects per-user backend override', async () => {
    mockGetSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'mempalace',
      hybrid_notification_dismissed: false,
      routing: {},
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    expect((res.body as { backend: string }).backend).toBe('mempalace');
  });
});

describe('POST /api/memory-config', () => {
  it('rejects invalid backend', async () => {
    const app = buildApp();
    const res = await request(app, 'POST', `/api/memory-config?userId=${USER_ID}`, {
      backend: 'nope',
    });
    expect(res.status).toBe(400);
  });

  it('persists the backend choice', async () => {
    const app = buildApp();
    const res = await request(app, 'POST', `/api/memory-config?userId=${USER_ID}`, {
      backend: 'hybrid',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'hybrid' });
    expect(mockUpsertSettings).toHaveBeenCalledWith(USER_ID, { backend: 'hybrid' });
  });
});

describe('POST /api/memory-config/dismiss-notification', () => {
  it('marks the notification as dismissed', async () => {
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/dismiss-notification?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(mockUpsertSettings).toHaveBeenCalledWith(USER_ID, {
      hybrid_notification_dismissed: true,
    });
  });
});

describe('GET /api/memory-config/diagnostics', () => {
  it('returns null diagnostics when not in hybrid mode', async () => {
    mockGetSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'gbrain',
      hybrid_notification_dismissed: false,
      routing: {},
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(
      app,
      'GET',
      `/api/memory-config/diagnostics?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { backend: string; diagnostics: unknown };
    expect(body.backend).toBe('gbrain');
    expect(body.diagnostics).toBeNull();
  });

  it('returns counters when in hybrid mode', async () => {
    mockGetSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'hybrid',
      hybrid_notification_dismissed: false,
      routing: {},
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(
      app,
      'GET',
      `/api/memory-config/diagnostics?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { backend: string; diagnostics: Record<string, number> };
    expect(body.backend).toBe('hybrid');
    expect(body.diagnostics).toEqual({
      routedPrimary: 0,
      routedSecondary: 0,
      writesPrimaryOk: 0,
      writesSecondaryOk: 0,
      writesSecondaryFailed: 0,
      writesPrimaryFailed: 0,
    });
  });
});
