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

const {
  mockGetSettings,
  mockUpsertSettings,
  mockCountPages,
  mockPendingJobs,
  mockCountUserSentPages,
  mockGetRecentPages,
  mockUpdatePageMetadata,
  mockHideAllPagesFromSender,
} = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockUpsertSettings: vi.fn(),
  mockCountPages: vi.fn(),
  mockPendingJobs: vi.fn(),
  mockCountUserSentPages: vi.fn(),
  mockGetRecentPages: vi.fn(),
  mockUpdatePageMetadata: vi.fn(),
  mockHideAllPagesFromSender: vi.fn(),
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
    countUserSentPages: mockCountUserSentPages,
    getRecentPages: mockGetRecentPages,
    updatePageMetadata: mockUpdatePageMetadata,
    hideAllPagesFromSender: mockHideAllPagesFromSender,
  };
});

const { mockGetEpisodes, mockGetEntities } = vi.hoisted(() => ({
  mockGetEpisodes: vi.fn(),
  mockGetEntities: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mempalaceRepository: {
    getEpisodes: mockGetEpisodes,
    getEntities: mockGetEntities,
  },
}));

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
  mockGetEpisodes.mockResolvedValue([]);
  mockGetEntities.mockResolvedValue([]);
  mockCountUserSentPages.mockResolvedValue(0);
  mockGetRecentPages.mockResolvedValue([]);
  mockUpdatePageMetadata.mockResolvedValue(1);
  mockHideAllPagesFromSender.mockResolvedValue(0);
  mockUpsertSettings.mockResolvedValue({
    user_id: USER_ID,
    backend: 'gbrain',
    hybrid_notification_dismissed: false,
    routing: {},
    tier_weighting: false,
    tier_calibration: 'normal',
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

describe('GET /api/memory-config/dashboard', () => {
  it('returns 400 on invalid userId', async () => {
    const app = buildApp();
    const res = await request(app, 'GET', '/api/memory-config/dashboard?userId=bad');
    expect(res.status).toBe(400);
  });

  it('returns empty shape when no episodes/entities exist', async () => {
    mockGetEpisodes.mockResolvedValue([]);
    mockGetEntities.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config/dashboard?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      index: { totalPages: number; embeddedPages: number; pendingEmbeddingJobs: number };
      episodes: { recent: unknown[]; feedbackCounts: Record<string, number> };
      entities: { total: number; topByRecency: unknown[]; topByType: unknown[] };
    };
    expect(body.index.totalPages).toBe(42);
    expect(body.episodes.recent).toHaveLength(0);
    expect(body.entities.total).toBe(0);
  });

  it('aggregates feedback counts across recent episodes', async () => {
    mockGetEpisodes.mockResolvedValue([
      { id: 'e1', situation_summary: 's1', domain: 'email', situation_type: 'email_triage', action_taken: 'archive_email', feedback_type: 'approve', utility_score: 0.9, created_at: new Date() },
      { id: 'e2', situation_summary: 's2', domain: 'email', situation_type: 'email_triage', action_taken: 'send_reply', feedback_type: 'reject', utility_score: 0, created_at: new Date() },
      { id: 'e3', situation_summary: 's3', domain: 'email', situation_type: 'email_triage', action_taken: 'archive_email', feedback_type: 'approve', utility_score: 0.85, created_at: new Date() },
    ]);
    mockGetEntities.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config/dashboard?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as { episodes: { feedbackCounts: Record<string, number> } };
    expect(body.episodes.feedbackCounts.approve).toBe(2);
    expect(body.episodes.feedbackCounts.reject).toBe(1);
  });

  it('builds top entities by recency + type histogram', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    mockGetEpisodes.mockResolvedValue([]);
    mockGetEntities.mockResolvedValue([
      { id: 'p1', name: 'Alice', entity_type: 'person', updated_at: now },
      { id: 'p2', name: 'Bob', entity_type: 'person', updated_at: earlier },
      { id: 'org1', name: 'Acme', entity_type: 'organization', updated_at: now },
    ]);
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config/dashboard?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      entities: {
        total: number;
        topByRecency: Array<{ name: string; entityType: string }>;
        topByType: Array<{ type: string; count: number }>;
      };
    };
    expect(body.entities.total).toBe(3);
    // Most recent first
    expect(body.entities.topByRecency[0]?.name).not.toBe('Bob');
    // Type histogram sorted by count desc
    expect(body.entities.topByType[0]?.type).toBe('person');
    expect(body.entities.topByType[0]?.count).toBe(2);
  });

  it('survives a DB failure on one of the queries — returns partial data', async () => {
    mockGetEpisodes.mockRejectedValue(new Error('db down'));
    mockGetEntities.mockResolvedValue([{ id: 'p1', name: 'Alice', entity_type: 'person', updated_at: new Date() }]);
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config/dashboard?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as { episodes: { recent: unknown[] }; entities: { total: number } };
    expect(body.episodes.recent).toHaveLength(0);
    expect(body.entities.total).toBe(1);
  });

  it('returns recent pages with tier badge fields (#251)', async () => {
    mockGetRecentPages.mockResolvedValue([
      {
        id: 'p1',
        user_id: USER_ID,
        title: 'Q3 board prep',
        content: 'long body',
        source: 'signal',
        source_ref: 'sig_gmail_abc',
        metadata: { authoringTier: 'user_sent_originated', bodyLen: 600 },
        embedding: null,
        embedding_model: null,
        embedding_dim: null,
        created_at: new Date('2026-05-11T12:00:00Z'),
        updated_at: new Date(),
      },
      {
        id: 'p2',
        user_id: USER_ID,
        title: 'Weekly Stripe receipt',
        content: 'short',
        source: 'signal',
        source_ref: 'sig_gmail_def',
        metadata: { authoringTier: 'inbox_automated', userOverride: 'hidden' },
        embedding: null,
        embedding_model: null,
        embedding_dim: null,
        created_at: new Date('2026-05-10T12:00:00Z'),
        updated_at: new Date(),
      },
    ]);
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config/dashboard?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as { pages: { recent: Array<Record<string, unknown>> } };
    expect(body.pages.recent).toHaveLength(2);
    expect(body.pages.recent[0]?.['authoringTier']).toBe('user_sent_originated');
    expect(body.pages.recent[1]?.['userOverride']).toBe('hidden');
    // Embedding vector NOT echoed to the wire (large + irrelevant).
    expect(body.pages.recent[0]?.['embedding']).toBeUndefined();
  });
});

describe('POST /api/memory-config/tier-weighting (#251 Layer 2)', () => {
  it('rejects non-boolean enabled', async () => {
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/tier-weighting?userId=${USER_ID}`,
      { enabled: 'yes' },
    );
    expect(res.status).toBe(400);
  });

  it('on enable, auto-computes the calibration band from sent volume', async () => {
    mockCountUserSentPages.mockResolvedValue(50); // sparse threshold (<100)
    mockUpsertSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'gbrain',
      hybrid_notification_dismissed: false,
      routing: {},
      tier_weighting: true,
      tier_calibration: 'sparse',
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/tier-weighting?userId=${USER_ID}`,
      { enabled: true },
    );
    expect(res.status).toBe(200);
    const body = res.body as { tierWeighting: boolean; tierCalibration: string };
    expect(body.tierWeighting).toBe(true);
    expect(body.tierCalibration).toBe('sparse');
    expect(mockUpsertSettings).toHaveBeenCalledWith(USER_ID, {
      tier_weighting: true,
      tier_calibration: 'sparse',
    });
  });

  it('an explicit calibration override skips the auto-recompute', async () => {
    mockCountUserSentPages.mockResolvedValue(50); // would be sparse
    mockUpsertSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'gbrain',
      hybrid_notification_dismissed: false,
      routing: {},
      tier_weighting: true,
      tier_calibration: 'dense',
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/tier-weighting?userId=${USER_ID}`,
      { enabled: true, calibration: 'dense' },
    );
    expect(res.status).toBe(200);
    expect(mockCountUserSentPages).not.toHaveBeenCalled();
    expect(mockUpsertSettings).toHaveBeenCalledWith(USER_ID, {
      tier_weighting: true,
      tier_calibration: 'dense',
    });
  });

  it('disable does NOT auto-recompute calibration (leaves it where it was)', async () => {
    mockUpsertSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'gbrain',
      hybrid_notification_dismissed: false,
      routing: {},
      tier_weighting: false,
      tier_calibration: 'normal',
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/tier-weighting?userId=${USER_ID}`,
      { enabled: false },
    );
    expect(res.status).toBe(200);
    expect(mockCountUserSentPages).not.toHaveBeenCalled();
    expect(mockUpsertSettings).toHaveBeenCalledWith(USER_ID, { tier_weighting: false });
  });

  it('falls back to normal calibration when countUserSentPages fails', async () => {
    mockCountUserSentPages.mockRejectedValue(new Error('db hiccup'));
    mockUpsertSettings.mockResolvedValue({
      user_id: USER_ID,
      backend: 'gbrain',
      hybrid_notification_dismissed: false,
      routing: {},
      tier_weighting: true,
      tier_calibration: 'normal',
      updated_at: new Date(),
    });
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/tier-weighting?userId=${USER_ID}`,
      { enabled: true },
    );
    expect(res.status).toBe(200);
    expect(mockUpsertSettings).toHaveBeenCalledWith(USER_ID, {
      tier_weighting: true,
      tier_calibration: 'normal',
    });
  });
});

describe('POST /api/memory-config/pages/:pageId/override (#251 privacy)', () => {
  it('rejects an invalid override value', async () => {
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/pages/page-1/override?userId=${USER_ID}`,
      { override: 'bogus' },
    );
    expect(res.status).toBe(400);
  });

  it('accepts pinned + hidden + null and writes a metadata patch', async () => {
    const app = buildApp();
    for (const value of ['pinned', 'hidden', null]) {
      mockUpdatePageMetadata.mockResolvedValueOnce(1);
      const res = await request(
        app,
        'POST',
        `/api/memory-config/pages/page-1/override?userId=${USER_ID}`,
        { override: value },
      );
      expect(res.status).toBe(200);
      expect(mockUpdatePageMetadata).toHaveBeenCalledWith(USER_ID, 'page-1', {
        userOverride: value,
      });
    }
  });

  it('returns 404 when the adapter reports zero affected rows', async () => {
    mockUpdatePageMetadata.mockResolvedValueOnce(0);
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/pages/page-foreign/override?userId=${USER_ID}`,
      { override: 'pinned' },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/memory-config/senders/hide (#251 privacy)', () => {
  it('rejects a missing or non-string fromAddress', async () => {
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/senders/hide?userId=${USER_ID}`,
      {},
    );
    expect(res.status).toBe(400);
  });

  it('passes the lower-cased fromAddress and reports the affected count', async () => {
    mockHideAllPagesFromSender.mockResolvedValueOnce(7);
    const app = buildApp();
    const res = await request(
      app,
      'POST',
      `/api/memory-config/senders/hide?userId=${USER_ID}`,
      { fromAddress: 'Spam@Vendor.Example.com' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      fromAddress: 'spam@vendor.example.com',
      hidden: 7,
    });
    expect(mockHideAllPagesFromSender).toHaveBeenCalledWith(
      USER_ID,
      'Spam@Vendor.Example.com',
    );
  });

  it('returns the new dashboard payload with fromAddress + userOverride', async () => {
    mockGetRecentPages.mockResolvedValueOnce([
      {
        id: 'p-pinned',
        user_id: USER_ID,
        title: 'Pinned',
        content: '',
        source: 'signal',
        source_ref: 'sig-1',
        metadata: { authoringTier: 'user_sent_originated', userOverride: 'pinned', fromAddress: 'me@example.com' },
        embedding: null,
        embedding_model: null,
        embedding_dim: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = buildApp();
    const res = await request(app, 'GET', `/api/memory-config/dashboard?userId=${USER_ID}`);
    const body = res.body as { pages: { recent: Array<Record<string, unknown>> } };
    expect(body.pages.recent[0]?.['userOverride']).toBe('pinned');
    expect(body.pages.recent[0]?.['fromAddress']).toBe('me@example.com');
  });
});
