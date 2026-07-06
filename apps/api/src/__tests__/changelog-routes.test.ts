import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const SERVER_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OPT_IN_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID    = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const {
  mockMcpServerRepo,
  mockChangelogRepo,
  mockAppSuggestionRepo,
  mockQuery,
  mockProvenanceRepo,
  mockMetricsRepo,
} = vi.hoisted(() => ({
  mockMcpServerRepo: {
    getById: vi.fn(),
    listForUser: vi.fn(),
    listActive: vi.fn(),
    markDormant: vi.fn(),
    markPaused: vi.fn(),
    markActive: vi.fn(),
    softDelete: vi.fn(),
    updateLastActive: vi.fn(),
    getInactiveSince: vi.fn(),
    markAllPausedForUser: vi.fn(),
    markAllResumedForUser: vi.fn(),
    updateTrustTier: vi.fn(),
    pauseAutoPromotion: vi.fn(),
  },
  mockChangelogRepo: {
    getForServer: vi.fn(),
    upsert: vi.fn(),
    addPendingOptIn: vi.fn(),
    listPendingOptInsForUser: vi.fn(),
    acceptOptIn: vi.fn(),
    rejectOptIn: vi.fn(),
    hasPendingOptIn: vi.fn(),
  },
  mockAppSuggestionRepo: {
    getPendingForUser: vi.fn().mockResolvedValue([]),
    getActiveForUser: vi.fn().mockResolvedValue([]),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockQuery: vi.fn().mockResolvedValue({ rows: [] }),
  mockProvenanceRepo: {
    getForServer: vi.fn().mockResolvedValue([]),
    writeNode: vi.fn().mockResolvedValue(undefined),
  },
  mockMetricsRepo: {
    getSparkline: vi.fn().mockResolvedValue([]),
    getRecent: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepo,
  mcpServerChangelogRepository: mockChangelogRepo,
  appSuggestionRepository: mockAppSuggestionRepo,
  provenanceRepository: mockProvenanceRepo,
  mcpServerMetricsRepository: mockMetricsRepo,
  query: mockQuery,
}));

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn(function RegistryClient() {
    return {
    search: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock('@skytwin/policy-engine', () => ({
  TrustTierEngine: vi.fn(function TrustTierEngine() {
    return {
    evaluateProgression: vi.fn().mockReturnValue({ shouldChange: false, reason: 'not enough' }),
    };
  }),
}));

vi.mock('@skytwin/shared-types', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@skytwin/shared-types')>();
  return {
    ...orig,
    PROMOTION_THRESHOLDS: {},
  };
});

vi.mock('../lib/llm-client-factory.js', () => ({
  getLlmClientFromConfig: vi.fn().mockReturnValue(null),
}));

vi.mock('../sse.js', () => ({
  sseManager: { emitAll: vi.fn(), emit: vi.fn() },
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability:promotion-offered',
}));

// ---------------------------------------------------------------------------
// App + fetch helper
// ---------------------------------------------------------------------------

import { createCapabilitiesRouter } from '../routes/capabilities.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Inject userId from query param for tests (mimics session-auth middleware)
  app.use((req, _res, next) => {
    const userId = req.query['userId'] as string | undefined;
    if (userId) {
      (req as unknown as { user: { id: string } }).user = { id: userId };
    }
    next();
  });
  app.use('/api/capabilities', createCapabilitiesRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function httpRequest(
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

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
  app = buildApp();
});

// ---------------------------------------------------------------------------
// GET /:id/changelog
// ---------------------------------------------------------------------------

describe('GET /api/capabilities/:id/changelog', () => {
  const changelogRow = {
    server_id: SERVER_ID,
    current_version: '1.4.0',
    raw_text: '## v1.4.0\n\nAdded create_database.',
    fetched_at: new Date('2026-05-01'),
    last_seen_skills: ['create_database', 'read_page'],
    last_known_destructive_skills: ['create_database'],
  };

  it('returns changelog when owned by user', async () => {
    mockMcpServerRepo.getById.mockResolvedValue({ id: SERVER_ID, user_id: USER_ID, status: 'active' });
    mockChangelogRepo.getForServer.mockResolvedValue(changelogRow);

    const { status, body } = await httpRequest(
      app, 'GET',
      `/api/capabilities/${SERVER_ID}/changelog?userId=${USER_ID}`,
    );

    expect(status).toBe(200);
    expect((body as { changelog: { current_version: string } }).changelog.current_version).toBe('1.4.0');
  });

  it('returns 404 when no changelog has been fetched', async () => {
    mockMcpServerRepo.getById.mockResolvedValue({ id: SERVER_ID, user_id: USER_ID, status: 'active' });
    mockChangelogRepo.getForServer.mockResolvedValue(null);

    const { status } = await httpRequest(
      app, 'GET',
      `/api/capabilities/${SERVER_ID}/changelog?userId=${USER_ID}`,
    );
    expect(status).toBe(404);
  });

  it('returns 403 when server belongs to another user', async () => {
    mockMcpServerRepo.getById.mockResolvedValue({ id: SERVER_ID, user_id: 'other-user', status: 'active' });

    const { status } = await httpRequest(
      app, 'GET',
      `/api/capabilities/${SERVER_ID}/changelog?userId=${USER_ID}`,
    );
    expect(status).toBe(403);
  });

  it('returns 400 for invalid UUID', async () => {
    const { status } = await httpRequest(
      app, 'GET',
      '/api/capabilities/not-a-uuid/changelog?userId=x',
    );
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /pending-opt-ins
// ---------------------------------------------------------------------------

describe('GET /api/capabilities/pending-opt-ins', () => {
  it('returns pending opt-ins for the user', async () => {
    mockChangelogRepo.listPendingOptInsForUser.mockResolvedValue([
      {
        id: OPT_IN_ID,
        server_id: SERVER_ID,
        skill_name: 'create_database',
        changelog_version: '1.4.0',
        detected_at: new Date('2026-05-01'),
        accepted_at: null,
        rejected_at: null,
        server_display_name: 'Notion',
        server_registry_id: '@notionhq/notion-mcp-server',
      },
    ]);

    const { status, body } = await httpRequest(
      app, 'GET',
      `/api/capabilities/pending-opt-ins?userId=${USER_ID}`,
    );

    expect(status).toBe(200);
    const b = body as { optIns: Array<{ skill_name: string }> };
    expect(b.optIns).toHaveLength(1);
    expect(b.optIns[0]?.skill_name).toBe('create_database');
  });

  it('returns empty array when no pending opt-ins', async () => {
    mockChangelogRepo.listPendingOptInsForUser.mockResolvedValue([]);

    const { status, body } = await httpRequest(
      app, 'GET',
      `/api/capabilities/pending-opt-ins?userId=${USER_ID}`,
    );

    expect(status).toBe(200);
    expect((body as { optIns: unknown[] }).optIns).toHaveLength(0);
  });

  it('returns 400 when userId is missing', async () => {
    const { status } = await httpRequest(
      app, 'GET',
      '/api/capabilities/pending-opt-ins',
    );
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /pending-opt-ins/:id/accept
// ---------------------------------------------------------------------------

describe('POST /api/capabilities/pending-opt-ins/:id/accept', () => {
  it('accepts the opt-in when ownership is verified', async () => {
    mockChangelogRepo.listPendingOptInsForUser.mockResolvedValue([
      {
        id: OPT_IN_ID,
        server_id: SERVER_ID,
        skill_name: 'create_database',
        changelog_version: '1.4.0',
        detected_at: new Date(),
        accepted_at: null,
        rejected_at: null,
        server_display_name: 'Notion',
        server_registry_id: null,
      },
    ]);
    mockChangelogRepo.acceptOptIn.mockResolvedValue({ found: true });

    const { status } = await httpRequest(
      app, 'POST',
      `/api/capabilities/pending-opt-ins/${OPT_IN_ID}/accept?userId=${USER_ID}`,
    );

    expect(status).toBe(204);
    expect(mockChangelogRepo.acceptOptIn).toHaveBeenCalledWith(OPT_IN_ID);
  });

  it('returns 404 when opt-in does not belong to user', async () => {
    mockChangelogRepo.listPendingOptInsForUser.mockResolvedValue([]);

    const { status } = await httpRequest(
      app, 'POST',
      `/api/capabilities/pending-opt-ins/${OPT_IN_ID}/accept?userId=${USER_ID}`,
    );
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /pending-opt-ins/:id/reject
// ---------------------------------------------------------------------------

describe('POST /api/capabilities/pending-opt-ins/:id/reject', () => {
  it('rejects the opt-in when ownership is verified', async () => {
    mockChangelogRepo.listPendingOptInsForUser.mockResolvedValue([
      {
        id: OPT_IN_ID,
        server_id: SERVER_ID,
        skill_name: 'create_database',
        changelog_version: null,
        detected_at: new Date(),
        accepted_at: null,
        rejected_at: null,
        server_display_name: 'Notion',
        server_registry_id: null,
      },
    ]);
    mockChangelogRepo.rejectOptIn.mockResolvedValue({ found: true });

    const { status } = await httpRequest(
      app, 'POST',
      `/api/capabilities/pending-opt-ins/${OPT_IN_ID}/reject?userId=${USER_ID}`,
    );

    expect(status).toBe(204);
    expect(mockChangelogRepo.rejectOptIn).toHaveBeenCalledWith(OPT_IN_ID);
  });

  it('returns 404 when opt-in does not belong to user', async () => {
    mockChangelogRepo.listPendingOptInsForUser.mockResolvedValue([]);

    const { status } = await httpRequest(
      app, 'POST',
      `/api/capabilities/pending-opt-ins/${OPT_IN_ID}/reject?userId=${USER_ID}`,
    );
    expect(status).toBe(404);
  });
});
