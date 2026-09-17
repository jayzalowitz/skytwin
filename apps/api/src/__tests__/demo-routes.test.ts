import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted runs before vi.mock factories execute.
// ---------------------------------------------------------------------------

const { mockUserRepository, mockWhatWouldIDo } = vi.hoisted(() => ({
  mockUserRepository: {
    findDemoById: vi.fn(),
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
import {
  _resetDemoSessionLifecycleForTests,
  DEMO_SESSION_LIFECYCLE_LIMIT,
  issueDemoSession,
  verifyDemoSession,
} from '../auth/demo-session.js';

const DEMO_USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TEST_FIXTURE = {
  userId: DEMO_USER_ID,
  revision: 'demo-fixture-routes-v1',
} as const;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/demo', createDemoRouter());
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: err.message });
    },
  );
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...extraHeaders,
      };
      const options: RequestInit = { method, headers };
      if (body !== undefined) options.body = JSON.stringify(body);

      fetch(url, options)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          const respHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            respHeaders[k] = v;
          });
          server.close((closeError) => {
            if (closeError) {
              reject(closeError);
              return;
            }
            resolve({ status: res.status, body: json, headers: respHeaders });
          });
        })
        .catch((err) => {
          server.close(() => reject(err));
        });
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
  demo_authority_revision: TEST_FIXTURE.revision,
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
    _resetDemoSessionLifecycleForTests();
    mockUserRepository.findDemoById.mockReset();
    mockWhatWouldIDo.mockReset();
    _resetDemoCacheForTests();
    delete process.env['DEMO_PREVIEW_DISABLED'];
    delete process.env['SKYTWIN_RELEASE_EVIDENCE_NONCE'];
  });

  afterEach(() => {
    delete process.env['DEMO_PREVIEW_DISABLED'];
    delete process.env['SKYTWIN_RELEASE_EVIDENCE_NONCE'];
  });

  // ── /info ──────────────────────────────────────────────────────────

  describe('GET /info', () => {
    it('returns { available: true, userId } when the seed exists', async () => {
      mockUserRepository.findDemoById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, userId: DEMO_USER_ID });
    });

    it('does NOT leak email or name', async () => {
      mockUserRepository.findDemoById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.body).not.toHaveProperty('email');
      expect(res.body).not.toHaveProperty('name');
    });

    it('echoes an opt-in release evidence nonce for process attribution', async () => {
      process.env['SKYTWIN_RELEASE_EVIDENCE_NONCE'] = 'release-run-nonce';
      mockUserRepository.findDemoById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.body).toEqual({
        available: true,
        userId: DEMO_USER_ID,
        instanceNonce: 'release-run-nonce',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns { available: false } when seed is missing', async () => {
      mockUserRepository.findDemoById.mockResolvedValueOnce(null);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false });
    });

    it('remains available when the broad dev bypass is disabled (production-like)', async () => {
      process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'false';
      mockUserRepository.findDemoById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, userId: DEMO_USER_ID });
    });

    it('does not advertise local sample availability to a remote peer', async () => {
      const app = buildApp();
      app.set('trust proxy', true);
      const res = await request(app, 'GET', '/api/v1/demo/info', undefined, {
        'X-Forwarded-For': '203.0.113.8',
      });
      expect(res.status).toBe(403);
      expect(mockUserRepository.findDemoById).not.toHaveBeenCalled();
    });
  });

  // ── /session ───────────────────────────────────────────────────────

  describe('POST /session', () => {
    it('issues a signed, expiring credential bound to the sample user', async () => {
      mockUserRepository.findDemoById.mockResolvedValueOnce(SEEDED_USER);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/session');
      expect(res.status).toBe(201);
      const body = res.body as {
        token: string;
        userId: string;
        expiresAt: string;
      };
      expect(body.userId).toBe(DEMO_USER_ID);
      expect(verifyDemoSession(body.token)).toBe(true);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('returns 404 rather than issuing a credential when the fixture is absent', async () => {
      mockUserRepository.findDemoById.mockResolvedValueOnce(null);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/session');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: expect.stringMatching(/not available/i),
      });
    });

    it('fails closed when the database cannot provide a fixture revision', async () => {
      const { demo_authority_revision: _revision, ...unversionedUser } = SEEDED_USER;
      mockUserRepository.findDemoById.mockResolvedValueOnce(unversionedUser);

      const res = await request(buildApp(), 'POST', '/api/v1/demo/session');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: expect.stringMatching(/authority is unavailable/i),
      });
    });

    it('retires the credential presented during replacement issuance', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      const app = buildApp();
      const first = await request(app, 'POST', '/api/v1/demo/session');
      const firstToken = (first.body as { token: string }).token;
      const second = await request(
        app,
        'POST',
        '/api/v1/demo/session',
        undefined,
        { Authorization: `Bearer ${firstToken}` },
      );
      const secondToken = (second.body as { token: string }).token;

      expect(second.status).toBe(201);
      expect(verifyDemoSession(firstToken)).toBe(false);
      expect(verifyDemoSession(secondToken)).toBe(true);
    });

    it('does not mint from a stale positive info cache after readiness is revoked', async () => {
      mockUserRepository.findDemoById
        .mockResolvedValueOnce(SEEDED_USER)
        .mockResolvedValueOnce(null);
      expect(
        (await request(buildApp(), 'GET', '/api/v1/demo/info')).status,
      ).toBe(200);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/session');
      expect(res.status).toBe(404);
    });

    it('keeps the packaged credential issuer on the local device', async () => {
      const app = buildApp();
      app.set('trust proxy', true);
      const res = await request(
        app,
        'POST',
        '/api/v1/demo/session',
        undefined,
        { 'X-Forwarded-For': '203.0.113.8' },
      );
      expect(res.status).toBe(403);
      expect(mockUserRepository.findDemoById).not.toHaveBeenCalled();
    });

    it('rate-limits repeated local credential issuance', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      const app = buildApp();
      for (let index = 0; index < 12; index += 1) {
        const issued = await request(app, 'POST', '/api/v1/demo/session');
        expect(issued.status).toBe(201);
      }
      const limited = await request(app, 'POST', '/api/v1/demo/session');
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('cannot split the issuance bucket with attacker-controlled IPv6 zones', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      const app = buildApp();
      app.set('trust proxy', 1);
      for (let index = 0; index < 12; index += 1) {
        const issued = await request(
          app,
          'POST',
          '/api/v1/demo/session',
          undefined,
          { 'X-Forwarded-For': `::1%zone-${index}` },
        );
        expect(issued.status).toBe(201);
      }
      const limited = await request(
        app,
        'POST',
        '/api/v1/demo/session',
        undefined,
        { 'X-Forwarded-For': '::1%one-more-zone' },
      );
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('maps lifecycle capacity refusal to a retryable 429 without evicting authority', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      const sessions = Array.from(
        { length: DEMO_SESSION_LIFECYCLE_LIMIT },
        () => issueDemoSession(TEST_FIXTURE),
      );

      const limited = await request(
        buildApp(),
        'POST',
        '/api/v1/demo/session',
      );

      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(verifyDemoSession(sessions[0]!.token)).toBe(true);
      expect(verifyDemoSession(sessions.at(-1)!.token)).toBe(true);
    });
  });

  // ── /recipes ───────────────────────────────────────────────────────

  describe('GET /recipes', () => {
    it('returns the canned recipe library (>=6 recipes, #405)', async () => {
      const res = await request(buildApp(), 'GET', '/api/v1/demo/recipes');
      expect(res.status).toBe(200);
      const body = res.body as {
        recipes: Array<{ slug: string; situation: string }>;
      };
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
      // The fixture lookup must never be consulted for the recipe library.
      mockUserRepository.findDemoById.mockResolvedValue(null);
      const res = await request(buildApp(), 'GET', '/api/v1/demo/recipes');
      expect(res.status).toBe(200);
      expect(mockUserRepository.findDemoById).not.toHaveBeenCalled();
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
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {
        situation: '   ',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when situation exceeds 600 chars', async () => {
      const long = 'x'.repeat(601);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {
        situation: long,
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toMatch(/too long|600/i);
    });

    it('returns 503 when DEMO_PREVIEW_DISABLED is set', async () => {
      // Build the app FIRST (env is read at request time, not router-create time).
      const app = buildApp();
      process.env['DEMO_PREVIEW_DISABLED'] = '1';
      const res = await request(app, 'POST', '/api/v1/demo/preview', {
        situation: 'test',
      });
      expect(res.status).toBe(503);
    });

    it('returns 404 when seed user is missing', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(null);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {
        situation: 'A recruiter just emailed me.',
      });
      expect(res.status).toBe(404);
      expect((res.body as any).error).toMatch(/demo profile/i);
    });

    it('returns 200 with prediction body on happy path', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      mockWhatWouldIDo.mockResolvedValueOnce(SUCCESSFUL_PREDICTION);
      const res = await request(buildApp(), 'POST', '/api/v1/demo/preview', {
        situation: 'A recruiter just emailed me about a senior role.',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        predictedAction: { actionType: 'archive_email' },
        confidence: 'high',
        wouldAutoExecute: true,
        previewRateLimit: {
          remaining: expect.any(Number),
          windowMs: 5 * 60 * 1000,
        },
      });
    });

    it('rate-limits after 20 requests from same IP and returns Retry-After header', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      mockWhatWouldIDo.mockResolvedValue(SUCCESSFUL_PREDICTION);
      const app = buildApp();
      app.set('trust proxy', true);
      const clientIp = { 'X-Forwarded-For': '203.0.113.20' };
      // Burn the bucket — 20 requests should succeed, the 21st should 429.
      for (let i = 0; i < 20; i++) {
        const ok = await request(
          app,
          'POST',
          '/api/v1/demo/preview',
          { situation: 'ping' },
          clientIp,
        );
        expect(ok.status).toBe(200);
      }
      const limited = await request(
        app,
        'POST',
        '/api/v1/demo/preview',
        { situation: 'ping' },
        clientIp,
      );
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(parseInt(limited.headers['retry-after']!, 10)).toBeGreaterThan(0);
    });

    it('rejects malformed JSON situation type without burning the bucket', async () => {
      mockUserRepository.findDemoById.mockResolvedValue(SEEDED_USER);
      mockWhatWouldIDo.mockResolvedValue(SUCCESSFUL_PREDICTION);
      const app = buildApp();
      // Send 5 malformed requests (number instead of string) — these should
      // fail validation BEFORE consuming the rate limit.
      for (let i = 0; i < 5; i++) {
        const bad = await request(app, 'POST', '/api/v1/demo/preview', {
          situation: 12345,
        });
        expect(bad.status).toBe(400);
      }
      // Should still have full 20-request budget for legitimate calls.
      for (let i = 0; i < 20; i++) {
        const ok = await request(app, 'POST', '/api/v1/demo/preview', {
          situation: 'ping',
        });
        expect(ok.status).toBe(200);
      }
    });
  });
});
