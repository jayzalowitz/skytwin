/**
 * Full-loop end-to-end test:
 *   1. Twin sees signal A. DecisionMaker proposes action X.
 *   2. User rejects X via /api/approvals/:id/respond.
 *      → mempalaceRepository.createEpisode is called with utility 0.0.
 *   3. Twin sees signal B (similar to A).
 *   4. The recorded rejection episode is in episodicMemories on the second
 *      DecisionContext, so DecisionMaker.calculateEpisodicBoost subtracts
 *      from the rejected action's score.
 *
 * What we assert:
 *   - The first ingest completes and produces a decision outcome.
 *   - The approval responds with 200 and creates an episode row.
 *   - The second ingest's outcome reflects the episode (verified by
 *     observing that mempalaceRepository.getEpisodes was called and
 *     returned the first decision's rejection episode in scope).
 *
 * The point of this test is to prove the wiring exists end-to-end through
 * real route handlers — the unit-level "boost actually shifts scores" is
 * already covered in `twin-learns-from-corrections.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  fakeQuery,
  episodeStore,
  approvalStore,
  approvalsByDecisionId,
} = vi.hoisted(() => {
  const episodeStore: Array<Record<string, unknown>> = [];
  // `approvalStore` is keyed by approval id and serves findById/respond
  // (the test manually inserts a row at `'app-respondable'` to bridge to
  // the response step). `approvalsByDecisionId` mirrors the real
  // repository's conflict semantics — migration 046's unique index is on
  // `approval_requests(decision_id)`, so the mock's `created` flag must
  // be derived from decisionId presence, NOT from id presence.
  const approvalStore = new Map<string, Record<string, unknown>>();
  const approvalsByDecisionId = new Map<string, Record<string, unknown>>();
  const fakeQuery = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('FROM episodic_memories')) {
      const userId = String(params?.[0] ?? '');
      return {
        rows: episodeStore.filter((r) => r['user_id'] === userId),
        rowCount: episodeStore.length,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return { fakeQuery, episodeStore, approvalStore, approvalsByDecisionId };
});

vi.mock('@skytwin/db', () => {
  const decisionStore = new Map<string, Record<string, unknown>>();
  return {
    query: fakeQuery,
    withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: fakeQuery }),
    ),
    getPool: () => ({}),
    closePool: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
    approvalRepository: {
      create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
        // The real repository conflicts on `decision_id` (migration 046's
        // unique index), so derive `created` from decisionId presence
        // rather than from id presence — otherwise two creates with
        // different decisionIds would falsely look like a re-ingestion
        // just because the mock had reused an id. `approvalStore` is
        // still id-keyed so findById/respond and the manual
        // `approvalStore.set('app-respondable', …)` bridge at line ~344
        // keep working unchanged.
        const decisionId = String(input['decisionId'] ?? '');
        const existing = approvalsByDecisionId.get(decisionId);
        if (existing) {
          return { row: existing, created: false };
        }
        const row = { id: `app-${approvalsByDecisionId.size + 1}`, ...input, status: 'pending' };
        approvalStore.set(String(row.id), row);
        approvalsByDecisionId.set(decisionId, row);
        return { row, created: true };
      }),
      findById: vi.fn().mockImplementation(async (id: string) => approvalStore.get(id) ?? null),
      respond: vi.fn().mockImplementation(async (id: string, action: string) => {
        const row = approvalStore.get(id);
        if (!row) return null;
        const updated = {
          ...row,
          status: action === 'approve' ? 'approved' : 'rejected',
          responded_at: new Date(),
        };
        approvalStore.set(id, updated);
        return updated;
      }),
      deleteStaleEscalations: vi.fn().mockResolvedValue(0),
    },
    decisionRepository: {
      findById: vi.fn().mockImplementation(async (id: string) => decisionStore.get(id) ?? null),
      findByIds: vi.fn().mockImplementation(async (ids: string[]) =>
        [...decisionStore.values()].filter((d) => ids.includes(d['id'] as string)),
      ),
      getCandidateActionsForDecisions: vi.fn().mockResolvedValue([]),
      getOutcomesForDecisions: vi.fn().mockResolvedValue([]),
    },
    feedbackRepository: {
      create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
        id: 'fb-' + Math.random().toString(36).slice(2),
        ...input,
      })),
    },
    mempalaceRepository: {
      getEpisodes: vi.fn().mockImplementation(async (userId: string) =>
        episodeStore.filter((e) => e['user_id'] === userId),
      ),
      createEpisode: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
        const row = {
          id: 'ep-' + Math.random().toString(36).slice(2),
          user_id: input['userId'],
          domain: input['domain'],
          situation_type: input['situationType'],
          situation_summary: input['situationSummary'],
          action_taken: input['actionTaken'],
          context_snapshot: '{}',
          outcome: null,
          feedback_type: input['feedbackType'],
          feedback_detail: input['feedbackDetail'],
          decision_id: input['decisionId'],
          signal_ids: [],
          drawer_ids: [],
          utility_score: input['utilityScore'],
          created_at: new Date(),
          updated_at: new Date(),
        };
        episodeStore.push(row);
        return row;
      }),
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
      saveDecision: vi.fn().mockImplementation(async (d: unknown) => {
        const decision = d as Record<string, unknown>;
        decisionStore.set(decision['id'] as string, {
          id: decision['id'],
          user_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
          situation_type: decision['situationType'],
          domain: decision['domain'],
          urgency: decision['urgency'],
          interpreted_situation: { summary: decision['summary'] },
          raw_event: decision['rawData'] ?? {},
          metadata: {},
          signal_id: null,
          created_at: new Date(),
        });
        return { decision: d, created: true };
      }),
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
  };
});

vi.mock('../execution-setup.js', () => ({
  getExecutionRouter: vi.fn().mockResolvedValue({
    executeWithRoutingStreaming: async function* () {},
    executeWithRouting: async () => ({ success: false }),
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
import { createApprovalsRouter } from '../routes/approvals.js';

const USER_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: USER_ID };
    next();
  });
  app.use('/api/events', createEventsRouter());
  app.use('/api/approvals', createApprovalsRouter());
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
  episodeStore.length = 0;
  approvalStore.clear();
  approvalsByDecisionId.clear();
});

describe('full-loop E2E: signal → approve/reject → next signal carries the episode', () => {
  it('rejection of action X is reflected in the next decision context as an episodicMemory', async () => {
    const app = buildApp();
    const db = (await import('@skytwin/db')) as unknown as {
      mempalaceRepository: {
        getEpisodes: ReturnType<typeof vi.fn>;
        createEpisode: ReturnType<typeof vi.fn>;
      };
      approvalRepository: { create: ReturnType<typeof vi.fn> };
    };

    // Step 1: ingest a board email — sender-aware fallback emits
    // flag_for_manual_review (irreversible CONFIRMED) which the policy
    // engine routes to require_approval. autoExecute=false → events.ts
    // creates an approval request the user can respond to.
    const r1 = await postJson(app, '/api/events/ingest', {
      userId: USER_ID,
      source: 'gmail',
      type: 'email',
      urgency: 'high',
      from: 'chair@beacon-board.example',
      subject: 'Governance pre-read',
      body: 'Draft governance section attached',
      data: {
        emailId: 'msg-1',
        from: 'chair@beacon-board.example',
        subject: 'Governance pre-read',
      },
    });
    expect(r1.status).toBe(200);
    const out1 = (r1.body as { outcome: { selectedAction: { actionType: string } | null; id: string; decisionId: string; autoExecute: boolean } }).outcome;
    expect(out1.selectedAction).not.toBeNull();
    expect(out1.autoExecute).toBe(false);
    const firstActionType = out1.selectedAction!.actionType;
    expect(firstActionType).toBe('flag_for_manual_review');
    const firstDecisionId = out1.decisionId;

    // The events.ts path created an approval request. Find it in the store.
    expect(db.approvalRepository.create).toHaveBeenCalled();
    // Manually link to a stable id for the response step (the actual id
    // generated by events.ts is opaque; in production the dashboard would
    // GET the user's approvals and use the returned id).
    approvalStore.set('app-respondable', {
      id: 'app-respondable',
      user_id: USER_ID,
      decision_id: firstDecisionId,
      candidate_action: out1.selectedAction,
      status: 'pending',
    });

    // Step 2: user rejects via the approvals route
    const r2 = await postJson(app, '/api/approvals/app-respondable/respond', {
      action: 'reject',
      userId: USER_ID,
      reason: 'I want to read these myself',
    });
    expect(r2.status).toBe(200);

    // The approval handler should have called createEpisode → episodeStore now has a row
    expect(db.mempalaceRepository.createEpisode).toHaveBeenCalled();
    expect(episodeStore.length).toBe(1);
    const episode = episodeStore[0]!;
    expect(episode['action_taken']).toBe(firstActionType);
    expect(episode['feedback_type']).toBe('reject');

    // Step 3: ingest a similar signal
    const r3 = await postJson(app, '/api/events/ingest', {
      userId: USER_ID,
      source: 'gmail',
      type: 'email',
      urgency: 'low',
      from: 'colleague@example.com',
      subject: 'Another question',
      body: 'Got another minute?',
      data: { emailId: 'msg-2', from: 'colleague@example.com', subject: 'Another question' },
    });
    expect(r3.status).toBe(200);

    // Verify mempalaceRepository.getEpisodes was called for the second
    // ingest. Its return value (episodeStore) carries the rejection
    // episode which gets mapped onto DecisionContext.episodicMemories
    // for the call to DecisionMaker.evaluate. The unit test
    // `twin-learns-from-corrections.test.ts` proves that
    // calculateEpisodicBoost actually consumes that field; this test
    // proves the pipeline plumbs it.
    const calls = db.mempalaceRepository.getEpisodes.mock.calls;
    // At least one call from each ingest (events.ts + approvals.ts paths)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Verify a call matched the second ingest's domain/situationType
    const matchingCall = calls.find(
      (c) => c[0] === USER_ID && c[1] && (c[1] as Record<string, unknown>)['domain'] === 'email',
    );
    expect(matchingCall).toBeDefined();
  }, 30_000);
});
