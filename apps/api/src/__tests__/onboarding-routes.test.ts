/**
 * Tests for the onboarding router — issue #181.
 *
 * Coverage:
 *   1. GET /state returns isFirstRun=true for a new user with no memory / servers
 *   2. POST /dialogue with LLM returns question or final
 *   3. POST /dialogue without LLM falls back to first deterministic question
 *   4. POST /deterministic-pick with all 3 answers returns correct recipe slug
 *   5. POST /complete records first_run_choice and returns ok
 *   6. Ownership check: userId missing → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Hoist mocks ──────────────────────────────────────────────────────────────

const { mockGetLlmClient, mockRunPrompt } = vi.hoisted(() => ({
  mockGetLlmClient: vi.fn(),
  mockRunPrompt: vi.fn(),
}));

vi.mock('../lib/llm-client-factory.js', () => ({
  getLlmClientFromConfig: mockGetLlmClient,
  getLlmClientFromConfigFresh: vi.fn().mockReturnValue(null),
  _resetLlmClientCache: vi.fn(),
}));

vi.mock('@skytwin/policy-prompts', () => ({
  runPrompt: mockRunPrompt,
}));

const {
  mockOnboardingRepository,
  mockMcpServerRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockOnboardingRepository: {
    getForUser: vi.fn(),
    ensureRow: vi.fn(),
    markComplete: vi.fn(),
    setFirstRun: vi.fn(),
  },
  mockMcpServerRepository: {
    listForUser: vi.fn().mockResolvedValue([]),
  },
  mockQuery: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }),
}));

vi.mock('@skytwin/db', () => ({
  onboardingRepository: mockOnboardingRepository,
  mcpServerRepository: mockMcpServerRepository,
  query: mockQuery,
}));

// ── Import router under test ─────────────────────────────────────────────────

import { createOnboardingRouter } from '../routes/onboarding.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  // Simulate sessionAuth + requireOwnership injecting req.user
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)['user'] = { id: userId };
    next();
  });
  app.use('/api/onboarding', createOnboardingRouter());
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
      const options: RequestInit = { method: method.toUpperCase(), headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/onboarding/state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmClient.mockReturnValue(null);
    // No episodic memories
    mockQuery.mockResolvedValue({ rows: [{ count: '0' }] });
    // No installed servers
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
  });

  it('returns isFirstRun=true for a new user with no memory or servers', async () => {
    const app = buildApp();
    const { status, body } = await request(app, 'get', '/api/onboarding/state');
    expect(status).toBe(200);
    const b = body as { isFirstRun: boolean; hasMemory: boolean; hasInstalledServers: boolean; hasLlmProvider: boolean };
    expect(b.isFirstRun).toBe(true);
    expect(b.hasMemory).toBe(false);
    expect(b.hasInstalledServers).toBe(false);
  });

  it('returns isFirstRun=false when user has installed servers', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { id: 'srv-1', status: 'active' },
    ]);
    const app = buildApp();
    const { status, body } = await request(app, 'get', '/api/onboarding/state');
    expect(status).toBe(200);
    expect((body as { isFirstRun: boolean }).isFirstRun).toBe(false);
  });

  it('reports hasLlmProvider=true when LLM client is available', async () => {
    mockGetLlmClient.mockReturnValue({ hasProviders: true });
    const app = buildApp();
    const { body } = await request(app, 'get', '/api/onboarding/state');
    expect((body as { hasLlmProvider: boolean }).hasLlmProvider).toBe(true);
  });
});

describe('POST /api/onboarding/dialogue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a question when LLM is available and prompt succeeds', async () => {
    mockGetLlmClient.mockReturnValue({ hasProviders: true });
    mockRunPrompt.mockResolvedValue({
      output: { type: 'question', text: 'What do you primarily work on?' },
      fellBackToDeterministic: false,
      cached: false,
      latencyMs: 50,
    });

    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/dialogue', {
      history: [],
    });

    expect(status).toBe(200);
    const b = body as { kind: string; question?: string };
    expect(b.kind).toBe('question');
    expect(typeof b.question).toBe('string');
  });

  it('returns final recommendation when LLM recommends a recipe', async () => {
    mockGetLlmClient.mockReturnValue({ hasProviders: true });
    mockRunPrompt.mockResolvedValue({
      output: {
        type: 'recommendation',
        recipeSlug: 'developer-pack',
        recommendedRegistryIds: ['@modelcontextprotocol/server-github'],
        summary: 'Great for engineers',
      },
      fellBackToDeterministic: false,
      cached: false,
      latencyMs: 120,
    });

    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/dialogue', {
      history: [
        { role: 'assistant', content: 'What do you do?' },
        { role: 'user', content: 'I am a software engineer' },
        { role: 'assistant', content: 'Which tools do you use?' },
        { role: 'user', content: 'GitHub and Linear' },
      ],
    });

    expect(status).toBe(200);
    const b = body as { kind: string; recipeSlug?: string };
    expect(b.kind).toBe('final');
    expect(b.recipeSlug).toBe('developer-pack');
  });

  it('falls back to deterministic first question when no LLM configured', async () => {
    mockGetLlmClient.mockReturnValue(null);

    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/dialogue', {
      history: [],
    });

    expect(status).toBe(200);
    const b = body as { kind: string; question?: string; options?: string[] };
    expect(b.kind).toBe('question');
    expect(typeof b.question).toBe('string');
    // Deterministic path provides options
    expect(Array.isArray(b.options)).toBe(true);
    expect((b.options ?? []).length).toBeGreaterThan(0);
  });

  it('returns 400 when userId is missing (no user on req)', async () => {
    // Build app without injecting req.user
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', createOnboardingRouter());
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const { status } = await request(app, 'post', '/api/onboarding/dialogue', { history: [] });
    expect(status).toBe(400);
  });
});

describe('POST /api/onboarding/deterministic-pick', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns developer-pack for software_engineer + notion + github', async () => {
    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/deterministic-pick', {
      answers: { work: 'software_engineer', notes_app: 'notion', primary_tool: 'github' },
    });
    expect(status).toBe(200);
    const b = body as { recipeSlug: string; recommendedRegistryIds: string[] };
    expect(b.recipeSlug).toBe('developer-pack');
    expect(Array.isArray(b.recommendedRegistryIds)).toBe(true);
    expect(b.recommendedRegistryIds.length).toBeGreaterThan(0);
  });

  it('returns productivity-pack for designer', async () => {
    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/deterministic-pick', {
      answers: { work: 'designer', notes_app: 'notion', primary_tool: 'slack' },
    });
    expect(status).toBe(200);
    expect((body as { recipeSlug: string }).recipeSlug).toBe('productivity-pack');
  });

  it('returns productivity-pack as default when work is unrecognised', async () => {
    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/deterministic-pick', {
      answers: {},
    });
    expect(status).toBe(200);
    expect((body as { recipeSlug: string }).recipeSlug).toBe('productivity-pack');
  });
});

describe('POST /api/onboarding/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnboardingRepository.markComplete.mockResolvedValue({
      user_id: USER_ID,
      is_first_run: false,
      first_run_choice: 'about-me',
      selected_recipe_slug: 'productivity-pack',
      completed_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
  });

  it('marks the wizard complete and returns ok', async () => {
    const app = buildApp();
    const { status, body } = await request(app, 'post', '/api/onboarding/complete', {
      choice: 'about-me',
      recipeSlug: 'productivity-pack',
    });
    expect(status).toBe(200);
    const b = body as { ok: boolean; state: { is_first_run: boolean } };
    expect(b.ok).toBe(true);
    expect(b.state.is_first_run).toBe(false);
  });

  it('calls markComplete with the correct arguments', async () => {
    const app = buildApp();
    await request(app, 'post', '/api/onboarding/complete', {
      choice: 'email',
      recipeSlug: 'developer-pack',
    });
    expect(mockOnboardingRepository.markComplete).toHaveBeenCalledWith(
      USER_ID,
      'email',
      'developer-pack',
    );
  });

  it('returns 400 for an invalid choice value', async () => {
    const app = buildApp();
    const { status } = await request(app, 'post', '/api/onboarding/complete', {
      choice: 'invalid',
    });
    expect(status).toBe(400);
  });

  it('returns 400 when userId is missing (no user on req)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', createOnboardingRouter());
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const { status } = await request(app, 'post', '/api/onboarding/complete', {
      choice: 'about-me',
    });
    expect(status).toBe(400);
  });
});
