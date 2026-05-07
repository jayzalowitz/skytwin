/**
 * Tests for twin briefing API routes (issue #177).
 *
 * GET /api/twin-briefings/latest
 * GET /api/twin-briefings
 * POST /api/twin-briefings/:id/read
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Mocks (vi.hoisted so factories run before vi.mock) ─────────────────────

const { mockBriefingRepository } = vi.hoisted(() => ({
  mockBriefingRepository: {
    create: vi.fn(),
    getLatestForUser: vi.fn(),
    listForUser: vi.fn(),
    markRead: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  briefingRepository: mockBriefingRepository,
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { createTwinBriefingsRouter } from '../routes/twin-briefings.js';

// ── Constants ─────────────────────────────────────────────────────────────

const USER_ID     = 'ffffffff-eeee-dddd-cccc-000000000003';
const BRIEFING_ID = 'bbbbbbbb-aaaa-cccc-dddd-000000000001';

const BRIEFING_ROW = {
  id: BRIEFING_ID,
  user_id: USER_ID,
  cadence: 'daily' as const,
  generated_at: new Date(),
  prose_markdown: '## Daily Briefing\n\nHello world.',
  source_event_count: 3,
  llm_provider: null,
  llm_cost_cents: null,
  read_at: null,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function buildApp(userId: string | null = USER_ID): Express {
  const app = express();
  app.use(express.json());
  if (userId !== null) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: userId };
      next();
    });
  }
  app.use('/api/twin-briefings', createTwinBriefingsRouter());
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
      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/twin-briefings/latest', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the latest briefing for the authenticated user', async () => {
    mockBriefingRepository.getLatestForUser.mockResolvedValue(BRIEFING_ROW);

    const { status, body } = await req(buildApp(), 'GET', '/api/twin-briefings/latest');

    expect(status).toBe(200);
    expect((body as { briefing: { id: string } }).briefing).toBeDefined();
    expect((body as { briefing: { id: string } }).briefing.id).toBe(BRIEFING_ID);
    expect(mockBriefingRepository.getLatestForUser).toHaveBeenCalledWith(USER_ID, undefined);
  });

  it('returns { briefing: null } when no briefing exists', async () => {
    mockBriefingRepository.getLatestForUser.mockResolvedValue(null);

    const { status, body } = await req(buildApp(), 'GET', '/api/twin-briefings/latest');

    expect(status).toBe(200);
    expect((body as { briefing: null }).briefing).toBeNull();
  });

  it('passes cadence query param to the repository', async () => {
    mockBriefingRepository.getLatestForUser.mockResolvedValue(BRIEFING_ROW);

    await req(buildApp(), 'GET', '/api/twin-briefings/latest?cadence=weekly');

    expect(mockBriefingRepository.getLatestForUser).toHaveBeenCalledWith(USER_ID, 'weekly');
  });

  it('returns 400 when userId is missing (no auth middleware)', async () => {
    const { status } = await req(buildApp(null), 'GET', '/api/twin-briefings/latest');
    expect(status).toBe(400);
  });
});

describe('GET /api/twin-briefings', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a list of briefings for the user', async () => {
    mockBriefingRepository.listForUser.mockResolvedValue([BRIEFING_ROW]);

    const { status, body } = await req(buildApp(), 'GET', '/api/twin-briefings');

    expect(status).toBe(200);
    expect((body as { briefings: unknown[] }).briefings).toHaveLength(1);
    expect((body as { briefings: Array<{ id: string }> }).briefings[0]!.id).toBe(BRIEFING_ID);
  });

  it('passes limit query param to the repository (max 100)', async () => {
    mockBriefingRepository.listForUser.mockResolvedValue([]);

    await req(buildApp(), 'GET', '/api/twin-briefings?limit=5');

    expect(mockBriefingRepository.listForUser).toHaveBeenCalledWith(USER_ID, { cadence: undefined, limit: 5 });
  });
});

describe('POST /api/twin-briefings/:id/read', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('marks a briefing as read and returns it', async () => {
    const readRow = { ...BRIEFING_ROW, read_at: new Date() };
    mockBriefingRepository.listForUser.mockResolvedValue([BRIEFING_ROW]);
    mockBriefingRepository.markRead.mockResolvedValue(readRow);

    const { status, body } = await req(buildApp(), 'POST', `/api/twin-briefings/${BRIEFING_ID}/read`);

    expect(status).toBe(200);
    expect((body as { briefing: { read_at: unknown } }).briefing.read_at).toBeDefined();
    expect(mockBriefingRepository.markRead).toHaveBeenCalledWith(BRIEFING_ID);
  });

  it('returns 404 when the briefing is not found', async () => {
    mockBriefingRepository.listForUser.mockResolvedValue([]);

    const { status } = await req(buildApp(), 'POST', `/api/twin-briefings/${BRIEFING_ID}/read`);

    expect(status).toBe(404);
  });

  it('returns 403 when the briefing belongs to another user', async () => {
    mockBriefingRepository.listForUser.mockResolvedValue([{
      ...BRIEFING_ROW,
      user_id: 'other-user',
    }]);

    const { status } = await req(buildApp(), 'POST', `/api/twin-briefings/${BRIEFING_ID}/read`);

    expect(status).toBe(403);
  });

  it('returns 400 for a non-UUID id path param', async () => {
    const { status } = await req(buildApp(), 'POST', '/api/twin-briefings/not-a-uuid/read');
    expect(status).toBe(400);
  });
});
