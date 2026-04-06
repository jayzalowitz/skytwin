import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { policyRepository } = await import('../repositories/policy-repository.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakePolicyRow(overrides: Partial<{
  id: string;
  user_id: string;
  name: string;
  domain: string;
  rules: unknown[];
  priority: number;
  is_active: boolean;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'pol-001',
    user_id: overrides.user_id ?? 'u-001',
    name: overrides.name ?? 'No auto-spend over $50',
    domain: overrides.domain ?? 'shopping',
    rules: overrides.rules ?? [{ type: 'spend_limit', max: 5000 }],
    priority: overrides.priority ?? 10,
    is_active: overrides.is_active ?? true,
    created_at: overrides.created_at ?? new Date('2026-02-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('policyRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // getPoliciesForUser
  // -----------------------------------------------------------------------

  describe('getPoliciesForUser', () => {
    it('fetches all active policies for a user without domain filter', async () => {
      const rows = [
        fakePolicyRow({ id: 'pol-001', priority: 20 }),
        fakePolicyRow({ id: 'pol-002', priority: 10 }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await policyRepository.getPoliciesForUser('u-001');

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('FROM action_policies');
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).toContain('is_active = true');
      expect(sql).toContain('ORDER BY priority DESC');
      expect(sql).not.toContain('domain = $2');
      expect(params).toEqual(['u-001']);
    });

    it('filters by domain when provided', async () => {
      const rows = [fakePolicyRow({ domain: 'email' })];
      mockQuery.mockResolvedValue({ rows, rowCount: 1 });

      const result = await policyRepository.getPoliciesForUser('u-001', 'email');

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE user_id = $1 AND domain = $2');
      expect(sql).toContain('is_active = true');
      expect(sql).toContain('ORDER BY priority DESC');
      expect(params).toEqual(['u-001', 'email']);
    });

    it('returns empty array when user has no policies', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await policyRepository.getPoliciesForUser('u-new');
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // findById
  // -----------------------------------------------------------------------

  describe('findById', () => {
    it('returns policy when found', async () => {
      const row = fakePolicyRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await policyRepository.findById('pol-001');

      expect(result).toEqual(row);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM action_policies WHERE id = $1',
        ['pol-001'],
      );
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await policyRepository.findById('ghost');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // createPolicy
  // -----------------------------------------------------------------------

  describe('createPolicy', () => {
    it('inserts policy with correct params and returns row', async () => {
      const rules = [{ type: 'spend_limit', max: 5000 }];
      const row = fakePolicyRow({ rules });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await policyRepository.createPolicy({
        userId: 'u-001',
        name: 'No auto-spend over $50',
        domain: 'shopping',
        rules,
        priority: 10,
        isActive: true,
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO action_policies');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'u-001',
        'No auto-spend over $50',
        'shopping',
        JSON.stringify(rules),
        10,
        true,
      ]);
    });

    it('uses default values for optional fields', async () => {
      mockQuery.mockResolvedValue({ rows: [fakePolicyRow()], rowCount: 1 });

      await policyRepository.createPolicy({
        userId: 'u-001',
        name: 'Basic policy',
        domain: 'general',
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual([
        'u-001',
        'Basic policy',
        'general',
        '[]',    // default rules
        0,       // default priority
        true,    // default isActive
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // updatePolicy
  // -----------------------------------------------------------------------

  describe('updatePolicy', () => {
    it('builds SET clause for name only', async () => {
      const row = fakePolicyRow({ name: 'Updated name' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await policyRepository.updatePolicy('pol-001', { name: 'Updated name' });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE action_policies SET');
      expect(sql).toContain('name = $1');
      expect(sql).toContain('WHERE id = $2');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual(['Updated name', 'pol-001']);
    });

    it('builds SET clause for multiple fields with correct param indexes', async () => {
      const newRules = [{ type: 'block', pattern: '*' }];
      const row = fakePolicyRow({
        name: 'Strict',
        domain: 'finance',
        rules: newRules,
        priority: 100,
        is_active: false,
      });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await policyRepository.updatePolicy('pol-001', {
        name: 'Strict',
        domain: 'finance',
        rules: newRules,
        priority: 100,
        isActive: false,
      });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('name = $1');
      expect(sql).toContain('domain = $2');
      expect(sql).toContain('rules = $3');
      expect(sql).toContain('priority = $4');
      expect(sql).toContain('is_active = $5');
      expect(sql).toContain('WHERE id = $6');
      expect(params).toEqual([
        'Strict',
        'finance',
        JSON.stringify(newRules),
        100,
        false,
        'pol-001',
      ]);
    });

    it('falls back to findById when no fields are provided', async () => {
      const row = fakePolicyRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await policyRepository.updatePolicy('pol-001', {});

      expect(result).toEqual(row);
      // Should call findById, which is a SELECT
      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('SELECT * FROM action_policies WHERE id = $1');
    });

    it('returns null when policy not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await policyRepository.updatePolicy('ghost', { name: 'X' });
      expect(result).toBeNull();
    });

    it('serializes rules to JSON', async () => {
      const rules = [{ type: 'allow', domains: ['email'] }];
      mockQuery.mockResolvedValue({ rows: [fakePolicyRow()], rowCount: 1 });

      await policyRepository.updatePolicy('pol-001', { rules });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![0]).toBe(JSON.stringify(rules));
    });
  });

  // -----------------------------------------------------------------------
  // deletePolicy (soft delete)
  // -----------------------------------------------------------------------

  describe('deletePolicy', () => {
    it('sets is_active to false and returns true when row exists', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await policyRepository.deletePolicy('pol-001');

      expect(result).toBe(true);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE action_policies');
      expect(sql).toContain('SET is_active = false');
      expect(sql).toContain('WHERE id = $1');
      expect(params).toEqual(['pol-001']);
    });

    it('returns false when policy not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await policyRepository.deletePolicy('ghost');
      expect(result).toBe(false);
    });

    it('returns false when rowCount is null', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null });

      const result = await policyRepository.deletePolicy('pol-001');
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // hardDeletePolicy
  // -----------------------------------------------------------------------

  describe('hardDeletePolicy', () => {
    it('deletes row from database and returns true', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await policyRepository.hardDeletePolicy('pol-001');

      expect(result).toBe(true);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('DELETE FROM action_policies');
      expect(sql).toContain('WHERE id = $1');
      expect(params).toEqual(['pol-001']);
    });

    it('returns false when policy not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await policyRepository.hardDeletePolicy('ghost');
      expect(result).toBe(false);
    });
  });
});
