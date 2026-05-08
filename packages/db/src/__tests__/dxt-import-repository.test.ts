/**
 * dxt-import-repository.test.ts
 *
 * Unit tests for dxtImportRepository using a mocked query() function.
 * No real database is needed — we verify SQL shapes and parameter passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the connection module so no real DB is needed.
// ---------------------------------------------------------------------------

const mockRows: unknown[] = [];
let mockThrow: Error | null = null;

vi.mock('../connection.js', () => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (mockThrow) {
      const err = mockThrow;
      throw err;
    }
    return { rows: [...mockRows], rowCount: mockRows.length };
  }),
}));

import { dxtImportRepository } from '../repositories/dxt-import-repository.js';
import { query } from '../connection.js';

const mockQuery = vi.mocked(query);

const USER_ID = 'ffffffff-eeee-dddd-cccc-111111111111';
const IMPORT_ID = 'cccccccc-dddd-eeee-ffff-444444444444';
const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

function makeImportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: IMPORT_ID,
    user_id: USER_ID,
    imported_at: new Date('2026-05-08T00:00:00Z'),
    artifact_blob: Buffer.alloc(128),
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
  mockRows.length = 0;
  mockThrow = null;
  mockQuery.mockClear();
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('dxtImportRepository.create', () => {
  it('inserts with status=pending and returns the row', async () => {
    mockRows.push(makeImportRow());

    const result = await dxtImportRepository.create({
      userId: USER_ID,
      blob: Buffer.alloc(128),
      sha256: Buffer.alloc(32, 0xab),
      registryId: 'notion-mcp',
      sourceInstanceId: null,
    });

    expect(result.id).toBe(IMPORT_ID);
    expect(result.status).toBe('pending');
    expect(result.registry_id).toBe('notion-mcp');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO dxt_imports');
    expect(sql).toContain("'pending'");
    expect(params[0]).toBe(USER_ID);
    expect(params[3]).toBe('notion-mcp');
  });

  it('throws when insert returns no row', async () => {
    // mockRows is empty — no row returned
    await expect(
      dxtImportRepository.create({
        userId: USER_ID,
        blob: Buffer.alloc(16),
        sha256: Buffer.alloc(32),
        registryId: 'test-mcp',
        sourceInstanceId: null,
      }),
    ).rejects.toThrow('dxt_imports insert returned no row');
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe('dxtImportRepository.findById', () => {
  it('returns null when no row found', async () => {
    const result = await dxtImportRepository.findById(IMPORT_ID);
    expect(result).toBeNull();
  });

  it('returns the row when found', async () => {
    mockRows.push(makeImportRow());
    const result = await dxtImportRepository.findById(IMPORT_ID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(IMPORT_ID);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM dxt_imports');
    expect(params[0]).toBe(IMPORT_ID);
  });
});

// ---------------------------------------------------------------------------
// listForUser
// ---------------------------------------------------------------------------

describe('dxtImportRepository.listForUser', () => {
  it('lists all imports for user ordered by imported_at DESC', async () => {
    mockRows.push(makeImportRow({ id: 'aaa-newer' }));
    mockRows.push(makeImportRow({ id: 'bbb-older' }));

    const results = await dxtImportRepository.listForUser(USER_ID);
    expect(results).toHaveLength(2);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY imported_at DESC');
    expect(params[0]).toBe(USER_ID);
  });

  it('filters by status when opts.status is provided', async () => {
    mockRows.push(makeImportRow());

    await dxtImportRepository.listForUser(USER_ID, { status: 'pending' });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('status = $2');
    expect(params[1]).toBe('pending');
  });

  it('returns empty array when no imports exist', async () => {
    const results = await dxtImportRepository.listForUser(USER_ID);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// markRejected / markInstalled / markFailed
// ---------------------------------------------------------------------------

describe('dxtImportRepository.markRejected', () => {
  it('issues UPDATE with rejected_at = now()', async () => {
    await dxtImportRepository.markRejected(IMPORT_ID);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'rejected'");
    expect(sql).toContain('rejected_at = now()');
    expect(params[0]).toBe(IMPORT_ID);
  });
});

describe('dxtImportRepository.markInstalled', () => {
  it('issues UPDATE with status=installed + installed_server_id', async () => {
    await dxtImportRepository.markInstalled(IMPORT_ID, SERVER_ID);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'installed'");
    expect(sql).toContain('installed_server_id = $2');
    expect(params[0]).toBe(IMPORT_ID);
    expect(params[1]).toBe(SERVER_ID);
  });
});

describe('dxtImportRepository.markFailed', () => {
  it('issues UPDATE with status=failed + error_message', async () => {
    await dxtImportRepository.markFailed(IMPORT_ID, 'something went wrong');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain('error_message = $2');
    expect(params[0]).toBe(IMPORT_ID);
    expect(params[1]).toBe('something went wrong');
  });
});
