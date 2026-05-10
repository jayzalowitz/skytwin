/**
 * Verifies that incoming /api/events/ingest calls write into the gbrain
 * memory backend (not just the legacy mempalace tables). Without this,
 * brain_pages stays empty in production and searchSemantic returns nothing
 * even though memory IS supposed to be the gbrain default.
 *
 * Strategy: stub the @skytwin/db query layer so we can run getMemoryPortForUser
 * end-to-end and see whether brain_pages INSERTs hit our SQL fake.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { fakeQuery, brainPagesInserts } = vi.hoisted(() => {
  const brainPagesInserts: Array<{ text: string; params: unknown[] }> = [];
  const fakeQuery = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('INSERT INTO brain_pages')) {
      brainPagesInserts.push({ text, params: params ?? [] });
      // Return a fake row that looks like brain_pages
      const id = String(params?.[0] ?? 'page-fake');
      const userId = String(params?.[1] ?? '');
      return {
        rows: [
          {
            id,
            user_id: userId,
            title: params?.[2] ?? '',
            content: params?.[3] ?? '',
            source: params?.[4] ?? '',
            source_ref: params?.[5] ?? null,
            metadata: params?.[6] ?? '{}',
            embedding: params?.[7] ?? null,
            embedding_model: params?.[8] ?? null,
            embedding_dim: params?.[9] ?? null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes('FROM brain_settings')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('INTO brain_signals')) {
      // The repository's insertSignal does `result.rows[0]!` — must return
      // a non-empty row for insertPage to be reached afterwards.
      return {
        rows: [
          {
            id: String(params?.[0] ?? 'sig-fake'),
            user_id: String(params?.[1] ?? ''),
            source: String(params?.[2] ?? ''),
            type: String(params?.[3] ?? ''),
            data: '{}',
            recorded_at: new Date(),
            signal_timestamp: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes('INTO brain_embedding_jobs')) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM episodic_memories')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { fakeQuery, brainPagesInserts };
});

vi.mock('@skytwin/db', () => ({
  query: fakeQuery,
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: fakeQuery }),
  ),
  getPool: () => ({}),
  closePool: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
  approvalRepository: { create: vi.fn() },
  oauthRepository: { getToken: vi.fn().mockResolvedValue(null) },
  executionRepository: new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue({ id: 'plan-1' }) },
  ),
  userRepository: {
    findById: vi.fn().mockResolvedValue({
      id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      trust_tier: 'observer',
      ironclaw_channel: 'skytwin',
    }),
  },
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([]) },
  emailLabelRepository: {
    topLabelsForSender: vi.fn().mockResolvedValue([]),
    topLabelsForListId: vi.fn().mockResolvedValue([]),
  },
  mempalaceRepository: {
    getEpisodes: vi.fn().mockResolvedValue([]),
  },
  TwinRepositoryAdapter: vi.fn().mockImplementation(() => ({
    getProfile: vi.fn().mockResolvedValue(null),
    createProfile: vi.fn().mockImplementation(async (p: unknown) => p),
    updateProfile: vi.fn().mockImplementation(async (p: unknown) => p),
    getPreferences: vi.fn().mockResolvedValue([]),
    getPreferencesByDomain: vi.fn().mockResolvedValue([]),
    upsertPreference: vi.fn(),
    getInferences: vi.fn().mockResolvedValue([]),
    upsertInference: vi.fn(),
    addEvidence: vi.fn(),
    getEvidence: vi.fn().mockResolvedValue([]),
    getEvidenceByIds: vi.fn().mockResolvedValue([]),
    addFeedback: vi.fn(),
    getFeedback: vi.fn().mockResolvedValue([]),
  })),
  PatternRepositoryAdapter: vi.fn().mockImplementation(() => ({
    getPatterns: vi.fn().mockResolvedValue([]),
    upsertPattern: vi.fn(),
    getTraits: vi.fn().mockResolvedValue([]),
    upsertTrait: vi.fn(),
  })),
  decisionRepositoryAdapter: {
    saveDecision: vi.fn().mockImplementation(async (d: unknown) => d),
    saveOutcome: vi.fn().mockImplementation(async (o: unknown) => o),
    saveCandidates: vi.fn().mockImplementation(async (cs: unknown) => cs),
    saveRiskAssessment: vi.fn().mockImplementation(async (r: unknown) => r),
    getDecision: vi.fn().mockResolvedValue(null),
    getOutcome: vi.fn().mockResolvedValue(null),
    getCandidates: vi.fn().mockResolvedValue([]),
    getRiskAssessment: vi.fn().mockResolvedValue(null),
    getRecentDecisions: vi.fn().mockResolvedValue([]),
  },
  explanationRepositoryAdapter: { save: vi.fn() },
  policyRepositoryAdapter: {
    getAllPolicies: vi.fn().mockResolvedValue([]),
    getEnabledPolicies: vi.fn().mockResolvedValue([]),
    getPolicy: vi.fn().mockResolvedValue(null),
    getPoliciesByDomain: vi.fn().mockResolvedValue([]),
    savePolicy: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
  },
}));

vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: vi.fn().mockResolvedValue({
    executeWithRoutingStreaming: async function* () {},
    executeWithRouting: async () => ({ success: false, error: 'no execution in test' }),
  }),
}));

vi.mock('../sse.js', () => ({
  sseManager: { emit: vi.fn(), addClient: vi.fn(), removeClient: vi.fn() },
}));

vi.mock('@skytwin/explanations', () => ({
  ExplanationGenerator: vi.fn().mockImplementation(() => ({
    generate: vi.fn().mockResolvedValue({
      id: 'expl-1',
      decisionId: 'dec-1',
      summary: 'test',
      evidence: [],
      preferences: [],
      alternatives: [],
      reversalInstructions: '',
      generatedAt: new Date(),
    }),
  })),
}));

vi.mock('@skytwin/llm-client', () => ({ LlmClient: vi.fn() }));

vi.mock('@skytwin/core', async () => {
  const actual: typeof import('@skytwin/core') = await vi.importActual('@skytwin/core');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { createEventsRouter } from '../routes/events.js';

const USER_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: USER_ID };
    next();
  });
  app.use('/api/events', createEventsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function postJson(
  app: Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
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

beforeEach(() => {
  fakeQuery.mockClear();
  brainPagesInserts.length = 0;
});

describe('events.ts wires gbrain MemoryPort writes on signal ingest', () => {
  it('inbound email signal results in INSERT INTO brain_pages', async () => {
    const app = buildApp();
    const res = await postJson(app, '/api/events/ingest', {
      userId: USER_ID,
      source: 'gmail',
      type: 'email',
      urgency: 'medium',
      from: 'colleague@example.com',
      subject: 'lunch question',
      body: 'want to grab lunch?',
      data: {
        emailId: 'msg-1',
        from: 'colleague@example.com',
        subject: 'lunch question',
        text: 'want to grab lunch?',
      },
    });
    expect(res.status).toBe(200);
    // The recordSignal path is fire-and-forget — wait for promises to flush.
    await new Promise((r) => setTimeout(r, 1000));
    // We should have at least one brain_pages INSERT for this signal.
    expect(brainPagesInserts.length).toBeGreaterThan(0);
    // The page content should reference the inbound message
    const inserted = brainPagesInserts.find((row) => {
      const content = String(row.params[3] ?? '');
      return content.includes('lunch') || content.includes('colleague');
    });
    expect(inserted).toBeDefined();
  }, 30_000);
});
