import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockWithTransaction = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}));

const { userRepository } = await import('../repositories/user-repository.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeUserRow(overrides: Partial<{
  id: string;
  email: string;
  name: string;
  trust_tier: string;
  autonomy_settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'u-001',
    email: overrides.email ?? 'alice@example.com',
    name: overrides.name ?? 'Alice',
    trust_tier: overrides.trust_tier ?? 'observer',
    autonomy_settings: overrides.autonomy_settings ?? {},
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: overrides.updated_at ?? new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('userRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // findById
  // -----------------------------------------------------------------------

  describe('findById', () => {
    it('returns user when row exists', async () => {
      const row = fakeUserRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.findById('u-001');

      expect(result).toEqual(row);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1',
        ['u-001'],
      );
    });

    it('returns null when no row exists', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.findById('non-existent');

      expect(result).toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1',
        ['non-existent'],
      );
    });
  });

  // -----------------------------------------------------------------------
  // findByEmail
  // -----------------------------------------------------------------------

  describe('findByEmail', () => {
    it('returns user when email matches', async () => {
      const row = fakeUserRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.findByEmail('alice@example.com');

      expect(result).toEqual(row);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE email = $1',
        ['alice@example.com'],
      );
    });

    it('returns null when no email matches', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.findByEmail('nobody@example.com');

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('inserts with correct params and returns the new row', async () => {
      const row = fakeUserRow({ trust_tier: 'observer' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.create({
        email: 'alice@example.com',
        name: 'Alice',
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO users');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'alice@example.com',
        'Alice',
        'observer',     // default trust tier
        '{}',           // default autonomy settings JSON
      ]);
    });

    it('passes explicit trustTier and autonomySettings', async () => {
      const settings = { autoReply: true };
      const row = fakeUserRow({ trust_tier: 'autopilot', autonomy_settings: settings });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await userRepository.create({
        email: 'bob@example.com',
        name: 'Bob',
        trustTier: 'autopilot',
        autonomySettings: settings,
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual([
        'bob@example.com',
        'Bob',
        'autopilot',
        JSON.stringify(settings),
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // update
  // -----------------------------------------------------------------------

  describe('update', () => {
    it('builds SET clause for email only', async () => {
      const row = fakeUserRow({ email: 'newemail@example.com' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.update('u-001', { email: 'newemail@example.com' });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE users SET');
      expect(sql).toContain('email = $1');
      expect(sql).toContain('updated_at = now()');
      expect(sql).toContain('WHERE id = $2');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual(['newemail@example.com', 'u-001']);
    });

    it('builds SET clause for name only', async () => {
      const row = fakeUserRow({ name: 'Bob' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await userRepository.update('u-001', { name: 'Bob' });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('name = $1');
      expect(sql).toContain('WHERE id = $2');
      expect(params).toEqual(['Bob', 'u-001']);
    });

    it('builds SET clause for both email and name', async () => {
      const row = fakeUserRow({ email: 'new@example.com', name: 'New Name' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await userRepository.update('u-001', { email: 'new@example.com', name: 'New Name' });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('email = $1');
      expect(sql).toContain('name = $2');
      expect(sql).toContain('WHERE id = $3');
      expect(params).toEqual(['new@example.com', 'New Name', 'u-001']);
    });

    it('returns null when no row matches', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.update('ghost', { name: 'X' });
      expect(result).toBeNull();
    });

    it('falls back to findById when no fields are provided', async () => {
      const row = fakeUserRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.update('u-001', {});

      expect(result).toEqual(row);
      // Should have called findById, which is a SELECT
      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('SELECT * FROM users WHERE id = $1');
    });
  });

  // -----------------------------------------------------------------------
  // updateAutonomySettings
  // -----------------------------------------------------------------------

  describe('updateAutonomySettings', () => {
    it('serializes settings to JSON and passes id', async () => {
      const settings = { maxDailySpend: 500, autoReply: false };
      const row = fakeUserRow({ autonomy_settings: settings });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.updateAutonomySettings('u-001', settings);

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE users');
      expect(sql).toContain('autonomy_settings = $1');
      expect(sql).toContain('updated_at = now()');
      expect(sql).toContain('WHERE id = $2');
      expect(params).toEqual([JSON.stringify(settings), 'u-001']);
    });

    it('returns null when user not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.updateAutonomySettings('ghost', {});
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // updateTrustTier
  // -----------------------------------------------------------------------

  describe('updateTrustTier', () => {
    it('sets trust_tier and returns updated row', async () => {
      const row = fakeUserRow({ trust_tier: 'copilot' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await userRepository.updateTrustTier('u-001', 'copilot');

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('trust_tier = $1');
      expect(sql).toContain('WHERE id = $2');
      expect(params).toEqual(['copilot', 'u-001']);
    });
  });

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('executes cascading deletes in a transaction and returns true', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 1 }),
      };

      // withTransaction receives an async fn; we invoke it with our mock client
      mockWithTransaction.mockImplementation(async (fn: (client: typeof mockClient) => Promise<unknown>) => {
        return fn(mockClient);
      });

      const result = await userRepository.delete('u-001');

      expect(result).toBe(true);
      // Should have many DELETE calls, ending with users
      const calls = mockClient.query.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(10);

      // First delete should be feedback_events
      expect(calls[0]![0]).toContain('DELETE FROM feedback_events');
      // Last delete should be users
      expect(calls[calls.length - 1]![0]).toContain('DELETE FROM users WHERE id = $1');

      // All calls should pass the user id
      for (const call of calls) {
        expect(call[1]).toEqual(['u-001']);
      }
    });

    it('returns false when user row does not exist', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 0 }),
      };

      mockWithTransaction.mockImplementation(async (fn: (client: typeof mockClient) => Promise<unknown>) => {
        return fn(mockClient);
      });

      const result = await userRepository.delete('ghost');
      expect(result).toBe(false);
    });
  });
});
