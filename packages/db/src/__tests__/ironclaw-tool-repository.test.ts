import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { ironClawToolRepository } = await import(
  '../repositories/ironclaw-tool-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRow(
  overrides: Partial<{
    id: string;
    tool_name: string;
    description: string | null;
    action_types: string[];
    requires_credentials: string[];
    discovered_at: Date;
  }> = {},
) {
  return {
    id: overrides.id ?? 'tool-001',
    tool_name: overrides.tool_name ?? 'send_email',
    description: overrides.description ?? 'Send an email via Gmail',
    action_types: overrides.action_types ?? ['email.send'],
    requires_credentials: overrides.requires_credentials ?? ['gmail_oauth'],
    discovered_at: overrides.discovered_at ?? new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ironClawToolRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // upsertMany
  // -----------------------------------------------------------------------

  describe('upsertMany', () => {
    it('returns early without querying when given an empty array', async () => {
      const result = await ironClawToolRepository.upsertMany([]);

      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('calls query with correct parameterized values for multiple tools', async () => {
      const rows = [
        fakeRow({ tool_name: 'send_email' }),
        fakeRow({ tool_name: 'create_event', id: 'tool-002' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await ironClawToolRepository.upsertMany([
        {
          toolName: 'send_email',
          description: 'Send an email via Gmail',
          actionTypes: ['email.send'],
          requiresCredentials: ['gmail_oauth'],
        },
        {
          toolName: 'create_event',
          description: 'Create a calendar event',
          actionTypes: ['calendar.create'],
          requiresCredentials: ['gcal_oauth'],
        },
      ]);

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledOnce();

      const [sql, params] = mockQuery.mock.calls[0]!;
      // Verify parameterized placeholders for two tools (4 params each)
      expect(sql).toContain('($1, $2, $3, $4, now())');
      expect(sql).toContain('($5, $6, $7, $8, now())');
      expect(params).toEqual([
        'send_email',
        'Send an email via Gmail',
        ['email.send'],
        ['gmail_oauth'],
        'create_event',
        'Create a calendar event',
        ['calendar.create'],
        ['gcal_oauth'],
      ]);
    });

    it('includes ON CONFLICT clause for upsert behavior', async () => {
      const row = fakeRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await ironClawToolRepository.upsertMany([
        {
          toolName: 'send_email',
          description: 'Send an email via Gmail',
          actionTypes: ['email.send'],
          requiresCredentials: ['gmail_oauth'],
        },
      ]);

      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT (tool_name) DO UPDATE SET');
      expect(sql).toContain('description = EXCLUDED.description');
      expect(sql).toContain('action_types = EXCLUDED.action_types');
      expect(sql).toContain('requires_credentials = EXCLUDED.requires_credentials');
      expect(sql).toContain('discovered_at = now()');
      expect(sql).toContain('RETURNING *');
    });

    it('passes null for missing or undefined descriptions', async () => {
      const rows = [
        fakeRow({ tool_name: 'no_desc_tool', description: null }),
        fakeRow({ tool_name: 'undef_desc_tool', description: null, id: 'tool-002' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      await ironClawToolRepository.upsertMany([
        {
          toolName: 'no_desc_tool',
          description: undefined,
          actionTypes: ['misc.action'],
          requiresCredentials: [],
        },
        {
          toolName: 'undef_desc_tool',
          actionTypes: ['misc.other'],
          requiresCredentials: [],
        },
      ]);

      const [_sql, params] = mockQuery.mock.calls[0]!;
      // description slots (indices 1 and 5) should both be null
      expect(params![1]).toBeNull();
      expect(params![5]).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getAll
  // -----------------------------------------------------------------------

  describe('getAll', () => {
    it('returns rows sorted by tool_name', async () => {
      const rows = [
        fakeRow({ tool_name: 'create_event' }),
        fakeRow({ tool_name: 'send_email' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await ironClawToolRepository.getAll();

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM ironclaw_tools ORDER BY tool_name',
      );
    });
  });

  // -----------------------------------------------------------------------
  // getSkillSet
  // -----------------------------------------------------------------------

  describe('getSkillSet', () => {
    it('flattens action_types into a Set', async () => {
      const rows = [
        fakeRow({ tool_name: 'send_email', action_types: ['email.send', 'email.draft'] }),
        fakeRow({ tool_name: 'create_event', action_types: ['calendar.create'] }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await ironClawToolRepository.getSkillSet();

      expect(result).toBeInstanceOf(Set);
      expect(result).toEqual(new Set(['email.send', 'email.draft', 'calendar.create']));
    });

    it('returns an empty Set when there are no rows', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await ironClawToolRepository.getSkillSet();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });
  });
});
