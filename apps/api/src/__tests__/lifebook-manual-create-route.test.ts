/**
 * Tests for the #193 AC#8 manual-create route on the lifebooks router.
 *
 *   POST /api/lifebooks/:userId — add a domain manually ("track 'X'")
 *
 * The route validates the body, delegates to `lifebookRepository.addManual`
 * (which creates the wing immediately), and reports 201 on create / 200 on
 * re-surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockAddManual } = vi.hoisted(() => ({
  mockAddManual: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  lifebookRepository: {
    listVisible: vi.fn(),
    listAll: vi.fn(),
    findByDomain: vi.fn(),
    hide: vi.fn(),
    unhide: vi.fn(),
    setImportanceOverride: vi.fn(),
    clearImportanceOverride: vi.fn(),
    addManual: mockAddManual,
  },
  mempalaceRepository: {
    getRooms: vi.fn(),
    getDrawers: vi.fn(),
  },
  aiProviderRepository: {
    getEnabledForUser: vi.fn(),
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
    domain_name: 'Volunteering',
    importance: 'emerging',
    sample_signals: [],
    suggested_capabilities: [],
    wing_id: 'wing-new',
    detected_at: new Date('2026-06-15T00:00:00Z'),
    last_seen_at: new Date('2026-06-15T00:00:00Z'),
    hidden_at: null,
    metadata: { manuallyAdded: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/lifebooks/:userId — #193 AC#8 manual create', () => {
  it('creates a new lifebook and returns 201 with manuallyAdded surfaced', async () => {
    mockAddManual.mockResolvedValue({
      success: true,
      created: true,
      lifebook: fakeLifebookRow(),
    });

    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: 'Volunteering',
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      created: boolean;
      lifebook: { domainName: string; importance: string; manuallyAdded: boolean };
    };
    expect(body.created).toBe(true);
    expect(body.lifebook.domainName).toBe('Volunteering');
    expect(body.lifebook.importance).toBe('emerging');
    expect(body.lifebook.manuallyAdded).toBe(true);
    expect(mockAddManual).toHaveBeenCalledWith({
      userId: USER_ID,
      domainName: 'Volunteering',
      importance: undefined,
    });
  });

  it('returns 200 (not 201) when the domain already existed and was re-surfaced', async () => {
    mockAddManual.mockResolvedValue({
      success: true,
      created: false,
      lifebook: fakeLifebookRow({ importance: 'core' }),
    });

    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: 'Volunteering',
    });

    expect(res.status).toBe(200);
    const body = res.body as { created: boolean };
    expect(body.created).toBe(false);
  });

  it('passes through a valid importance', async () => {
    mockAddManual.mockResolvedValue({
      success: true,
      created: true,
      lifebook: fakeLifebookRow({ importance: 'core' }),
    });

    await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: 'Caregiving',
      importance: 'core',
    });

    expect(mockAddManual).toHaveBeenCalledWith({
      userId: USER_ID,
      domainName: 'Caregiving',
      importance: 'core',
    });
  });

  it('rejects a missing domainName with 400 and never calls the repo', async () => {
    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {});
    expect(res.status).toBe(400);
    expect(mockAddManual).not.toHaveBeenCalled();
  });

  it('rejects an empty/whitespace domainName with 400', async () => {
    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: '   ',
    });
    expect(res.status).toBe(400);
    expect(mockAddManual).not.toHaveBeenCalled();
  });

  it('rejects a non-string domainName with 400', async () => {
    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: 42,
    });
    expect(res.status).toBe(400);
    expect(mockAddManual).not.toHaveBeenCalled();
  });

  it('rejects a domainName longer than 120 chars with 400', async () => {
    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: 'x'.repeat(121),
    });
    expect(res.status).toBe(400);
    expect(mockAddManual).not.toHaveBeenCalled();
  });

  it('rejects an invalid importance with 400', async () => {
    const res = await request(buildApp(), 'POST', `/api/lifebooks/${USER_ID}`, {
      domainName: 'Volunteering',
      importance: 'urgent',
    });
    expect(res.status).toBe(400);
    expect(mockAddManual).not.toHaveBeenCalled();
  });
});
