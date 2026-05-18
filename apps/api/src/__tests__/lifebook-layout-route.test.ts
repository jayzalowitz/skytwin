/**
 * Tests for GET /api/lifebooks/:userId/:domainName/layout — issue #319.
 *
 * Coverage:
 *   1. 404 when the lifebook doesn't exist
 *   2. No signals → generic layout, source='no_signals'
 *   3. Sparse histogram (< 5 drawers OR < 3 types) → generic, source='sparse_fallback'
 *      (skip the LLM call entirely — token-spend protection)
 *   4. No LLM configured → generic, source='no_llm_configured'
 *   5. LLM happy path → returns the prompt's layout, source='llm'
 *   6. Prompt falls back to deterministic → generic, source='deterministic_fallback'
 *   7. runPrompt throws → generic, source='prompt_error' (fail-soft)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockFindByDomain,
  mockGetDrawers,
  mockGetEnabledProviders,
  mockRunPrompt,
} = vi.hoisted(() => ({
  mockFindByDomain: vi.fn(),
  mockGetDrawers: vi.fn(),
  mockGetEnabledProviders: vi.fn(),
  mockRunPrompt: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  lifebookRepository: {
    listVisible: vi.fn(),
    listAll: vi.fn(),
    findByDomain: mockFindByDomain,
    hide: vi.fn(),
    unhide: vi.fn(),
    setImportanceOverride: vi.fn(),
    clearImportanceOverride: vi.fn(),
  },
  mempalaceRepository: {
    getRooms: vi.fn(),
    getDrawers: mockGetDrawers,
  },
  aiProviderRepository: {
    getEnabledForUser: mockGetEnabledProviders,
  },
}));

vi.mock('@skytwin/policy-prompts', () => ({
  runPrompt: mockRunPrompt,
}));

vi.mock('@skytwin/llm-client', async () => {
  const actual = await vi.importActual<typeof import('@skytwin/llm-client')>(
    '@skytwin/llm-client',
  );
  return {
    ...actual,
    LlmClient: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
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
      fetch(url, { method, headers: { 'Content-Type': 'application/json' } })
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

function fakeLifebook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lb-1',
    user_id: USER_ID,
    domain_name: 'Health',
    importance: 'core' as const,
    sample_signals: ['Dr. visit'],
    suggested_capabilities: ['google-calendar-mcp'],
    wing_id: 'wing-1',
    detected_at: new Date(),
    last_seen_at: new Date(),
    hidden_at: null,
    metadata: {},
    ...overrides,
  };
}

function fakeDrawer(sourceType: string) {
  return {
    id: `drawer-${Math.random()}`,
    user_id: USER_ID,
    wing_id: 'wing-1',
    room_id: 'room-1',
    hall: 'h',
    content: 'c',
    metadata: {},
    source_type: sourceType,
    source_id: 'sid',
    created_at: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/lifebooks/:userId/:domainName/layout — #319', () => {
  it('returns 404 when the lifebook does not exist', async () => {
    mockFindByDomain.mockResolvedValue(null);
    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/NoSuchDomain/layout`);
    expect(res.status).toBe(404);
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns generic layout with source=no_signals when wing is empty (skips LLM)', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockGetDrawers.mockResolvedValue([]);

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200);
    const body = res.body as {
      layout: { layoutId: string; sections: Array<{ type: string; order: number }> };
      source: string;
    };
    expect(body.source).toBe('no_signals');
    expect(body.layout.layoutId).toBe('generic-two-column');
    expect(body.layout.sections).toHaveLength(2);
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns generic layout with source=sparse_fallback when histogram is too sparse (skips LLM)', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    // 4 drawers across 2 types — below the < 5 total / < 3 distinct threshold.
    mockGetDrawers.mockResolvedValue([
      fakeDrawer('email'),
      fakeDrawer('email'),
      fakeDrawer('calendar'),
      fakeDrawer('calendar'),
    ]);

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200);
    const body = res.body as { source: string; layout: { layoutId: string } };
    expect(body.source).toBe('sparse_fallback');
    expect(body.layout.layoutId).toBe('generic-two-column');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns generic layout with source=no_llm_configured when user has no providers', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockGetDrawers.mockResolvedValue([
      fakeDrawer('appointment'),
      fakeDrawer('appointment'),
      fakeDrawer('prescription'),
      fakeDrawer('lab_result'),
      fakeDrawer('calendar_event'),
      fakeDrawer('general_email'),
    ]);
    mockGetEnabledProviders.mockResolvedValue([]);

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200);
    const body = res.body as { source: string; layout: { layoutId: string } };
    expect(body.source).toBe('no_llm_configured');
    expect(body.layout.layoutId).toBe('generic-two-column');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns the prompt-picked layout when LLM is configured and the histogram is dense', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockGetDrawers.mockResolvedValue([
      fakeDrawer('appointment'),
      fakeDrawer('appointment'),
      fakeDrawer('appointment'),
      fakeDrawer('prescription'),
      fakeDrawer('lab_result'),
      fakeDrawer('calendar_event'),
    ]);
    mockGetEnabledProviders.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockRunPrompt.mockResolvedValue({
      output: {
        layoutId: 'health-timeline',
        sections: [
          { type: 'timeline', title: 'Recent Health Events', order: 0 },
          { type: 'capabilities', title: 'Tools', order: 1 },
        ],
      },
      fellBackToDeterministic: false,
    });

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200);
    const body = res.body as {
      source: string;
      layout: { layoutId: string; sections: Array<{ type: string }> };
      histogram: Record<string, number>;
    };
    expect(body.source).toBe('llm');
    expect(body.layout.layoutId).toBe('health-timeline');
    expect(body.layout.sections[0]!.type).toBe('timeline');
    // Histogram surfaces the actual bucketing so the UI can show
    // a sparkline / debug view; assert it matches the input.
    expect(body.histogram).toEqual({
      appointment: 3,
      prescription: 1,
      lab_result: 1,
      calendar_event: 1,
    });
  });

  it('returns generic layout with source=deterministic_fallback when runPrompt falls back', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockGetDrawers.mockResolvedValue([
      fakeDrawer('a'),
      fakeDrawer('b'),
      fakeDrawer('c'),
      fakeDrawer('a'),
      fakeDrawer('b'),
      fakeDrawer('c'),
    ]);
    mockGetEnabledProviders.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockRunPrompt.mockResolvedValue({
      output: {
        layoutId: 'generic-two-column',
        sections: [
          { type: 'signals', title: 'Recent Signals', order: 0 },
          { type: 'capabilities', title: 'Suggested Capabilities', order: 1 },
        ],
      },
      fellBackToDeterministic: true,
    });

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200);
    const body = res.body as { source: string };
    expect(body.source).toBe('deterministic_fallback');
  });

  it('returns 400 (not 500) when domainName has invalid percent-encoding', async () => {
    // No findByDomain call needed — the decode failure short-circuits.
    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/%ZZ/layout`);
    expect(res.status).toBe(400);
    expect(mockFindByDomain).not.toHaveBeenCalled();
  });

  it('returns source=provider_lookup_failed (NOT no_llm_configured) when getEnabledForUser throws', async () => {
    // Distinguishes "user has no providers" from "DB blip during
    // provider lookup" — different source so the UI doesn't lie
    // about why we're showing the generic layout.
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockGetDrawers.mockResolvedValue([
      fakeDrawer('a'),
      fakeDrawer('b'),
      fakeDrawer('c'),
      fakeDrawer('a'),
      fakeDrawer('b'),
      fakeDrawer('c'),
    ]);
    mockGetEnabledProviders.mockRejectedValue(new Error('CRDB pool exhausted'));

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200);
    const body = res.body as { source: string; layout: { layoutId: string } };
    expect(body.source).toBe('provider_lookup_failed');
    expect(body.layout.layoutId).toBe('generic-two-column');
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('returns generic layout with source=prompt_error when runPrompt throws (fail-soft)', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockGetDrawers.mockResolvedValue([
      fakeDrawer('a'),
      fakeDrawer('b'),
      fakeDrawer('c'),
      fakeDrawer('a'),
      fakeDrawer('b'),
      fakeDrawer('c'),
    ]);
    mockGetEnabledProviders.mockResolvedValue([
      { provider: 'anthropic', api_key: 'k', model: 'claude-haiku-4-5', base_url: null },
    ]);
    mockRunPrompt.mockRejectedValue(new Error('upstream timeout'));

    const res = await request(buildApp(), 'GET', `/api/lifebooks/${USER_ID}/Health/layout`);
    expect(res.status).toBe(200); // still 200 — page must render
    const body = res.body as { source: string; layout: { layoutId: string } };
    expect(body.source).toBe('prompt_error');
    expect(body.layout.layoutId).toBe('generic-two-column');
  });
});
