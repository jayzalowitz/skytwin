/**
 * @file risk-profile-routes.test.ts
 * Tests for GET/PUT /api/risk-profile and POST /api/risk-profile/reinterpret (#190).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRiskProfileRepository } = vi.hoisted(() => ({
  mockRiskProfileRepository: {
    getForUser: vi.fn(),
    upsert: vi.fn(),
    updateInterpretedCaps: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  riskProfileRepository: mockRiskProfileRepository,
}));

vi.mock('@skytwin/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createRiskProfileRouter } from '../routes/risk-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const OTHER_USER_ID = 'ffffffff-eeee-dddd-cccc-000000000099';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/api/risk-profile', createRiskProfileRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function buildAppNoUser(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/risk-profile', createRiskProfileRouter());
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

function makeRow(overrides: Partial<{
  user_id: string;
  profile_text: string;
  interpreted_caps: Record<string, unknown>;
  last_interpreted_at: Date | null;
  last_model_version: string | null;
}> = {}) {
  return {
    user_id: overrides.user_id ?? USER_ID,
    profile_text: overrides.profile_text ?? 'I want low risk.',
    interpreted_caps: overrides.interpreted_caps ?? {},
    last_interpreted_at: overrides.last_interpreted_at ?? null,
    last_model_version: overrides.last_model_version ?? null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-02'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Risk Profile API routes (#190)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // GET /api/risk-profile
  // =========================================================================
  describe('GET /api/risk-profile', () => {
    it('returns defaults when no row exists for the user', async () => {
      mockRiskProfileRepository.getForUser.mockResolvedValue(null);

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', '/api/risk-profile');

      expect(res.status).toBe(200);
      const body = res.body as {
        profileText: string;
        interpretedCaps: Record<string, unknown>;
        lastInterpretedAt: null;
        lastModelVersion: null;
      };
      expect(body.profileText).toBe('');
      expect(body.interpretedCaps).toEqual({});
      expect(body.lastInterpretedAt).toBeNull();
      expect(body.lastModelVersion).toBeNull();
    });

    it('returns stored profile when row exists', async () => {
      const row = makeRow({
        profile_text: 'Keep spend under $10 per action.',
        last_model_version: 'stub-v0',
        last_interpreted_at: new Date('2026-04-01'),
      });
      mockRiskProfileRepository.getForUser.mockResolvedValue(row);

      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', '/api/risk-profile');

      expect(res.status).toBe(200);
      const body = res.body as {
        profileText: string;
        interpretedCaps: Record<string, unknown>;
        lastInterpretedAt: string;
        lastModelVersion: string;
      };
      expect(body.profileText).toBe('Keep spend under $10 per action.');
      expect(body.lastModelVersion).toBe('stub-v0');
      expect(typeof body.lastInterpretedAt).toBe('string');
    });

    it('returns 400 when no userId can be resolved', async () => {
      const app = buildAppNoUser();
      const res = await request(app, 'GET', '/api/risk-profile');
      expect(res.status).toBe(400);
    });

    it('only fetches profile for the requesting user (ownership)', async () => {
      mockRiskProfileRepository.getForUser.mockResolvedValue(null);

      const app = buildApp(USER_ID);
      await request(app, 'GET', '/api/risk-profile');

      expect(mockRiskProfileRepository.getForUser).toHaveBeenCalledWith(USER_ID);
      expect(mockRiskProfileRepository.getForUser).not.toHaveBeenCalledWith(OTHER_USER_ID);
    });
  });

  // =========================================================================
  // PUT /api/risk-profile
  // =========================================================================
  describe('PUT /api/risk-profile', () => {
    it('upserts profile text and returns updated row', async () => {
      const row = makeRow({ profile_text: 'Be cautious.', last_model_version: 'stub-v0' });
      mockRiskProfileRepository.upsert.mockResolvedValue(row);
      mockRiskProfileRepository.updateInterpretedCaps.mockResolvedValue({
        ...row,
        last_interpreted_at: new Date(),
        last_model_version: 'stub-v0',
      });

      const app = buildApp(USER_ID);
      const res = await request(app, 'PUT', '/api/risk-profile', { profileText: 'Be cautious.' });

      expect(res.status).toBe(200);
      const body = res.body as {
        profileText: string;
        interpretedCaps: Record<string, unknown>;
        lastModelVersion: string;
      };
      expect(body.profileText).toBe('Be cautious.');
      expect(body.lastModelVersion).toBe('stub-v0');
      expect(mockRiskProfileRepository.upsert).toHaveBeenCalledWith({
        userId: USER_ID,
        profileText: 'Be cautious.',
      });
    });

    it('stub interpretation stores empty interpretedCaps (TODO #185)', async () => {
      const row = makeRow({ profile_text: 'Low risk please.' });
      mockRiskProfileRepository.upsert.mockResolvedValue(row);
      mockRiskProfileRepository.updateInterpretedCaps.mockResolvedValue({
        ...row,
        last_model_version: 'stub-v0',
        last_interpreted_at: new Date(),
      });

      const app = buildApp(USER_ID);
      await request(app, 'PUT', '/api/risk-profile', { profileText: 'Low risk please.' });

      expect(mockRiskProfileRepository.updateInterpretedCaps).toHaveBeenCalledWith({
        userId: USER_ID,
        interpretedCaps: {},
        modelVersion: 'stub-v0',
      });
    });

    it('returns 400 when profileText is missing', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'PUT', '/api/risk-profile', {});
      expect(res.status).toBe(400);
    });

    it('returns 400 when profileText is not a string', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'PUT', '/api/risk-profile', { profileText: 42 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when no userId can be resolved', async () => {
      const app = buildAppNoUser();
      const res = await request(app, 'PUT', '/api/risk-profile', { profileText: 'hello' });
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/risk-profile/reinterpret
  // =========================================================================
  describe('POST /api/risk-profile/reinterpret', () => {
    it('returns stubbed status (TODO #185)', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', '/api/risk-profile/reinterpret');

      expect(res.status).toBe(200);
      const body = res.body as { status: string; message: string };
      expect(body.status).toBe('stubbed');
      expect(typeof body.message).toBe('string');
      expect(body.message).toContain('#185');
    });

    it('returns 400 when no userId can be resolved', async () => {
      const app = buildAppNoUser();
      const res = await request(app, 'POST', '/api/risk-profile/reinterpret');
      expect(res.status).toBe(400);
    });
  });
});
