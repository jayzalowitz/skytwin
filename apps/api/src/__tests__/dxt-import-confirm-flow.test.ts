/**
 * dxt-import-confirm-flow.test.ts
 *
 * Tests for the DXT import confirm/reject/list flow (#180 follow-up).
 * Covers: POST /import (persist pending row), POST /imports/:id/confirm,
 * POST /imports/:id/reject, GET /imports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockMcpServerRepo,
  mockDxtExportRepo,
  mockDxtImportRepo,
  mockProvenanceRepo,
  mockQuery,
} = vi.hoisted(() => ({
  mockMcpServerRepo: {
    getById: vi.fn(),
    getByUserAndRegistry: vi.fn(),
    listSkillNamesForServer: vi.fn(async () => [] as string[]),
  },
  mockDxtExportRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    listMetadataForUser: vi.fn(),
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
const OTHER_USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const EXPORT_ID = 'bbbbbbbb-cccc-dddd-eeee-333333333333';
const IMPORT_ID = 'cccccccc-dddd-eeee-ffff-444444444444';

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
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

function makePendingImportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // artifact_blob will be populated with a real DXT blob in confirm-flow tests
  return {
    id: IMPORT_ID,
    user_id: USER_ID,
    imported_at: new Date(),
    artifact_blob: Buffer.alloc(0),  // placeholder; overridden in tests that need real blob
    artifact_sha256: Buffer.alloc(32, 0xab),
    registry_id: 'notion-mcp',
    source_instance_id: null,
    status: 'pending',
    installed_server_id: null,
    rejected_at: null,
    installed_at: null,
    error_message: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: query succeeds with inserted server row
  mockQuery.mockResolvedValue({ rows: [{ id: SERVER_ID }], rowCount: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /import — persists pending row + returns importId + preview
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/dxt/import', () => {
  it('returns importId alongside preview on success', async () => {
    // First export to get a valid blob
    mockMcpServerRepo.getById.mockResolvedValueOnce(makeMcpServerRow());
    mockDxtExportRepo.create.mockImplementationOnce(async (input: Record<string, unknown>) => ({
      id: EXPORT_ID,
      user_id: input['userId'],
      server_id: input['serverId'],
      exported_at: new Date(),
      artifact_blob: input['blob'],
      artifact_sha256: input['sha256'],
    }));
    const app = buildApp();
    const exportResult = await req(app, 'POST', `/api/dxt/export/${SERVER_ID}`);
    expect(exportResult.status).toBe(201);
    const blob = (exportResult.body as { blob: string }).blob;

    // Now import preview
    mockMcpServerRepo.getByUserAndRegistry.mockResolvedValueOnce(null);
    mockDxtImportRepo.create.mockResolvedValueOnce(makePendingImportRow());

    const importResult = await req(app, 'POST', '/api/dxt/import', { blob });
    expect(importResult.status).toBe(200);
    const importBody = importResult.body as Record<string, unknown>;
    expect(importBody['importId']).toBe(IMPORT_ID);
    expect(importBody['preview']).toBeDefined();
    expect(importBody['alreadyInstalled']).toBe(false);
    expect(typeof importBody['sha256']).toBe('string');
    // Ensure the old 'note' field is gone — we now return importId
    expect(importBody['note']).toBeUndefined();
  });

  it('returns 400 when blob is missing', async () => {
    const app = buildApp();
    const result = await req(app, 'POST', '/api/dxt/import', {});
    expect(result.status).toBe(400);
  });

  it('returns 400 with typed code when blob is garbage', async () => {
    const app = buildApp();
    const garbage = Buffer.alloc(64, 0xff).toString('base64');
    const result = await req(app, 'POST', '/api/dxt/import', { blob: garbage });
    expect(result.status).toBe(400);
    const body = result.body as { code?: string };
    expect(body.code).toBe('MAGIC_MISMATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /imports/:id/confirm
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/dxt/imports/:id/confirm', () => {
  /**
   * Build a valid export blob and return it alongside a matching pending import row.
   * Requires a pre-built app instance to serialize.
   */
  async function buildValidImportBlob(app: Express): Promise<{ blob: Buffer; sha256: Buffer; blobBase64: string }> {
    mockMcpServerRepo.getById.mockResolvedValueOnce(makeMcpServerRow());
    mockDxtExportRepo.create.mockImplementationOnce(async (input: Record<string, unknown>) => ({
      id: EXPORT_ID,
      user_id: input['userId'],
      server_id: input['serverId'],
      exported_at: new Date(),
      artifact_blob: input['blob'],
      artifact_sha256: input['sha256'],
    }));
    const exportResult = await req(app, 'POST', `/api/dxt/export/${SERVER_ID}`);
    expect(exportResult.status).toBe(201);
    const blobBase64 = (exportResult.body as { blob: string }).blob;
    const blob = Buffer.from(blobBase64, 'base64');

    // Deserialize to get the sha256
    const { deserialize } = await import('@skytwin/dxt');
    const result = deserialize(blob);
    if (!result.success) throw new Error('unexpected deserialize failure in test setup');
    return { blob, sha256: result.data.computedSha256, blobBase64 };
  }

  it('confirm pending import — installs, marks installed, returns serverId', async () => {
    const app = buildApp();
    const { blob, sha256 } = await buildValidImportBlob(app);

    const importRow = makePendingImportRow({ artifact_blob: blob, artifact_sha256: sha256 });
    mockDxtImportRepo.findById.mockResolvedValueOnce(importRow);
    mockDxtImportRepo.markInstalled.mockResolvedValueOnce(undefined);
    mockProvenanceRepo.writeNode.mockResolvedValueOnce({ id: 'prov-1' });
    // mockQuery already set to return { rows: [{ id: SERVER_ID }] }

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/confirm`);
    expect(result.status).toBe(201);
    const body = result.body as Record<string, unknown>;
    expect(body['status']).toBe('installed');
    expect(typeof body['serverId']).toBe('string');
    expect(body['registryId']).toBe('notion-mcp');

    expect(mockDxtImportRepo.markInstalled).toHaveBeenCalledWith(IMPORT_ID, SERVER_ID);
    expect(mockProvenanceRepo.writeNode).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        nodeType: 'manual_install',
        refTable: 'dxt_imports',
        refId: IMPORT_ID,
      }),
    );
  });

  it('returns 400 when import is not pending (already installed)', async () => {
    const app = buildApp();
    mockDxtImportRepo.findById.mockResolvedValueOnce(
      makePendingImportRow({ status: 'installed' }),
    );

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/confirm`);
    expect(result.status).toBe(400);
    const body = result.body as { error: string };
    expect(body.error).toContain('not pending');
  });

  it('returns 400 when import is not pending (already rejected)', async () => {
    const app = buildApp();
    mockDxtImportRepo.findById.mockResolvedValueOnce(
      makePendingImportRow({ status: 'rejected' }),
    );

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/confirm`);
    expect(result.status).toBe(400);
  });

  it('returns 403 when user does not own the import', async () => {
    const app = buildApp(OTHER_USER_ID);
    mockDxtImportRepo.findById.mockResolvedValueOnce(makePendingImportRow());

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/confirm`);
    expect(result.status).toBe(403);
  });

  it('returns 400 and marks failed when stored blob is tampered', async () => {
    const app = buildApp();
    // artifact_blob is garbage — deserialization will fail
    const corruptRow = makePendingImportRow({
      artifact_blob: Buffer.alloc(64, 0xff),
      artifact_sha256: Buffer.alloc(32, 0x00),
    });
    mockDxtImportRepo.findById.mockResolvedValueOnce(corruptRow);
    mockDxtImportRepo.markFailed.mockResolvedValueOnce(undefined);

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/confirm`);
    expect(result.status).toBe(400);
    expect(mockDxtImportRepo.markFailed).toHaveBeenCalledWith(
      IMPORT_ID,
      expect.stringContaining('re-deserialization'),
    );
  });

  it('returns 500 and marks failed when mcp-host/DB insert throws', async () => {
    const app = buildApp();
    const { blob, sha256 } = await buildValidImportBlob(app);

    const importRow = makePendingImportRow({ artifact_blob: blob, artifact_sha256: sha256 });
    mockDxtImportRepo.findById.mockResolvedValueOnce(importRow);
    mockDxtImportRepo.markFailed.mockResolvedValueOnce(undefined);

    // Simulate DB insert throwing
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/confirm`);
    expect(result.status).toBe(500);
    expect(mockDxtImportRepo.markFailed).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /imports/:id/reject
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/dxt/imports/:id/reject', () => {
  it('returns 204 and marks rejected on success', async () => {
    const app = buildApp();
    mockDxtImportRepo.findById.mockResolvedValueOnce(makePendingImportRow());
    mockDxtImportRepo.markRejected.mockResolvedValueOnce(undefined);

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/reject`);
    expect(result.status).toBe(204);
    expect(mockDxtImportRepo.markRejected).toHaveBeenCalledWith(IMPORT_ID);
  });

  it('returns 400 when import is not pending', async () => {
    const app = buildApp();
    mockDxtImportRepo.findById.mockResolvedValueOnce(
      makePendingImportRow({ status: 'installed' }),
    );

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/reject`);
    expect(result.status).toBe(400);
  });

  it('returns 403 when user does not own the import', async () => {
    const app = buildApp(OTHER_USER_ID);
    mockDxtImportRepo.findById.mockResolvedValueOnce(makePendingImportRow());

    const result = await req(app, 'POST', `/api/dxt/imports/${IMPORT_ID}/reject`);
    expect(result.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /imports
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/dxt/imports', () => {
  it('returns import listing with no blob bytes in response', async () => {
    const app = buildApp();
    mockDxtImportRepo.listForUser.mockResolvedValueOnce([
      {
        id: IMPORT_ID,
        user_id: USER_ID,
        imported_at: new Date('2026-05-08T00:00:00Z'),
        artifact_blob: Buffer.alloc(512),  // large blob — must NOT appear in response
        artifact_sha256: Buffer.alloc(32, 0xcd),
        registry_id: 'notion-mcp',
        source_instance_id: null,
        status: 'pending',
        installed_server_id: null,
        rejected_at: null,
        installed_at: null,
        error_message: null,
      },
    ]);

    const result = await req(app, 'GET', '/api/dxt/imports');
    expect(result.status).toBe(200);
    const body = result.body as { imports: Array<Record<string, unknown>> };
    expect(body.imports).toHaveLength(1);
    const row = body.imports[0]!;
    expect(row['id']).toBe(IMPORT_ID);
    expect(row['registryId']).toBe('notion-mcp');
    expect(row['status']).toBe('pending');
    expect(row['blobBytes']).toBe(512);
    // Verify blob bytes are not included
    expect(row).not.toHaveProperty('artifact_blob');
    expect(row).not.toHaveProperty('artifactBlob');
  });

  it('passes status filter to repository when query param provided', async () => {
    const app = buildApp();
    mockDxtImportRepo.listForUser.mockResolvedValueOnce([]);

    await req(app, 'GET', '/api/dxt/imports?status=pending');

    expect(mockDxtImportRepo.listForUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ status: 'pending' }),
    );
  });
});
