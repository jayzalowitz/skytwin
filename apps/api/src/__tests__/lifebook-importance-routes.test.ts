/**
 * Tests for the #321 importance-override routes on the lifebooks router.
 *
 *   POST   /api/lifebooks/:userId/:domainName/importance — set override
 *   DELETE /api/lifebooks/:userId/:domainName/importance — clear override
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockSetImportanceOverride, mockClearImportanceOverride } = vi.hoisted(() => ({
  mockSetImportanceOverride: vi.fn(),
  mockClearImportanceOverride: vi.fn(),
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
  },
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
  });
});
