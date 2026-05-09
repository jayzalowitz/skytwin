import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockMcpServerRepo, mockDxtExportRepo, mockDxtImportRepo, mockProvenanceRepo, mockQuery } = vi.hoisted(() => ({
  mockMcpServerRepo: {
    getById: vi.fn(),
    getByUserAndRegistry: vi.fn(),
  },
  mockDxtExportRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
  },
  mockDxtImportRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    markRejected: vi.fn(),
    markInstalled: vi.fn(),
    markFailed: vi.fn(),
  },
  mockProvenanceRepo: {
    writeNode: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: mockMcpServerRepo,
  dxtExportRepository: mockDxtExportRepo,
  dxtImportRepository: mockDxtImportRepo,
  provenanceRepository: mockProvenanceRepo,
  query: mockQuery,
}));

import { createDxtRouter } from '../routes/dxt.js';

const USER_ID = 'ffffffff-eeee-dddd-cccc-111111111111';
const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const EXPORT_ID = 'bbbbbbbb-cccc-dddd-eeee-333333333333';
const IMPORT_ID = 'cccccccc-dddd-eeee-ffff-444444444444';

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Mirror production session-auth middleware: set req.authenticatedUserId.
    req.authenticatedUserId = userId;
    next();
  });
  app.use('/api/dxt', createDxtRouter());
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

function makeMcpServerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVER_ID,
    user_id: USER_ID,
    registry_id: 'notion-mcp',
    display_name: 'Notion',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: {},
    url: null,
    oauth_provider: null,
    oauth_token_id: null,
    trust_tier: 'observer',
    per_app_spend_per_action_cents: 100,
    per_app_daily_spend_cents: 500,
    per_app_monthly_spend_cents: 2000,
    per_app_monthly_rollover: false,
    per_app_irreversible_requires_approval: true,
    zero_trust_mode: false,
    status: 'active',
    last_health_check_at: new Date(),
    health_status: 'healthy',
    last_active_at: new Date(),
    installed_at: new Date(),
    uninstalled_at: null,
    auto_promote_paused_until: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/dxt/export/:serverId', () => {
  it('returns 400 for invalid UUID', async () => {
    const app = buildApp();
    const result = await req(app, 'POST', '/api/dxt/export/not-a-uuid');
    expect(result.status).toBe(400);
  });

  it('returns 404 when capability server not found', async () => {
    mockMcpServerRepo.getById.mockResolvedValueOnce(null);
    const app = buildApp();
    const result = await req(app, 'POST', `/api/dxt/export/${SERVER_ID}`);
    expect(result.status).toBe(404);
  });

  it('returns 403 when user does not own the server', async () => {
    mockMcpServerRepo.getById.mockResolvedValueOnce(makeMcpServerRow({ user_id: 'someone-else' }));
    const app = buildApp();
    const result = await req(app, 'POST', `/api/dxt/export/${SERVER_ID}`);
    expect(result.status).toBe(403);
  });

  it('happy path: serializes, persists, returns blob', async () => {
    mockMcpServerRepo.getById.mockResolvedValueOnce(makeMcpServerRow());
    const fakeRow = {
      id: EXPORT_ID,
      user_id: USER_ID,
      server_id: SERVER_ID,
      exported_at: new Date('2026-05-08T00:00:00Z'),
      artifact_blob: Buffer.alloc(48),
      artifact_sha256: Buffer.alloc(32),
    };
    mockDxtExportRepo.create.mockResolvedValueOnce(fakeRow);

    const app = buildApp();
    const result = await req(app, 'POST', `/api/dxt/export/${SERVER_ID}`);

    expect(result.status).toBe(201);
    const body = result.body as Record<string, unknown>;
    expect(body['id']).toBe(EXPORT_ID);
    expect(typeof body['blob']).toBe('string');
    expect(typeof body['sha256']).toBe('string');

    expect(mockDxtExportRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        serverId: SERVER_ID,
        blob: expect.any(Buffer),
        sha256: expect.any(Buffer),
      }),
    );
  });
});

describe('GET /api/dxt/exports', () => {
  it('returns metadata only (no blob bytes in response)', async () => {
    mockDxtExportRepo.listForUser.mockResolvedValueOnce([
      {
        id: EXPORT_ID,
        user_id: USER_ID,
        server_id: SERVER_ID,
        exported_at: new Date('2026-05-08T00:00:00Z'),
        artifact_blob: Buffer.alloc(123),
        artifact_sha256: Buffer.alloc(32, 0xab),
      },
    ]);
    const app = buildApp();
    const result = await req(app, 'GET', '/api/dxt/exports');

    expect(result.status).toBe(200);
    const body = result.body as { exports: Array<Record<string, unknown>> };
    expect(body.exports).toHaveLength(1);
    expect(body.exports[0]!['id']).toBe(EXPORT_ID);
    expect(body.exports[0]!['blobBytes']).toBe(123);
    expect(body.exports[0]).not.toHaveProperty('artifact_blob');
  });
});

describe('GET /api/dxt/exports/:id/blob', () => {
  it('returns 403 when user does not own the export', async () => {
    mockDxtExportRepo.findById.mockResolvedValueOnce({
      id: EXPORT_ID,
      user_id: 'someone-else',
      server_id: SERVER_ID,
      exported_at: new Date(),
      artifact_blob: Buffer.alloc(48),
      artifact_sha256: Buffer.alloc(32),
    });
    const app = buildApp();
    const result = await req(app, 'GET', `/api/dxt/exports/${EXPORT_ID}/blob`);
    expect(result.status).toBe(403);
  });
});

describe('POST /api/dxt/import', () => {
  it('returns 400 when blob is missing', async () => {
    const app = buildApp();
    const result = await req(app, 'POST', '/api/dxt/import', {});
    expect(result.status).toBe(400);
  });

  it('returns 400 with a typed code when blob is garbage', async () => {
    const app = buildApp();
    // Build a 64-byte buffer that's longer than HEADER_LENGTH (48) so we reach
    // the magic check rather than being rejected as TRUNCATED.
    const garbage = Buffer.alloc(64, 0xff).toString('base64');
    const result = await req(app, 'POST', '/api/dxt/import', { blob: garbage });
    expect(result.status).toBe(400);
    const body = result.body as { code?: string };
    expect(body.code).toBe('MAGIC_MISMATCH');
  });

  it('happy path: round-trips export → import preview', async () => {
    // Export first
    mockMcpServerRepo.getById.mockResolvedValueOnce(makeMcpServerRow());
    mockDxtExportRepo.create.mockImplementationOnce(async (input) => ({
      id: EXPORT_ID,
      user_id: input.userId,
      server_id: input.serverId,
      exported_at: new Date(),
      artifact_blob: input.blob,
      artifact_sha256: input.sha256,
    }));
    const app = buildApp();
    const exportResult = await req(app, 'POST', `/api/dxt/export/${SERVER_ID}`);
    expect(exportResult.status).toBe(201);
    const blob = (exportResult.body as { blob: string }).blob;

    // Now import preview
    mockMcpServerRepo.getByUserAndRegistry.mockResolvedValueOnce(null);
    mockDxtImportRepo.create.mockResolvedValueOnce({
      id: IMPORT_ID,
      user_id: USER_ID,
      imported_at: new Date(),
      artifact_blob: Buffer.alloc(0),
      artifact_sha256: Buffer.alloc(32),
      registry_id: 'notion-mcp',
      source_instance_id: null,
      status: 'pending',
      installed_server_id: null,
      rejected_at: null,
      installed_at: null,
      error_message: null,
    });
    const importResult = await req(app, 'POST', '/api/dxt/import', { blob });
    expect(importResult.status).toBe(200);
    const importBody = importResult.body as Record<string, unknown>;
    expect(importBody['importId']).toBe(IMPORT_ID);
    expect(importBody['preview']).toBeDefined();
    expect(importBody['alreadyInstalled']).toBe(false);
    expect(typeof importBody['sha256']).toBe('string');
  });
});
