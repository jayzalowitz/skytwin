import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted runs before vi.mock factories execute.
// ---------------------------------------------------------------------------

const {
  mockUserRepository,
  mockWhatWouldIDo,
} = vi.hoisted(() => ({
  mockUserRepository: {
    findById: vi.fn(),
  },
  mockWhatWouldIDo: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  policyRepositoryAdapter: {},
}));

vi.mock('@skytwin/decision-engine', () => ({
  DecisionMaker: vi.fn(function DecisionMaker() {
    return { whatWouldIDo: mockWhatWouldIDo };
  }),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn(),
}));

vi.mock('@skytwin/policy-engine', () => ({
  PolicyEvaluator: vi.fn(),
}));

import { createDemoRouter, _resetDemoCacheForTests } from '../routes/demo.js';

const DEMO_USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/demo', createDemoRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
      const options: RequestInit = { method, headers };
      if (body !== undefined) options.body = JSON.stringify(body);

      fetch(url, options)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          const respHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => { respHeaders[k] = v; });
          server.close();
          resolve({ status: res.status, body: json, headers: respHeaders });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const SEEDED_USER = {
  id: DEMO_USER_ID,
  email: 'alex@example.com',
  name: 'Alex Thompson',
  trust_tier: 'moderate_autonomy',
  autonomy_settings: {},
  created_at: new Date(),
  updated_at: new Date(),
};

const SUCCESSFUL_PREDICTION = {
  predictedAction: { actionType: 'archive_email', description: 'Archive it' },
  confidence: 'high',
  reasoning: 'Pattern match on prior archives',
  wouldAutoExecute: true,
  alternativeActions: [],
  predictionId: 'pred-1',
};

describe('demo routes', () => {
  beforeEach(() => {
    mockUserRepository.findById.mockReset();
    mockWhatWouldIDo.mockReset();
    _resetDemoCacheForTests();
    // Default to dev-bypass active so requests from the test client
    // (loopback) reach the protected branches by default.
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'true';
    delete process.env['DEMO_PREVIEW_DISABLED'];
  });

  afterEach(() => {
    delete process.env['SKYTWIN_DEV_AUTH_BYPASS'];
    delete process.env['DEMO_PREVIEW_DISABLED'];
  });

  // ── /info ──────────────────────────────────────────────────────────

  describe('GET /info', () => {
    it('returns { available: true, userId } when seed exists and dev bypass is active', async () => {
      mockUserRepository.findById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, userId: DEMO_USER_ID });
    });

    it('does NOT leak email or name', async () => {
      mockUserRepository.findById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.body).not.toHaveProperty('email');
      expect(res.body).not.toHaveProperty('name');
    });

    it('returns { available: false } when seed is missing', async () => {
      mockUserRepository.findById.mockResolvedValueOnce(null);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false });
    });

    it('returns { available: false } when dev bypass is disabled (production-like)', async () => {
      process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
      // findById should never be reached because the gate hides the demo first.
      mockUserRepository.findById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false });
    });
  });

  // ── /recipes ───────────────────────────────────────────────────────

  describe('GET /recipes', () => {
    it('returns the canned recipe library (>=6 recipes, #405)', async () => {
      const res = await request(buildApp(), 'GET', '/api/v1/demo/recipes');
      expect(res.status).toBe(200);
      const body = res.body as { recipes: Array<{ slug: string; situation: string }> };
      expect(Array.isArray(body.recipes)).toBe(true);
      expect(body.recipes.length).toBeGreaterThanOrEqual(6);
    });

    it('covers the six named launch workflows', async () => {
      const res = await request(buildApp(), 'GET', '/api/v1/demo/recipes');
      const body = res.body as { recipes: Array<{ slug: string }> };
      const slugs = body.recipes.map((r) => r.slug);
      for (const required of [
        'newsletter-triage',
        'calendar-conflict-resolution',
        'subscription-renewal-review',
        'meeting-prep',
        'expense-report-categorization',
        'recurring-task-auto-handling',
      ]) {
        expect(slugs).toContain(required);
      }
    });

    it('is reachable without a seeded demo user (static, no DB read)', async () => {
      // findById must never be consulted for the recipe library.
      mockUserRepository.findById.mockResolvedValue(null);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/recipes');
      expect(res.status).toBe(200);
      expect(mockUserRepository.findById).not.toHaveBeenCalled();
    });
  });

  // ── /preview ───────────────────────────────────────────────────────

  describe('POST /preview', () => {
    it('returns 400 when situation is missing', async () => {
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {});
      expect(res.status).toBe(400);
      expect((res.body as any).error).toMatch(/situation/i);
    });

    it('returns 400 when situation is empty string', async () => {
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', { situation: '   ' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when situation exceeds 600 chars', async () => {
      const long = 'x'.repeat(601);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', { situation: long });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toMatch(/too long|600/i);
    });

    it('returns 503 when DEMO_PREVIEW_DISABLED is set', async () => {
      // Build the app FIRST (env is read at request time, not router-create time).
      const app = buildApp();
      process.env['DEMO_PREVIEW_DISABLED'] = '1';
      const res = await request(app, 'POST', '/api/v1/demo/preview', { situation: 'test' });
      expect(res.status).toBe(503);
    });

    it('returns 404 when seed user is missing', async () => {
      mockUserRepository.findById.mockResolvedValue(null);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {
        situation: 'A recruiter just emailed me.',
      });
      expect(res.status).toBe(404);
      expect((res.body as any).error).toMatch(/demo profile/i);
    });

    it('returns 200 with prediction body on happy path', async () => {
      mockUserRepository.findById.mockResolvedValue(SEEDED_USER);
      mockWhatWouldIDo.mockResolvedValueOnce(SUCCESSFUL_PREDICTION);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {
        situation: 'A recruiter just emailed me about a senior role.',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        predictedAction: { actionType: 'archive_email' },
        confidence: 'high',
        wouldAutoExecute: true,
        previewRateLimit: { remaining: expect.any(Number), windowMs: 5 * 60 * 1000 },
      });
    });

    it('rate-limits after 20 requests from same IP and returns Retry-After header', async () => {
      mockUserRepository.findById.mockResolvedValue(SEEDED_USER);
      mockWhatWouldIDo.mockResolvedValue(SUCCESSFUL_PREDICTION);
      const app = buildApp();
      app.set('trust proxy', true);
      const clientIp = { 'X-Forwarded-For': '203.0.113.20' };
      // Burn the bucket — 20 requests should succeed, the 21st should 429.
      for (let i = 0; i < 20; i++) {
        const ok = await request(app, 'POST', '/api/v1/demo/preview', { situation: 'ping' }, clientIp);
        expect(ok.status).toBe(200);
      }
      const limited = await request(app, 'POST', '/api/v1/demo/preview', { situation: 'ping' }, clientIp);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(parseInt(limited.headers['retry-after']!, 10)).toBeGreaterThan(0);
    });

    it('rejects malformed JSON situation type without burning the bucket', async () => {
      mockUserRepository.findById.mockResolvedValue(SEEDED_USER);
      mockWhatWouldIDo.mockResolvedValue(SUCCESSFUL_PREDICTION);
      const app = buildApp();
      // Send 5 malformed requests (number instead of string) — these should
      // fail validation BEFORE consuming the rate limit.
      for (let i = 0; i < 5; i++) {
        const bad = await request(app, 'POST', '/api/v1/demo/preview', { situation: 12345 });
        expect(bad.status).toBe(400);
      }
      // Should still have full 20-request budget for legitimate calls.
      for (let i = 0; i < 20; i++) {
        const ok = await request(app, 'POST', '/api/v1/demo/preview', { situation: 'ping' });
        expect(ok.status).toBe(200);
      }
    });
  });
});
