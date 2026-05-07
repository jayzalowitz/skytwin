/**
 * Tests for the adaptive risk-profile-interpretation path (I).
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

import { createRiskProfileRouter } from '../routes/risk-profile.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)['user'] = { id: 'user-risk' };
    next();
  });
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

describe('PUT /risk-profile — I: risk-profile-interpretation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRiskProfileRepository.upsert.mockResolvedValue(undefined);
    mockRiskProfileRepository.getForUser.mockResolvedValue(null);
  });

  // 1. No LLM → stores {}
  it('stores empty interpretedCaps when no LLM is configured', async () => {
    mockGetLlmClient.mockReturnValue(null);
    mockRiskProfileRepository.updateInterpretedCaps.mockResolvedValue({
      profile_text: 'Some text',
      interpreted_caps: {},
      last_interpreted_at: new Date(),
      last_model_version: 'stub-v0',
    });

    const app = buildApp();
    const res = await request(app, 'PUT', '/api/risk-profile', {
      profileText: 'Some risk profile text',
    });

    expect(res.status).toBe(200);
    const call = mockRiskProfileRepository.updateInterpretedCaps.mock.calls[0]![0] as {
      interpretedCaps: Record<string, unknown>;
      modelVersion: string;
    };
    expect(call.interpretedCaps).toEqual({});
    expect(call.modelVersion).toBe('stub-v0');
  });

  // 2. LLM throws → graceful {} fallback (still 200)
  it('stores empty interpretedCaps when LLM throws', async () => {
    const mockLlm = {
      hasProviders: true,
      generate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      generateStream: vi.fn(),
    };
    mockGetLlmClient.mockReturnValue(mockLlm);
    mockRiskProfileRepository.updateInterpretedCaps.mockResolvedValue({
      profile_text: 'text',
      interpreted_caps: {},
      last_interpreted_at: new Date(),
      last_model_version: 'adaptive-v1',
    });

    const app = buildApp();
    const res = await request(app, 'PUT', '/api/risk-profile', {
      profileText: 'Risk profile text',
    });

    expect(res.status).toBe(200);
    expect(mockRiskProfileRepository.updateInterpretedCaps).toHaveBeenCalled();
  });

  // 3. Missing profileText → 400
  it('returns 400 when profileText is missing', async () => {
    mockGetLlmClient.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app, 'PUT', '/api/risk-profile', {});
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('profileText');
  });
});

describe('POST /risk-profile/reinterpret — I: reinterpret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRiskProfileRepository.updateInterpretedCaps.mockResolvedValue({
      profile_text: 'text',
      interpreted_caps: {},
      last_interpreted_at: new Date(),
      last_model_version: 'stub-v0',
    });
  });

  // 4. No profile → returns no_profile status
  it('returns no_profile when no profile text is saved', async () => {
    mockGetLlmClient.mockReturnValue(null);
    mockRiskProfileRepository.getForUser.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app, 'POST', '/api/risk-profile/reinterpret');
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('no_profile');
  });

  // 5. No LLM → returns no_llm status
  it('returns no_llm status when no LLM configured', async () => {
    mockGetLlmClient.mockReturnValue(null);
    mockRiskProfileRepository.getForUser.mockResolvedValue({
      profile_text: 'I am a developer.',
      interpreted_caps: {},
      last_interpreted_at: null,
      last_model_version: null,
    });
    const app = buildApp();
    const res = await request(app, 'POST', '/api/risk-profile/reinterpret');
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('no_llm');
  });
});
