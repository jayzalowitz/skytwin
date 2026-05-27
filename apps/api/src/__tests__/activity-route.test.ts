/**
 * Tests for the recent-activity timeline endpoint (#391).
 *
 * Locks the wire shape the future Activity tab will consume:
 *   - Unified events array, newest-first, properly typed kind
 *   - Time-window clamp (hours param) with sane bounds
 *   - Limit clamp on row count
 *   - Privacy: a repo failure on one source doesn't fail the others
 *   - Auth: malformed user IDs rejected at the validator layer
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mockSignalRepository = { getRecent: vi.fn() };
const mockDecisionRepository = { findByUser: vi.fn() };
const mockFeedbackRepository = { findByUser: vi.fn() };

vi.mock('@skytwin/db', () => ({
  signalRepository: mockSignalRepository,
  decisionRepository: mockDecisionRepository,
  feedbackRepository: mockFeedbackRepository,
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

const { createActivityRouter } = await import('../routes/activity.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/activity', createActivityRouter());
  return app;
}

async function request(
  app: Express,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [pathOnly, queryStr] = path.split('?');
  const query: Record<string, string> = {};
  if (queryStr) {
    for (const pair of queryStr.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[k] = v ?? '';
    }
  }
  return new Promise((resolve, reject) => {
    const req: Partial<express.Request> = {
      method: 'GET',
      url: path,
      headers: {},
      body: {},
      query,
    } as Partial<express.Request>;
    let status = 200;
    let resp: Record<string, unknown> = {};
    const res = {
      status(code: number) { status = code; return res; },
      json(payload: Record<string, unknown>) {
        resp = payload;
        resolve({ status, body: resp });
        return res;
      },
      setHeader: () => res,
      end: () => resolve({ status, body: resp }),
    } as unknown as express.Response;
    app(req as express.Request, res as express.Response, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ status, body: resp });
    });
    void pathOnly;
  });
}

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000044';

// Factory defaults are relative to Date.now() so the tests don't rot
// once the calendar passes the absolute date a test was written on —
// the route's default lookback is 24h, so any factory default older
// than that would silently drop out of the response and turn an
// assertion like "decision event present" into a false negative.
function mkSignal(over: Partial<{
  id: string;
  source: string;
  type: string;
  domain: string;
  timestamp: Date;
}> = {}) {
  return {
    id: over.id ?? 'sig-1',
    user_id: USER_ID,
    source: over.source ?? 'gmail',
    type: over.type ?? 'inbound_email',
    domain: over.domain ?? 'email',
    data: {},
    timestamp: over.timestamp ?? new Date(Date.now() - 60 * 60 * 1000),
  };
}

function mkDecision(over: Partial<{ id: string; domain: string; situation_type: string; created_at: Date }> = {}) {
  return {
    id: over.id ?? 'dec-1',
    user_id: USER_ID,
    situation_type: over.situation_type ?? 'inbound_email',
    raw_event: {},
    interpreted_situation: {},
    domain: over.domain ?? 'email',
    urgency: 'medium',
    metadata: {},
    signal_id: null,
    created_at: over.created_at ?? new Date(Date.now() - 30 * 60 * 1000),
  };
}

function mkFeedback(over: Partial<{ id: string; type: string; decision_id: string; created_at: Date }> = {}) {
  return {
    id: over.id ?? 'fb-1',
    user_id: USER_ID,
    type: over.type ?? 'approve',
    decision_id: over.decision_id ?? 'dec-1',
    created_at: over.created_at ?? new Date(Date.now() - 15 * 60 * 1000),
  };
}

describe('GET /activity/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignalRepository.getRecent.mockResolvedValue([]);
    mockDecisionRepository.findByUser.mockResolvedValue([]);
    mockFeedbackRepository.findByUser.mockResolvedValue([]);
  });

  it('returns empty events + defaults for hours/limit on a fresh user', async () => {
    const app = makeApp();
    const { status, body } = await request(app, `/activity/${USER_ID}`);
    expect(status).toBe(200);
    expect(body).toEqual({ events: [], total: 0, hours: 24, limit: 200 });
  });

  it('merges signals + decisions + feedback into a newest-first timeline', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    mockSignalRepository.getRecent.mockResolvedValue([
      mkSignal({ id: 'sig-A', timestamp: new Date(recent.getTime() - 1000) }),
    ]);
    mockDecisionRepository.findByUser.mockResolvedValue([
      mkDecision({ id: 'dec-A', created_at: recent }),
    ]);
    mockFeedbackRepository.findByUser.mockResolvedValue([
      mkFeedback({ id: 'fb-A', decision_id: 'dec-A', created_at: new Date(recent.getTime() + 1000) }),
    ]);

    const app = makeApp();
    const { status, body } = await request(app, `/activity/${USER_ID}`);
    expect(status).toBe(200);
    const events = body['events'] as Array<{ id: string; kind: string }>;
    expect(events).toHaveLength(3);
    // Newest first: feedback (latest) → decision → signal.
    expect(events.map((e) => e.id)).toEqual(['fb:fb-A', 'dec:dec-A', 'sig:sig-A']);
    expect(events.map((e) => e.kind)).toEqual(['feedback', 'decision', 'signal']);
  });

  it('drops events older than the lookback window even if a repo returned them', async () => {
    const now = Date.now();
    mockSignalRepository.getRecent.mockResolvedValue([
      // Recent: kept
      mkSignal({ id: 'sig-recent', timestamp: new Date(now - 60_000) }),
    ]);
    mockDecisionRepository.findByUser.mockResolvedValue([
      // Older than 1h window: dropped
      mkDecision({ id: 'dec-old', created_at: new Date(now - 2 * 60 * 60 * 1000) }),
    ]);

    const app = makeApp();
    const { body } = await request(app, `/activity/${USER_ID}?hours=1`);
    const ids = (body['events'] as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain('sig:sig-recent');
    expect(ids).not.toContain('dec:dec-old');
    expect(body['hours']).toBe(1);
  });

  it('clamps hours to [1, 720] and limit to [1, 500]', async () => {
    const app = makeApp();
    const a = await request(app, `/activity/${USER_ID}?hours=0&limit=0`);
    expect(a.body['hours']).toBe(1);
    expect(a.body['limit']).toBe(1);
    const b = await request(app, `/activity/${USER_ID}?hours=99999&limit=99999`);
    expect(b.body['hours']).toBe(720);
    expect(b.body['limit']).toBe(500);
    const c = await request(app, `/activity/${USER_ID}?hours=junk`);
    expect(c.body['hours']).toBe(24); // default on non-numeric
  });

  it('returns partial results when one source rejects (best-effort union)', async () => {
    mockSignalRepository.getRecent.mockRejectedValue(new Error('crdb blip'));
    mockDecisionRepository.findByUser.mockResolvedValue([mkDecision()]);
    mockFeedbackRepository.findByUser.mockResolvedValue([mkFeedback()]);

    const app = makeApp();
    const { status, body } = await request(app, `/activity/${USER_ID}`);
    expect(status).toBe(200);
    const events = body['events'] as Array<{ kind: string }>;
    expect(events.some((e) => e.kind === 'decision')).toBe(true);
    expect(events.some((e) => e.kind === 'feedback')).toBe(true);
    expect(events.some((e) => e.kind === 'signal')).toBe(false);
  });

  it('rejects a malformed userId with 400 invalid_user_id via the shared validator', async () => {
    const app = makeApp();
    const { status, body } = await request(app, '/activity/not-a-uuid');
    expect(status).toBe(400);
    expect(body['error']).toBe('invalid_user_id');
    expect(mockSignalRepository.getRecent).not.toHaveBeenCalled();
  });

  it('caps the merged result at `limit` even when the underlying sources return more', async () => {
    const now = Date.now();
    const recent = (offset: number) => new Date(now - offset);
    mockSignalRepository.getRecent.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) =>
        mkSignal({ id: `sig-${i}`, timestamp: recent(i * 1000) }),
      ),
    );
    mockDecisionRepository.findByUser.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) =>
        mkDecision({ id: `dec-${i}`, created_at: recent(i * 1000 + 200_000) }),
      ),
    );
    mockFeedbackRepository.findByUser.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) =>
        mkFeedback({ id: `fb-${i}`, created_at: recent(i * 1000 + 400_000) }),
      ),
    );

    const app = makeApp();
    const { body } = await request(app, `/activity/${USER_ID}?limit=80`);
    expect(body['total']).toBe(80);
    expect((body['events'] as unknown[]).length).toBe(80);
  });
});
