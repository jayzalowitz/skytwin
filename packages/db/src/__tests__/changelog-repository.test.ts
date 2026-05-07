import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the connection module so no real DB is needed in unit tests.
// We return a controllable "rows" result from query().
// ---------------------------------------------------------------------------

const mockRows: unknown[] = [];
let mockThrow: Error | null = null;

vi.mock('../connection.js', () => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (mockThrow) {
      const err = mockThrow;
      throw err;
    }
    return { rows: mockRows, rowCount: mockRows.length };
  }),
}));

// Import after mock registration so the module picks up the mock.
import { mcpServerChangelogRepository } from '../repositories/mcp-server-changelog-repository.js';
import { query } from '../connection.js';

const mockQuery = vi.mocked(query);

const SERVER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OPT_IN_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID    = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  mockRows.length = 0;
  mockThrow = null;
  mockQuery.mockClear();
});

// ---------------------------------------------------------------------------
// upsert
// ---------------------------------------------------------------------------

describe('mcpServerChangelogRepository.upsert', () => {
  it('calls INSERT ... ON CONFLICT with expected params', async () => {
    await mcpServerChangelogRepository.upsert(SERVER_ID, {
      currentVersion: '1.2.3',
      rawText: '## v1.2.3\n\nAdded stuff.',
      lastSeenSkills: ['read_file', 'create_file'],
      lastKnownDestructiveSkills: ['create_file'],
    });

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT');
    expect(params[0]).toBe(SERVER_ID);
    expect(params[1]).toBe('1.2.3');
    expect(params[2]).toContain('Added stuff');
  });

  it('handles undefined optional fields (currentVersion, rawText)', async () => {
    await mcpServerChangelogRepository.upsert(SERVER_ID, {
      lastSeenSkills: [],
      lastKnownDestructiveSkills: [],
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBeNull(); // currentVersion
    expect(params[2]).toBeNull(); // rawText
  });
});

// ---------------------------------------------------------------------------
// getForServer
// ---------------------------------------------------------------------------

describe('mcpServerChangelogRepository.getForServer', () => {
  it('returns null when no row found', async () => {
    const result = await mcpServerChangelogRepository.getForServer(SERVER_ID);
    expect(result).toBeNull();
  });

  it('returns the row when found', async () => {
    mockRows.push({
      server_id: SERVER_ID,
      current_version: '2.0.0',
      raw_text: '## v2.0.0\n\nBig update.',
      fetched_at: new Date('2026-01-01'),
      last_seen_skills: ['read_file'],
      last_known_destructive_skills: [],
    });

    const result = await mcpServerChangelogRepository.getForServer(SERVER_ID);
    expect(result).not.toBeNull();
    expect(result?.current_version).toBe('2.0.0');
    expect(result?.server_id).toBe(SERVER_ID);
  });
});

// ---------------------------------------------------------------------------
// addPendingOptIn
// ---------------------------------------------------------------------------

describe('mcpServerChangelogRepository.addPendingOptIn', () => {
  it('calls INSERT ... ON CONFLICT DO NOTHING (idempotent)', async () => {
    await mcpServerChangelogRepository.addPendingOptIn(SERVER_ID, 'create_database', '1.4.0');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO NOTHING');
    expect(params[0]).toBe(SERVER_ID);
    expect(params[1]).toBe('create_database');
    expect(params[2]).toBe('1.4.0');
  });

  it('passes null for changelogVersion when not provided', async () => {
    await mcpServerChangelogRepository.addPendingOptIn(SERVER_ID, 'delete_record');

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPendingOptInsForUser
// ---------------------------------------------------------------------------

describe('mcpServerChangelogRepository.listPendingOptInsForUser', () => {
  it('returns only pending rows (accepted_at and rejected_at are null)', async () => {
    mockRows.push({
      id: OPT_IN_ID,
      server_id: SERVER_ID,
      skill_name: 'create_database',
      changelog_version: '1.4.0',
      detected_at: new Date('2026-05-01'),
      accepted_at: null,
      rejected_at: null,
      server_display_name: 'Notion',
      server_registry_id: '@notionhq/notion-mcp-server',
    });

    const results = await mcpServerChangelogRepository.listPendingOptInsForUser(USER_ID);
    expect(results).toHaveLength(1);
    expect(results[0]?.skill_name).toBe('create_database');
    expect(results[0]?.server_display_name).toBe('Notion');
    expect(results[0]?.accepted_at).toBeNull();
    expect(results[0]?.rejected_at).toBeNull();

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('accepted_at IS NULL');
    expect(sql).toContain('rejected_at IS NULL');
    expect(params[0]).toBe(USER_ID);
  });

  it('returns empty array when no pending opt-ins exist', async () => {
    const results = await mcpServerChangelogRepository.listPendingOptInsForUser(USER_ID);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// acceptOptIn / rejectOptIn
// ---------------------------------------------------------------------------

describe('mcpServerChangelogRepository.acceptOptIn', () => {
  it('returns found:true when the row is updated', async () => {
    mockRows.push({ id: OPT_IN_ID });
    const result = await mcpServerChangelogRepository.acceptOptIn(OPT_IN_ID);
    expect(result.found).toBe(true);

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('accepted_at = now()');
  });

  it('returns found:false when no row is updated', async () => {
    const result = await mcpServerChangelogRepository.acceptOptIn(OPT_IN_ID);
    expect(result.found).toBe(false);
  });
});

describe('mcpServerChangelogRepository.rejectOptIn', () => {
  it('returns found:true when the row is updated', async () => {
    mockRows.push({ id: OPT_IN_ID });
    const result = await mcpServerChangelogRepository.rejectOptIn(OPT_IN_ID);
    expect(result.found).toBe(true);

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('rejected_at = now()');
  });

  it('returns found:false when no row is updated', async () => {
    const result = await mcpServerChangelogRepository.rejectOptIn(OPT_IN_ID);
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasPendingOptIn
// ---------------------------------------------------------------------------

describe('mcpServerChangelogRepository.hasPendingOptIn', () => {
  it('returns true when a pending row exists', async () => {
    mockRows.push({ id: OPT_IN_ID });
    const result = await mcpServerChangelogRepository.hasPendingOptIn(SERVER_ID, 'create_database');
    expect(result).toBe(true);
  });

  it('returns false when no pending row exists', async () => {
    const result = await mcpServerChangelogRepository.hasPendingOptIn(SERVER_ID, 'read_file');
    expect(result).toBe(false);
  });
});
