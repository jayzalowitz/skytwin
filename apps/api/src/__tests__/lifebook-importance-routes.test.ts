/**
 * Tests for the #321 importance-override routes on the lifebooks router.
 *
 *   POST   /api/lifebooks/:userId/:domainName/importance — set override
 *   DELETE /api/lifebooks/:userId/:domainName/importance — clear override
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockSetImportanceOverride,
  mockClearImportanceOverride,
  mockCreateEpisode,
  mockRecordEpisode,
  mockGetMemoryPortForUser,
} = vi.hoisted(() => ({
  mockSetImportanceOverride: vi.fn(),
  mockClearImportanceOverride: vi.fn(),
  mockCreateEpisode: vi.fn(),
  mockRecordEpisode: vi.fn(),
  mockGetMemoryPortForUser: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  lifebookRepository: {
    listVisible: vi.fn(),
    listAll: vi.fn(),
    findByDomain: vi.fn(),
    hide: vi.fn(),
    unhide: vi.fn(),
    setImportanceOverride: mockSetImportanceOverride,
    clearImportanceOverride: mockClearImportanceOverride,
  },
  mempalaceRepository: {
    getRooms: vi.fn(),
    getDrawers: vi.fn(),
    createEpisode: mockCreateEpisode,
  },
}));

vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: mockGetMemoryPortForUser,
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(), // no-op for tests
}));

import { createLifebooksRouter } from '../routes/lifebooks.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/lifebooks', createLifebooksRouter());
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

function fakeLifebookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lb-1',
    user_id: USER_ID,
    domain_name: 'Health',
    importance: 'core',
    sample_signals: [],
    suggested_capabilities: [],
    wing_id: 'wing-9',
    detected_at: new Date('2026-05-01T00:00:00Z'),
    last_seen_at: new Date('2026-05-17T00:00:00Z'),
    hidden_at: null,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path episode recording so set/clear routes don't 500
  // on the best-effort recorder. Individual tests override as needed.
  mockCreateEpisode.mockResolvedValue({ id: 'episode-1' });
  mockRecordEpisode.mockResolvedValue(undefined);
  mockGetMemoryPortForUser.mockResolvedValue({
    port: { recordEpisode: mockRecordEpisode },
  });
});

describe('POST /api/lifebooks/:userId/:domainName/importance — #321', () => {
  it('rejects invalid value with 400', async () => {
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'urgent' },
    );
    expect(res.status).toBe(400);
    expect(mockSetImportanceOverride).not.toHaveBeenCalled();
  });

  it('rejects missing value with 400', async () => {
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      {},
    );
    expect(res.status).toBe(400);
  });

  it('writes the override and returns the updated lifebook with importanceOverride surfaced', async () => {
    mockSetImportanceOverride.mockResolvedValue(
      fakeLifebookRow({
        importance: 'core',
        metadata: {
          importanceOverride: {
            value: 'core',
            setAt: '2026-05-18T00:00:00Z',
            decayDays: 90,
          },
        },
      }),
    );

    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'core' },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      lifebook: {
        importance: string;
        importanceOverride: { value: string; setAt: string; decayDays: number } | null;
      };
    };
    expect(body.lifebook.importance).toBe('core');
    expect(body.lifebook.importanceOverride).toEqual({
      value: 'core',
      setAt: '2026-05-18T00:00:00Z',
      decayDays: 90,
    });
    // Repo called with the default decayDays = 90
    expect(mockSetImportanceOverride).toHaveBeenCalledWith(USER_ID, 'Health', 'core', 90);
  });

  it('accepts a custom decayDays', async () => {
    mockSetImportanceOverride.mockResolvedValue(fakeLifebookRow());
    await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'secondary', decayDays: 30 },
    );
    expect(mockSetImportanceOverride).toHaveBeenCalledWith(USER_ID, 'Health', 'secondary', 30);
  });

  it('treats decayDays = 0 as the "never auto-decay" sentinel (passed through, not coerced to default)', async () => {
    mockSetImportanceOverride.mockResolvedValue(fakeLifebookRow());
    await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'emerging', decayDays: 0 },
    );
    expect(mockSetImportanceOverride).toHaveBeenCalledWith(USER_ID, 'Health', 'emerging', 0);
  });

  it('returns 404 when the lifebook does not exist', async () => {
    mockSetImportanceOverride.mockResolvedValue(null);
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/NoSuchDomain/importance`,
      { value: 'core' },
    );
    expect(res.status).toBe(404);
    // No row → no episode recorded.
    expect(mockCreateEpisode).not.toHaveBeenCalled();
  });

  it('records the override as an episode in memory (#321 AC)', async () => {
    mockSetImportanceOverride.mockResolvedValue(fakeLifebookRow({ wing_id: 'wing-9' }));
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'core', decayDays: 90 },
    );
    expect(res.status).toBe(200);
    // Legacy episodic_memories write — domain-tagged, edit feedback.
    expect(mockCreateEpisode).toHaveBeenCalledTimes(1);
    const ep = mockCreateEpisode.mock.calls[0][0];
    expect(ep.userId).toBe(USER_ID);
    expect(ep.domain).toBe('Health');
    expect(ep.situationType).toBe('lifebook_importance_override');
    expect(ep.feedbackType).toBe('edit');
    expect(ep.situationSummary).toContain('Core');
    // Pluggable memory port also gets the episode.
    expect(mockRecordEpisode).toHaveBeenCalledTimes(1);
    const portEp = mockRecordEpisode.mock.calls[0][0];
    expect(portEp.id).toBe('episode-1');
    expect(portEp.wing).toBe('wing-9');
    expect(portEp.metadata).toMatchObject({
      kind: 'lifebook_importance_override',
      action: 'set',
      value: 'core',
      decayDays: 90,
    });
  });

  it('still returns 200 when episode recording throws (best-effort, never gates the write)', async () => {
    mockSetImportanceOverride.mockResolvedValue(fakeLifebookRow());
    mockCreateEpisode.mockRejectedValue(new Error('memory layer down'));
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'secondary' },
    );
    expect(res.status).toBe(200);
    const body = res.body as { lifebook: { domainName: string } };
    expect(body.lifebook.domainName).toBe('Health');
  });

  it('still returns 200 when the memory-port recordEpisode throws (legacy table write already succeeded)', async () => {
    mockSetImportanceOverride.mockResolvedValue(fakeLifebookRow());
    mockRecordEpisode.mockRejectedValue(new Error('port unavailable'));
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'emerging' },
    );
    expect(res.status).toBe(200);
    // Legacy write still attempted even though the port failed.
    expect(mockCreateEpisode).toHaveBeenCalledTimes(1);
  });
});

describe('rowToJson freshness filter — #321 stale-override suppression', () => {
  it('surfaces a fresh override (within decayDays)', async () => {
    mockSetImportanceOverride.mockResolvedValue(
      fakeLifebookRow({
        metadata: {
          importanceOverride: {
            value: 'core',
            setAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
            decayDays: 90,
          },
        },
      }),
    );
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'core' },
    );
    const body = res.body as { lifebook: { importanceOverride: unknown | null } };
    expect(body.lifebook.importanceOverride).not.toBeNull();
  });

  it('hides a stale override (setAt + decayDays already past — extractor would no longer respect it)', async () => {
    mockSetImportanceOverride.mockResolvedValue(
      fakeLifebookRow({
        metadata: {
          importanceOverride: {
            value: 'core',
            setAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
            decayDays: 90, // 200 > 90, expired
          },
        },
      }),
    );
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'core' },
    );
    const body = res.body as { lifebook: { importanceOverride: unknown | null } };
    // Stale → null. UI labels lifebook as "auto-detected" rather than
    // "set by you" — matches what the extractor will actually do on
    // the next run.
    expect(body.lifebook.importanceOverride).toBeNull();
  });

  it('treats decayDays = 0 as never-expires (always fresh)', async () => {
    mockSetImportanceOverride.mockResolvedValue(
      fakeLifebookRow({
        metadata: {
          importanceOverride: {
            value: 'core',
            setAt: new Date(Date.now() - 10000 * 24 * 60 * 60 * 1000).toISOString(),
            decayDays: 0,
          },
        },
      }),
    );
    const res = await request(
      buildApp(),
      'POST',
      `/api/lifebooks/${USER_ID}/Health/importance`,
      { value: 'core' },
    );
    const body = res.body as { lifebook: { importanceOverride: { decayDays: number } | null } };
    expect(body.lifebook.importanceOverride).not.toBeNull();
    expect(body.lifebook.importanceOverride!.decayDays).toBe(0);
  });
});

describe('DELETE /api/lifebooks/:userId/:domainName/importance — #321', () => {
  it('strips the override and returns the updated lifebook', async () => {
    mockClearImportanceOverride.mockResolvedValue(
      fakeLifebookRow({ metadata: {} }),
    );

    const res = await request(
      buildApp(),
      'DELETE',
      `/api/lifebooks/${USER_ID}/Health/importance`,
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      lifebook: { importanceOverride: unknown | null };
    };
    expect(body.lifebook.importanceOverride).toBeNull();
  });

  it('returns 404 when the lifebook does not exist', async () => {
    mockClearImportanceOverride.mockResolvedValue(null);
    const res = await request(
      buildApp(),
      'DELETE',
      `/api/lifebooks/${USER_ID}/NoSuchDomain/importance`,
    );
    expect(res.status).toBe(404);
    expect(mockCreateEpisode).not.toHaveBeenCalled();
  });

  it('records a "cleared" episode so the twin knows the user reverted (#321 AC)', async () => {
    mockClearImportanceOverride.mockResolvedValue(fakeLifebookRow({ metadata: {} }));
    const res = await request(
      buildApp(),
      'DELETE',
      `/api/lifebooks/${USER_ID}/Health/importance`,
    );
    expect(res.status).toBe(200);
    expect(mockCreateEpisode).toHaveBeenCalledTimes(1);
    const ep = mockCreateEpisode.mock.calls[0][0];
    expect(ep.actionTaken).toBe('clear_importance_override');
    expect(ep.situationSummary).toContain('cleared');
    expect(mockRecordEpisode).toHaveBeenCalledTimes(1);
    expect(mockRecordEpisode.mock.calls[0][0].metadata).toMatchObject({
      action: 'clear',
      value: null,
    });
  });
});
