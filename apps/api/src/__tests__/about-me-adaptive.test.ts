/**
 * Tests for the self-portrait adaptive path (J).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Factory mock ──────────────────────────────────────────────────────────────
const { mockGetLlmClient } = vi.hoisted(() => ({ mockGetLlmClient: vi.fn() }));
vi.mock('../lib/llm-client-factory.js', () => ({
  getLlmClientFromConfig: mockGetLlmClient,
  getLlmClientFromConfigFresh: vi.fn().mockReturnValue(null),
  _resetLlmClientCache: vi.fn(),
}));

// ── DB mocks ──────────────────────────────────────────────────────────────────
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('@skytwin/db', () => ({ query: mockQuery }));

import { createAboutMeRouter } from '../routes/about-me.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)['user'] = { id: 'user-portrait' };
    next();
  });
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
        reject(new Error('port'));
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
        .catch((err: unknown) => { server.close(); reject(err); });
    });
  });
}

describe('GET /about-me — J: self-portrait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] }); // no facts by default
  });

  // 1. No LLM → placeholder paragraph
  it('returns placeholder paragraph when no LLM is configured', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'GET', '/api/about-me');
    expect(res.status).toBe(200);
    const body = res.body as { paragraphs: Array<{ text: string }>; modelVersion: string };
    expect(Array.isArray(body.paragraphs)).toBe(true);
    expect(body.paragraphs.length).toBeGreaterThanOrEqual(1);
    expect(body.modelVersion).toBe('stub-v0');
  });

  // 2. No facts in DB → placeholder (LLM not called)
  it('returns placeholder when no user facts are available even with LLM', async () => {
    const mockLlm = {
      hasProviders: true,
      generate: vi.fn(),
      generateStream: vi.fn(),
    };
    mockGetLlmClient.mockReturnValue(mockLlm);
    // mockQuery returns empty rows → no facts → LLM not called
    const app = buildApp();
    const res = await request(app, 'GET', '/api/about-me');
    expect(res.status).toBe(200);
    expect((mockLlm.generate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((res.body as { modelVersion: string }).modelVersion).toBe('stub-v0');
  });

  // 3. LLM throws → placeholder fallback
  it('returns placeholder when LLM throws', async () => {
    const mockLlm = {
      hasProviders: true,
      generate: vi.fn().mockRejectedValue(new Error('timeout')),
      generateStream: vi.fn(),
    };
    mockGetLlmClient.mockReturnValue(mockLlm);
    // Return facts so hasFacts=true and LLM is attempted
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('mcp_servers')) {
        return Promise.resolve({ rows: [{ display_name: 'Notion', trust_tier: 'observer' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = buildApp();
    const res = await request(app, 'GET', '/api/about-me');
    expect(res.status).toBe(200);
    expect((res.body as { modelVersion: string }).modelVersion).toBe('stub-v0');
  });

  // 4. POST /correct hard rail: always writes provenance node
  it('POST /correct writes a provenance node (hard rail)', async () => {
    mockGetLlmClient.mockReturnValue(null);
    mockQuery.mockResolvedValue({ rows: [] });

    const app = buildApp();
    const res = await request(app, 'POST', '/api/about-me/correct', {
      paragraphIndex: 0,
      sentenceIndex: 1,
      correction: 'I actually prefer TypeScript.',
    });

    expect(res.status).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO capability_provenance_nodes'),
      expect.any(Array),
    );
  });

  // 5. POST /correct with missing fields → 400
  it('POST /correct returns 400 when correction is missing', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/about-me/correct', {
      paragraphIndex: 0,
      sentenceIndex: 0,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('correction');
  });
});
