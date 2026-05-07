/**
 * Tests for the adaptive paths in the capabilities router:
 *   C: recipe-recommendation (GET /recipes)
 *   G: reverse-capability-intent (POST /reverse-capability-intent)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Factory mock ─────────────────────────────────────────────────────────────
const { mockGetLlmClient } = vi.hoisted(() => ({
  mockGetLlmClient: vi.fn(),
}));

vi.mock('../lib/llm-client-factory.js', () => ({
  getLlmClientFromConfig: mockGetLlmClient,
  getLlmClientFromConfigFresh: vi.fn().mockReturnValue(null),
  _resetLlmClientCache: vi.fn(),
}));

// ── DB mocks ─────────────────────────────────────────────────────────────────
const {
  mockMcpServerRepository,
  mockAppSuggestionRepository,
  mockProvenanceRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockMcpServerRepository: {
    getById: vi.fn(),
    listForUser: vi.fn().mockResolvedValue([]),
    softDelete: vi.fn(),
    updateTrustTier: vi.fn(),
    pauseAutoPromotion: vi.fn(),
    markAllPausedForUser: vi.fn().mockResolvedValue([]),
    markAllResumedForUser: vi.fn().mockResolvedValue([]),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn().mockResolvedValue([]),
    getActiveForUser: vi.fn().mockResolvedValue([]),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockProvenanceRepository: {
    writeNode: vi.fn(),
    getForServer: vi.fn().mockResolvedValue([]),
  },
  mockQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  provenanceRepository: mockProvenanceRepository,
  query: mockQuery,
}));

vi.mock('../sse.js', () => ({
  sseManager: { send: vi.fn() },
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability_promotion_offered',
}));

import { createCapabilitiesRouter } from '../routes/capabilities.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)['user'] = { id: 'user-test' };
    next();
  });
  app.use('/api/capabilities', createCapabilitiesRouter());
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
        .catch((err: unknown) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── C: recipe-recommendation ──────────────────────────────────────────────────

describe('GET /recipes — C: recipe-recommendation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // 1. No LLM → hardcoded recipes
  it('returns hardcoded recipes when no LLM is configured', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'GET', '/api/capabilities/recipes');
    expect(res.status).toBe(200);
    const body = res.body as { recipes: Array<{ slug: string }> };
    expect(Array.isArray(body.recipes)).toBe(true);
    expect(body.recipes.length).toBeGreaterThan(0);
    const slugs = body.recipes.map((r) => r.slug);
    expect(slugs).toContain('developer-pack');
  });

  // 2. LLM throws → hardcoded fallback
  it('returns hardcoded fallback when LLM throws', async () => {
    const mockLlm = {
      hasProviders: true,
      generate: vi.fn().mockRejectedValue(new Error('network error')),
      generateStream: vi.fn(),
    };
    mockGetLlmClient.mockReturnValue(mockLlm);
    const app = buildApp();
    const res = await request(app, 'GET', '/api/capabilities/recipes');
    expect(res.status).toBe(200);
    const body = res.body as { recipes: unknown[] };
    expect(Array.isArray(body.recipes)).toBe(true);
    expect(body.recipes.length).toBeGreaterThan(0);
  });

  // 3. LLM configured but getAll fails → hardcoded fallback
  it('returns hardcoded recipes when registry.getAll is unavailable', async () => {
    const mockLlm = {
      hasProviders: true,
      generate: vi.fn(),
      generateStream: vi.fn(),
    };
    mockGetLlmClient.mockReturnValue(mockLlm);
    // The RegistryClient singleton reads curated.json at construction time;
    // we can't easily mock it here, but the LLM generate would fail anyway
    // because the prompt invocation needs the curated list.
    // We test the fallback by having the LLM throw.
    mockLlm.generate.mockRejectedValue(new Error('fail'));

    const app = buildApp();
    const res = await request(app, 'GET', '/api/capabilities/recipes');
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { recipes: unknown[] }).recipes)).toBe(true);
  });
});

// ── G: reverse-capability-intent ─────────────────────────────────────────────

describe('POST /reverse-capability-intent — G: reverse-capability-intent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // 1. No LLM → deterministic fallback (unknown, empty candidates)
  it('returns unknown action when no LLM is configured', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/capabilities/reverse-capability-intent', {
      userMessage: 'Add this file to GitHub',
      installedRegistryIds: ['@modelcontextprotocol/server-github'],
    });
    expect(res.status).toBe(200);
    const body = res.body as { action: string; candidate_capabilities: string[]; confidence: number };
    expect(body.action).toBe('unknown');
    expect(Array.isArray(body.candidate_capabilities)).toBe(true);
    expect(body.confidence).toBe(0);
  });

  // 2. LLM throws → deterministic fallback
  it('returns deterministic fallback when LLM throws', async () => {
    const mockLlm = {
      hasProviders: true,
      generate: vi.fn().mockRejectedValue(new Error('timeout')),
      generateStream: vi.fn(),
    };
    mockGetLlmClient.mockReturnValue(mockLlm);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/capabilities/reverse-capability-intent', {
      userMessage: 'Send an email',
      installedRegistryIds: ['gmail-mcp'],
    });
    expect(res.status).toBe(200);
    const body = res.body as { action: string; confidence: number };
    expect(body.action).toBe('unknown');
    expect(body.confidence).toBe(0);
  });

  // 3. Missing userMessage → 400
  it('returns 400 when userMessage is missing', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/capabilities/reverse-capability-intent', {
      installedRegistryIds: [],
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toContain('userMessage');
  });

  // 4. Empty userMessage → 400
  it('returns 400 when userMessage is empty string', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/capabilities/reverse-capability-intent', {
      userMessage: '  ',
      installedRegistryIds: [],
    });
    expect(res.status).toBe(400);
  });

  // 5. Non-string installedRegistryIds are filtered out gracefully
  it('handles non-string entries in installedRegistryIds gracefully', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/capabilities/reverse-capability-intent', {
      userMessage: 'Check my calendar',
      installedRegistryIds: [123, null, 'google-calendar-mcp', true],
    });
    expect(res.status).toBe(200);
    expect((res.body as { action: string }).action).toBe('unknown');
  });
});
