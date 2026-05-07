/**
 * @file about-me-routes.test.ts
 * Tests for GET /api/about-me and POST /api/about-me/correct (#190).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  query: mockQuery,
}));

vi.mock('@skytwin/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createAboutMeRouter } from '../routes/about-me.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

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
  app.use('/api/about-me', createAboutMeRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function buildAppNoUser(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/about-me', createAboutMeRouter());
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('About Me API routes (#190)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  // =========================================================================
  // GET /api/about-me
  // =========================================================================
  describe('GET /api/about-me', () => {
    it('returns stub self-portrait with paragraphs array (TODO #185)', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'GET', '/api/about-me');

      expect(res.status).toBe(200);
      const body = res.body as {
        paragraphs: Array<{ text: string; citations: unknown[] }>;
        generatedAt: string;
        modelVersion: string;
      };
      expect(Array.isArray(body.paragraphs)).toBe(true);
      expect(body.paragraphs.length).toBeGreaterThan(0);
      // Each paragraph has text and citations
      for (const p of body.paragraphs) {
        expect(typeof p.text).toBe('string');
        expect(Array.isArray(p.citations)).toBe(true);
      }
      expect(typeof body.generatedAt).toBe('string');
      expect(body.modelVersion).toBe('stub-v0');
    });

    it('returns 400 when no userId can be resolved', async () => {
      const app = buildAppNoUser();
      const res = await request(app, 'GET', '/api/about-me');
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/about-me/correct
  // =========================================================================
  describe('POST /api/about-me/correct', () => {
    it('records a correction and returns success', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', '/api/about-me/correct', {
        paragraphIndex: 0,
        sentenceIndex: 1,
        correction: 'I prefer more conservative actions.',
      });

      expect(res.status).toBe(200);
      const body = res.body as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('writes a provenance feedback node on every correction (hard rail)', async () => {
      const app = buildApp(USER_ID);
      await request(app, 'POST', '/api/about-me/correct', {
        paragraphIndex: 0,
        sentenceIndex: 0,
        correction: 'This is wrong.',
      });

      expect(mockQuery).toHaveBeenCalled();
      const callArgs = mockQuery.mock.calls;
      const provenanceInsert = callArgs.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          (args[0] as string).includes('capability_provenance_nodes'),
      );
      expect(provenanceInsert).toBeDefined();
    });

    it('returns 400 when paragraphIndex is missing', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', '/api/about-me/correct', {
        sentenceIndex: 0,
        correction: 'Fix this.',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when correction is empty string', async () => {
      const app = buildApp(USER_ID);
      const res = await request(app, 'POST', '/api/about-me/correct', {
        paragraphIndex: 0,
        sentenceIndex: 0,
        correction: '   ',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when no userId can be resolved', async () => {
      const app = buildAppNoUser();
      const res = await request(app, 'POST', '/api/about-me/correct', {
        paragraphIndex: 0,
        sentenceIndex: 0,
        correction: 'Fix this.',
      });
      expect(res.status).toBe(400);
    });
  });
});
