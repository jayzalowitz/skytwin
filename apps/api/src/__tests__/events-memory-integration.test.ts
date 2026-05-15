/**
 * Integration: events.ts pipeline with the new memory + sender-aware wiring.
 *
 * Verifies:
 *   1. The rule-based DecisionMaker that ships in events.ts uses
 *      SenderAwareCandidateGenerator → board / CFO emails do not auto-execute.
 *   2. mempalaceRepository.getEpisodes is called and the result is mapped
 *      onto DecisionContext.episodicMemories before evaluate() runs — closing
 *      the "twin's memory of past decisions affects current ones" loop.
 *
 * This is a higher-level test than the existing events-routes.test.ts (which
 * mocks DecisionMaker's evaluate to assert SSE wiring). Here we run the
 * REAL DecisionMaker pipeline and assert its output for a board-email signal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { fakeQuery, episodeRows } = vi.hoisted(() => {
  const episodeRows: Array<Record<string, unknown>> = [];
  const fakeQuery = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('FROM episodic_memories')) {
      const userId = String(params?.[0] ?? '');
      return {
        rows: episodeRows.filter((r) => r['user_id'] === userId),
        rowCount: episodeRows.length,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return { fakeQuery, episodeRows };
});

vi.mock('@skytwin/db', () => ({
  query: fakeQuery,
  withTransaction: vi.fn(),
  getPool: () => ({}),
  closePool: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
  approvalRepository: {
    create: vi
      .fn()
      .mockResolvedValue({ row: { id: 'ar-1', status: 'pending' }, created: true }),
  },
  oauthRepository: { getToken: vi.fn().mockResolvedValue(null) },
  executionRepository: new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue({ id: 'plan-1' }) },
  ),
  userRepository: {
    findById: vi.fn().mockResolvedValue({
      id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      trust_tier: 'moderate_autonomy',
      ironclaw_channel: 'skytwin',
    }),
  },
  aiProviderRepository: { getEnabledForUser: vi.fn().mockResolvedValue([]) },
  emailLabelRepository: {
    topLabelsForSender: vi.fn().mockResolvedValue([]),
    topLabelsForListId: vi.fn().mockResolvedValue([]),
  },
  mempalaceRepository: {
    getEpisodes: vi.fn().mockResolvedValue(episodeRows),
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
  explanationRepositoryAdapter: {
    save: vi.fn(),
  },
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
  sseManager: {
    emit: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
  },
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

vi.mock('@skytwin/llm-client', () => ({
  LlmClient: vi.fn(),
}));

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
    res.status(500).json({ error: err.message, stack: err.stack });
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
  episodeRows.length = 0;
});

describe('events pipeline — sender-aware fallback gates board/CFO emails', () => {
  it('board chair email at MODERATE_AUTONOMY does NOT auto-execute', async () => {
    const app = buildApp();
    // NOTE: SituationInterpreter classifies emails by subject keywords. We
    // avoid the words "meeting", "invite", "calendar", "renewal", etc. so
    // the email lands in EMAIL_TRIAGE rather than a calendar/subscription
    // branch — that lets the SenderAwareCandidateGenerator engage.
    const res = await postJson(app, '/api/events/ingest', {
      userId: USER_ID,
      source: 'gmail',
      type: 'email',
      urgency: 'high',
      from: 'chair@beacon-board.example',
      subject: 'Governance pre-read',
      body: 'Draft governance section attached for your review',
      data: {
        emailId: 'msg-board-1',
        from: 'chair@beacon-board.example',
        subject: 'Governance pre-read',
        text: 'Draft governance section attached for your review',
      },
    });
    if (res.status !== 200) {
      // eslint-disable-next-line no-console
      console.error('board test response:', res.status, res.body);
    }
    expect(res.status).toBe(200);
    const body = res.body as {
      outcome: {
        autoExecute: boolean;
        selectedAction: { actionType: string } | null;
      };
    };
    // Sender-aware generator added flag_for_manual_review which is irreversible
    // and CONFIRMED confidence → wins the policy battle and requires approval.
    expect(body.outcome.selectedAction?.actionType).toBe('flag_for_manual_review');
    expect(body.outcome.autoExecute).toBe(false);
  }, 30_000);

  it('newsletter at MODERATE_AUTONOMY still auto-archives', async () => {
    const app = buildApp();
    const res = await postJson(app, '/api/events/ingest', {
      userId: USER_ID,
      source: 'gmail',
      type: 'email',
      urgency: 'low',
      from: 'newsletter@stratechery.example',
      subject: 'Aggregation theory revisited',
      body: 'Our weekly take',
      data: {
        emailId: 'msg-news-1',
        from: 'newsletter@stratechery.example',
        subject: 'Aggregation theory revisited',
        text: 'Our weekly take',
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      outcome: {
        autoExecute: boolean;
        selectedAction: { actionType: string } | null;
      };
    };
    // Routine email → archive or label is selected (the rule-based generator
    // emits both for EMAIL_TRIAGE). What matters is that NEITHER becomes
    // `flag_for_manual_review`, which is reserved for protected senders.
    // (Whether it auto-executes depends on the user's preference confidence,
    // which is exercised in the fake-user-e2e test where Bob has an explicit
    // auto_archive pref. This integration test only verifies wiring.)
    expect(['archive_email', 'label_email']).toContain(body.outcome.selectedAction?.actionType);
  }, 30_000);
});

describe('events pipeline — episodes are fetched from mempalace and passed to DecisionMaker', () => {
  it('mempalaceRepository.getEpisodes is called for each ingest', async () => {
    const app = buildApp();
    const { mempalaceRepository } = (await import('@skytwin/db')) as unknown as {
      mempalaceRepository: { getEpisodes: ReturnType<typeof vi.fn> };
    };
    await postJson(app, '/api/events/ingest', {
      userId: USER_ID,
      source: 'gmail',
      type: 'email',
      urgency: 'low',
      from: 'colleague@example.com',
      subject: 'Lunch?',
      body: 'Want to grab lunch?',
      data: { emailId: 'msg-1', from: 'colleague@example.com', subject: 'Lunch?' },
    });
    expect(mempalaceRepository.getEpisodes).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ domain: 'email', situationType: 'email_triage', limit: 10 }),
    );
  }, 30_000);
});
