/**
 * Tests for GET /api/capabilities/provenance-graph and buildEvidencePreview (#184).
 *
 * Coverage:
 *   - filter by nodeType works
 *   - filter by since works
 *   - edge selection respects the returned node set (edges with both endpoints in set)
 *   - PII in payload is redacted before response is sent
 *   - buildEvidencePreview: email kind strips PII
 *   - buildEvidencePreview: file_image only for image MIME <= 512KB
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ── Mocks (vi.hoisted so factories run before vi.mock) ─────────────────────

const {
  mockMcpServerRepository,
  mockAppSuggestionRepository,
  mockProvenanceRepository,
  mockQuery,
} = vi.hoisted(() => ({
  mockMcpServerRepository: {
    getById: vi.fn(),
    listForUser: vi.fn(),
    listActive: vi.fn(),
    softDelete: vi.fn(),
    updateLastActive: vi.fn(),
    markDormant: vi.fn(),
    markPaused: vi.fn(),
    markActive: vi.fn(),
    markAllPausedForUser: vi.fn(),
    markAllResumedForUser: vi.fn(),
    getInactiveSince: vi.fn(),
    updateTrustTier: vi.fn(),
    pauseAutoPromotion: vi.fn(),
    getByUserAndRegistry: vi.fn(),
  },
  mockAppSuggestionRepository: {
    getPendingForUser: vi.fn(),
    getActiveForUser: vi.fn(),
    markDismissed: vi.fn(),
    markSnoozed: vi.fn(),
  },
  mockProvenanceRepository: {
    getForServer: vi.fn(),
    writeNode: vi.fn(),
    writeEdge: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepository,
  appSuggestionRepository: mockAppSuggestionRepository,
  provenanceRepository: mockProvenanceRepository,
  query: mockQuery,
}));

vi.mock('@skytwin/registry-client', () => ({
  RegistryClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@skytwin/policy-engine', () => ({
  TrustTierEngine: vi.fn().mockImplementation(() => ({
    evaluateProgression: vi.fn().mockReturnValue({
      shouldChange: false,
      currentTier: 'observer',
      reason: 'Stable.',
    }),
  })),
}));

vi.mock('@skytwin/shared-types', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    PROMOTION_THRESHOLDS: {
      observer: {
        consecutiveApprovals: 10,
        minApprovalRatio: 0.8,
        nextTier: 'suggest',
      },
    },
  };
});

vi.mock('../sse.js', () => ({
  sseManager: { emit: vi.fn() },
  SSE_CAPABILITY_SUGGESTED: 'capability:suggested',
  SSE_CAPABILITY_INSTALLED: 'capability:installed',
  SSE_CAPABILITY_HEALTH: 'capability:health',
  SSE_CAPABILITY_PROMOTION_OFFERED: 'capability:promotion-offered',
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { createCapabilitiesRouter, buildEvidencePreview, redactPayload } from '../routes/capabilities.js';

// ── Constants ─────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/api/capabilities', createCapabilitiesRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function req(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const opts: RequestInit = { method, headers };
      if (body !== undefined) opts.body = JSON.stringify(body);
      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function makeNode(overrides: Partial<{
  id: string;
  node_type: string;
  ref_table: string;
  ref_id: string;
  server_id: string | null;
  occurred_at: Date;
  payload: unknown;
}> = {}) {
  return {
    id: overrides.id ?? 'node-aaaa-0000-0000-0000-000000000001',
    node_type: overrides.node_type ?? 'install',
    ref_table: overrides.ref_table ?? 'mcp_servers',
    ref_id: overrides.ref_id ?? USER_ID,
    server_id: overrides.server_id ?? null,
    occurred_at: overrides.occurred_at ?? new Date('2026-04-01T10:00:00Z'),
    payload: overrides.payload ?? { displayName: 'Test Server' },
  };
}

// ── Tests: GET /api/capabilities/provenance-graph ─────────────────────────

describe('GET /api/capabilities/provenance-graph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockAppSuggestionRepository.getPendingForUser.mockResolvedValue([]);
    mockMcpServerRepository.listForUser.mockResolvedValue([]);
  });

  it('returns nodes and empty edges when no edges exist', async () => {
    const nodes = [
      makeNode({ id: 'node-0001-0000-0000-0000-000000000001', node_type: 'install' }),
      makeNode({ id: 'node-0002-0000-0000-0000-000000000001', node_type: 'signal' }),
    ];
    // First query returns nodes, second returns edges (empty)
    mockQuery
      .mockResolvedValueOnce({ rows: nodes, rowCount: nodes.length })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}`,
    );

    expect(status).toBe(200);
    const typedBody = body as { nodes: unknown[]; edges: unknown[] };
    expect(typedBody.nodes).toHaveLength(2);
    expect(typedBody.edges).toHaveLength(0);
  });

  it('filters by nodeType when provided', async () => {
    const node = makeNode({ node_type: 'install' });
    mockQuery
      .mockResolvedValueOnce({ rows: [node], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}&nodeType=install`,
    );

    expect(status).toBe(200);
    // Verify the query was called with the nodeType filter in the params
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('node_type'),
      expect.arrayContaining(['install']),
    );
    const typedBody = body as { nodes: Array<{ type: string }> };
    expect(typedBody.nodes.every((n) => n.type === 'install')).toBe(true);
  });

  it('filters by since timestamp when provided', async () => {
    const node = makeNode({ occurred_at: new Date('2026-05-01T00:00:00Z') });
    mockQuery
      .mockResolvedValueOnce({ rows: [node], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const since = '2026-04-01T00:00:00Z';
    const { status } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}&since=${encodeURIComponent(since)}`,
    );

    expect(status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('occurred_at'),
      expect.arrayContaining([new Date(since)]),
    );
  });

  it('only returns edges where both endpoints are in the returned node set', async () => {
    const nodeA = makeNode({ id: 'aaaaaaaa-0000-0000-0000-000000000011' });
    const nodeB = makeNode({ id: 'bbbbbbbb-0000-0000-0000-000000000022' });
    // Edge connects A->B (both in set) — should be returned
    const edgeInSet = {
      from_node_id: nodeA.id,
      to_node_id: nodeB.id,
      edge_type: 'contributed_to',
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [nodeA, nodeB], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [edgeInSet], rowCount: 1 });

    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}`,
    );

    expect(status).toBe(200);
    const typedBody = body as {
      nodes: unknown[];
      edges: Array<{ from: string; to: string; relation: string }>;
    };
    expect(typedBody.edges).toHaveLength(1);
    expect(typedBody.edges[0]!.from).toBe(nodeA.id);
    expect(typedBody.edges[0]!.to).toBe(nodeB.id);
    expect(typedBody.edges[0]!.relation).toBe('contributed_to');

    // Verify the edge query uses ANY($1::uuid[]) with the node IDs
    const secondCall = mockQuery.mock.calls[1];
    expect(secondCall).toBeDefined();
    const queryStr = secondCall![0] as string;
    expect(queryStr).toContain('ANY($1::uuid[])');
  });

  it('redacts PII fields in node payloads before sending', async () => {
    const nodeWithPii = makeNode({
      id: 'pii-node-0000-0000-0000-000000000001',
      payload: {
        displayName: 'Test',
        email: 'user@example.com',
        token: 'supersecret',
        nestedObj: { password: 'pa$$word', normalField: 'safe' },
      },
    });

    mockQuery
      .mockResolvedValueOnce({ rows: [nodeWithPii], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}`,
    );

    expect(status).toBe(200);
    const typedBody = body as {
      nodes: Array<{ payload: Record<string, unknown> }>;
    };
    expect(typedBody.nodes).toHaveLength(1);
    const payload = typedBody.nodes[0]!.payload;
    // PII fields must be redacted
    expect(payload['email']).toBe('[REDACTED]');
    expect(payload['token']).toBe('[REDACTED]');
    // Nested PII must also be redacted
    const nested = payload['nestedObj'] as Record<string, unknown>;
    expect(nested['password']).toBe('[REDACTED]');
    expect(nested['normalField']).toBe('safe');
    // Non-PII fields must be preserved
    expect(payload['displayName']).toBe('Test');
  });

  it('returns 400 when userId is missing', async () => {
    const appNoUser = express();
    appNoUser.use(express.json());
    appNoUser.use('/api/capabilities', createCapabilitiesRouter());
    const { status } = await req(appNoUser, 'GET', '/api/capabilities/provenance-graph');
    expect(status).toBe(400);
  });

  it('returns 400 when serverId is not a valid UUID', async () => {
    const { status } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}&serverId=not-a-uuid`,
    );
    expect(status).toBe(400);
  });

  // #193 follow-up: provenance graph filtered to a Lifebook wing.
  it('filters by wing when provided', async () => {
    const node = makeNode({ node_type: 'install' });
    mockQuery
      .mockResolvedValueOnce({ rows: [node], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const wingId = 'cccccccc-1111-2222-3333-444444444444';
    const { status } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}&wing=${wingId}`,
    );

    expect(status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('wing_id'),
      expect.arrayContaining([wingId]),
    );
  });

  it('returns 400 when wing is not a valid UUID', async () => {
    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}&wing=not-a-uuid`,
    );
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toMatch(/wing/);
  });

  it('includes wingId on each node in the response', async () => {
    const wingId = 'dddddddd-1111-2222-3333-555555555555';
    const node = {
      ...makeNode({ id: 'aaaaaaaa-9999-0000-0000-000000000001' }),
      wing_id: wingId,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [node], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/capabilities/provenance-graph?userId=${USER_ID}`,
    );
    expect(status).toBe(200);
    const typedBody = body as { nodes: Array<{ wingId: string | null }> };
    expect(typedBody.nodes[0]?.wingId).toBe(wingId);
  });
});

// ── Tests: buildEvidencePreview helper ────────────────────────────────────

describe('buildEvidencePreview', () => {
  it('returns email kind with redacted snippet for email signals', () => {
    const signal = {
      kind: 'email',
      subject: 'Hello from user@example.com',
      body: 'Please call me at 555-123-4567. My email is test@domain.org. Here is more text to fill the buffer and reach 80 chars.',
    };
    const preview = buildEvidencePreview(signal);
    expect(preview.kind).toBe('email');
    // Email in subject must be redacted
    expect(preview.subject).not.toContain('user@example.com');
    expect(preview.subject).toContain('[email]');
    // Snippet must be truncated to 80 chars and redact PII
    expect((preview.snippet ?? '').length).toBeLessThanOrEqual(80);
    expect(preview.snippet).not.toContain('test@domain.org');
    // Phone should be redacted
    expect(preview.snippet).not.toContain('555-123-4567');
  });

  it('returns calendar kind with event title and start time', () => {
    const signal = {
      kind: 'calendar',
      title: 'Team standup',
      start_time: '2026-05-01T09:00:00Z',
    };
    const preview = buildEvidencePreview(signal);
    expect(preview.kind).toBe('calendar');
    expect(preview.eventTitle).toBe('Team standup');
    expect(preview.startTime).toBe('2026-05-01T09:00:00Z');
  });

  it('returns file_image kind with thumbnail for small image files', () => {
    const signal = {
      kind: 'file',
      file_name: 'screenshot.png',
      mime_type: 'image/png',
      size_bytes: 100 * 1024, // 100KB — under limit
      data_url: 'data:image/png;base64,abc123',
    };
    const preview = buildEvidencePreview(signal);
    expect(preview.kind).toBe('file_image');
    expect(preview.thumbnailDataUrl).toBe('data:image/png;base64,abc123');
    expect(preview.fileName).toBe('screenshot.png');
    expect(preview.fileExt).toBe('.png');
  });

  it('returns file_other kind for large image files (over 512KB)', () => {
    const signal = {
      kind: 'file',
      file_name: 'bigimage.png',
      mime_type: 'image/png',
      size_bytes: 600 * 1024, // 600KB — over limit
      data_url: 'data:image/png;base64,bigdata',
    };
    const preview = buildEvidencePreview(signal);
    expect(preview.kind).toBe('file_other');
    expect(preview.thumbnailDataUrl).toBeUndefined();
    expect(preview.fileName).toBe('bigimage.png');
  });

  it('returns code_file kind with language and firstImports but NO raw content', () => {
    const signal = {
      kind: 'code_file',
      language: 'typescript',
      imports: ['express', 'vitest', 'zod'],
      rawContent: 'const secret = "supersecret"', // must NOT appear in output
    };
    const preview = buildEvidencePreview(signal);
    expect(preview.kind).toBe('code_file');
    expect(preview.language).toBe('typescript');
    expect(preview.firstImports).toEqual(['express', 'vitest', 'zod']);
    // rawContent must not be in the preview
    expect(JSON.stringify(preview)).not.toContain('supersecret');
    expect(JSON.stringify(preview)).not.toContain('rawContent');
  });

  it('returns unknown kind for unrecognised signal kinds', () => {
    const preview = buildEvidencePreview({ kind: 'bluetooth_scan', data: 'xyz' });
    expect(preview.kind).toBe('unknown');
  });
});

// ── Tests: redactPayload helper ────────────────────────────────────────────

describe('redactPayload', () => {
  it('redacts top-level PII fields', () => {
    const result = redactPayload({ email: 'x@y.com', name: 'Alice' })!;
    expect(result['email']).toBe('[REDACTED]');
    expect(result['name']).toBe('Alice');
  });

  it('redacts nested PII fields recursively', () => {
    const result = redactPayload({ outer: { token: 'abc', safe: 1 } })!;
    const outer = result['outer'] as Record<string, unknown>;
    expect(outer['token']).toBe('[REDACTED]');
    expect(outer['safe']).toBe(1);
  });

  it('preserves arrays of primitives unchanged', () => {
    const result = redactPayload({ tags: ['a', 'b'], email: 'x@y.com' })!;
    expect(result['tags']).toEqual(['a', 'b']);
    expect(result['email']).toBe('[REDACTED]');
  });

  it('recurses into arrays of objects (fixes PII leak via array payloads)', () => {
    const result = redactPayload({
      contacts: [
        { name: 'Alice', email: 'a@x.com' },
        { name: 'Bob', token: 'secret-bob' },
      ],
    })!;
    const contacts = result['contacts'] as Array<Record<string, unknown>>;
    expect(contacts).toHaveLength(2);
    expect(contacts[0]?.['name']).toBe('Alice');
    expect(contacts[0]?.['email']).toBe('[REDACTED]');
    expect(contacts[1]?.['token']).toBe('[REDACTED]');
  });

  it('redacts deeply nested PII inside object-in-array-in-object', () => {
    const result = redactPayload({
      people: [{ profile: { authorization: 'Bearer xyz', name: 'Alice' } }],
    })!;
    const people = result['people'] as Array<Record<string, unknown>>;
    const profile = people[0]?.['profile'] as Record<string, unknown>;
    expect(profile['authorization']).toBe('[REDACTED]');
    expect(profile['name']).toBe('Alice');
  });

  it('returns null for null/undefined input', () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeNull();
  });
});
