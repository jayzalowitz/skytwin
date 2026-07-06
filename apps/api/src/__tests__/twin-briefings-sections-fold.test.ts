/**
 * Tests for the #320 `/api/twin-briefings/latest` sections fold.
 *
 * Coverage:
 *   1. 400 when userId is missing
 *   2. No global briefing + no per-Lifebook briefings → { briefing: null, sections: [] }
 *   3. Global briefing present + sections empty (new user) → returns briefing, sections: []
 *   4. Sections ordered by visible-Lifebook importance, ONLY for Lifebooks
 *      with a matching per-domain briefing (no empty-section slots)
 *   5. Lifebook with no matching briefing is omitted from sections
 *   6. Hidden Lifebooks excluded from sections (listVisible already filters)
 *   7. cadence query param threads through to both queries
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockGetLatest,
  mockGetLatestPerLifebook,
  mockListVisible,
  mockListRecentWatchRuns,
} = vi.hoisted(() => ({
  mockGetLatest: vi.fn(),
  mockGetLatestPerLifebook: vi.fn(),
  mockListVisible: vi.fn(),
  mockListRecentWatchRuns: vi.fn().mockResolvedValue([]),
}));

vi.mock('@skytwin/db', () => ({
  briefingRepository: {
    getLatestForUser: mockGetLatest,
    getLatestPerLifebook: mockGetLatestPerLifebook,
    getLatestForUserDomain: vi.fn(),
    listForUser: vi.fn(),
    listForUserDomain: vi.fn(),
    markRead: vi.fn(),
  },
  lifebookRepository: {
    listVisible: mockListVisible,
  },
  watchRunRepository: {
    listRecentForUser: mockListRecentWatchRuns,
  },
  // buildLiveDigest (twin-briefings /latest) queries decisions; an empty
  // result makes it return null so these tests exercise the prose/sections
  // path without the live digest.
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

import { createTwinBriefingsRouter } from '../routes/twin-briefings.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/twin-briefings', createTwinBriefingsRouter());
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

function fakeLifebook(domain: string, importance: 'core' | 'secondary' | 'emerging' = 'core') {
  return {
    id: `lb-${domain}`,
    user_id: USER_ID,
    domain_name: domain,
    importance,
    sample_signals: [],
    suggested_capabilities: [],
    wing_id: null,
    detected_at: new Date(),
    last_seen_at: new Date(),
    hidden_at: null,
    metadata: {},
  };
}

function fakeBriefing(domainName: string | null) {
  return {
    id: `b-${domainName ?? 'global'}`,
    user_id: USER_ID,
    cadence: 'daily' as const,
    generated_at: new Date(),
    prose_markdown: `Prose for ${domainName ?? 'global'}`,
    source_event_count: 5,
    llm_provider: 'anthropic',
    llm_cost_cents: 1,
    read_at: null,
    domain_name: domainName,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListRecentWatchRuns.mockResolvedValue([]);
});

describe('GET /api/twin-briefings/latest — #320 sections fold', () => {
  it('returns 400 when userId is missing', async () => {
    const res = await request(buildApp(), 'GET', '/api/twin-briefings/latest');
    expect(res.status).toBe(400);
  });

  it('returns { briefing: null, sections: [] } when nothing exists', async () => {
    mockGetLatest.mockResolvedValue(null);
    mockGetLatestPerLifebook.mockResolvedValue([]);
    mockListVisible.mockResolvedValue([]);

    const res = await request(
      buildApp(),
      'GET',
      `/api/twin-briefings/latest?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ briefing: null, sections: [] });
  });

  it('returns global briefing + empty sections when no per-Lifebook briefings exist', async () => {
    mockGetLatest.mockResolvedValue(fakeBriefing(null));
    mockGetLatestPerLifebook.mockResolvedValue([]);
    mockListVisible.mockResolvedValue([fakeLifebook('Health')]);

    const res = await request(
      buildApp(),
      'GET',
      `/api/twin-briefings/latest?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { briefing: { id: string }; sections: unknown[] };
    expect(body.briefing.id).toBe('b-global');
    expect(body.sections).toEqual([]);
  });

  it('orders sections by Lifebook importance and omits Lifebooks without briefings', async () => {
    mockGetLatest.mockResolvedValue(fakeBriefing(null));
    // 3 per-Lifebook briefings; listVisible returns 4 Lifebooks (one
    // without a matching briefing) in importance order. The route
    // attaches briefings to Lifebooks via domain_name join AND drops
    // any Lifebook with no matching briefing — no empty slots.
    mockGetLatestPerLifebook.mockResolvedValue([
      fakeBriefing('Health'),
      fakeBriefing('Work'),
      fakeBriefing('Hobby'),
    ]);
    mockListVisible.mockResolvedValue([
      fakeLifebook('Health', 'core'),
      fakeLifebook('Work', 'secondary'),
      fakeLifebook('Aging Parents', 'core'), // no matching briefing — should be omitted
      fakeLifebook('Hobby', 'emerging'),
    ]);

    const res = await request(
      buildApp(),
      'GET',
      `/api/twin-briefings/latest?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      sections: Array<{
        lifebookId: string;
        domainName: string;
        importance: string;
        briefing: { domain_name: string };
      }>;
    };
    // 'Aging Parents' has no briefing → omitted. Order matches
    // listVisible's order (which is already importance-then-recency).
    expect(body.sections).toHaveLength(3);
    expect(body.sections.map((s) => s.domainName)).toEqual(['Health', 'Work', 'Hobby']);
    expect(body.sections[0]!.importance).toBe('core');
    expect(body.sections[2]!.importance).toBe('emerging');
    // Each section carries the matching briefing payload
    expect(body.sections[0]!.briefing.domain_name).toBe('Health');
  });

  it('hidden Lifebooks are excluded (listVisible already filters)', async () => {
    // Test relies on listVisible's contract — if a hidden Lifebook
    // doesn't come back from listVisible, it can't appear in sections.
    // Pinned here so a future refactor that switches to listAll has
    // to also re-add a hidden-filter.
    mockGetLatest.mockResolvedValue(fakeBriefing(null));
    mockGetLatestPerLifebook.mockResolvedValue([
      fakeBriefing('HiddenDomain'),
      fakeBriefing('Health'),
    ]);
    // listVisible only returns Health — HiddenDomain is filtered upstream
    mockListVisible.mockResolvedValue([fakeLifebook('Health')]);

    const res = await request(
      buildApp(),
      'GET',
      `/api/twin-briefings/latest?userId=${USER_ID}`,
    );
    const body = res.body as { sections: Array<{ domainName: string }> };
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]!.domainName).toBe('Health');
  });

  it('cadence query param threads through to both queries', async () => {
    mockGetLatest.mockResolvedValue(null);
    mockGetLatestPerLifebook.mockResolvedValue([]);
    mockListVisible.mockResolvedValue([]);

    await request(
      buildApp(),
      'GET',
      `/api/twin-briefings/latest?userId=${USER_ID}&cadence=weekly`,
    );
    expect(mockGetLatest).toHaveBeenCalledWith(USER_ID, 'weekly');
    expect(mockGetLatestPerLifebook).toHaveBeenCalledWith(USER_ID, 'weekly');
  });

  it('synthesizes a live briefing when recent watch runs exist', async () => {
    mockGetLatest.mockResolvedValue(null);
    mockGetLatestPerLifebook.mockResolvedValue([]);
    mockListVisible.mockResolvedValue([]);
    mockListRecentWatchRuns.mockResolvedValue([
      {
        id: 'run-1',
        watch_id: 'watch-1',
        user_id: USER_ID,
        ran_at: new Date('2026-07-06T09:00:00Z'),
        action: 'digest',
        matched_count: 3,
        summary: 'Budget watch found 3 items',
        matched_refs: ['sig-1', 'sig-2', 'sig-3'],
      },
    ]);

    const res = await request(
      buildApp(),
      'GET',
      `/api/twin-briefings/latest?userId=${USER_ID}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      briefing: { id: string; structured: { watchRuns: Array<{ summary: string }> } };
    };
    expect(body.briefing.id).toBe('live');
    expect(body.briefing.structured.watchRuns[0]!.summary).toBe('Budget watch found 3 items');
  });
});
