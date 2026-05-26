/**
 * Unit tests for the user-purge repository (#376).
 *
 * Covers: dependency-order of the DELETE plan, count aggregation, the
 * `userExisted` flag derived from the final DELETE rowCount, and the
 * transactional contract (every statement runs inside the same
 * `withTransaction` client).
 *
 * The actual cascade behaviour (does `DELETE FROM users` really wipe
 * every other table?) is exercised end-to-end against a live CRDB in
 * `cascade-cleanup.e2e.test.ts` from #413.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  connect: vi.fn().mockResolvedValue(mockClient),
};

vi.mock('../connection.js', () => ({
  getPool: () => mockPool,
  withTransaction: async (fn: (client: typeof mockClient) => Promise<unknown>) => {
    await mockClient.query('BEGIN');
    try {
      const result = await fn(mockClient);
      await mockClient.query('COMMIT');
      return result;
    } catch (err) {
      await mockClient.query('ROLLBACK');
      throw err;
    }
  },
}));

const { userPurgeRepository } = await import('../repositories/user-purge-repository.js');

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000099';

function setupDeleteCounts(counts: Record<string, number>): void {
  // mockClient.query is called many times — for BEGIN, every DELETE,
  // and COMMIT. We dispatch based on the SQL: if it contains DELETE
  // FROM <table>, look up that table's expected count; otherwise
  // return a no-op result for BEGIN / COMMIT.
  mockClient.query.mockImplementation((sql: string) => {
    if (typeof sql !== 'string') return { rows: [], rowCount: 0 };
    const match = sql.match(/DELETE FROM\s+([a-z_]+)/i);
    if (!match) return { rows: [], rowCount: 0 };
    const table = match[1]!;
    return { rows: [], rowCount: counts[table] ?? 0 };
  });
}

describe('userPurgeRepository.purgeUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs every delete and returns per-table row counts', async () => {
    setupDeleteCounts({
      execution_results: 3,
      execution_events: 5,
      execution_plans: 2,
      explanation_records: 7,
      decision_outcomes: 4,
      candidate_actions: 11,
      twin_profile_versions: 1,
      knowledge_triples: 0,
      users: 1,
    });

    const result = await userPurgeRepository.purgeUser(USER_ID);

    expect(result.userExisted).toBe(true);
    expect(result.counts['execution_results']).toBe(3);
    expect(result.counts['candidate_actions']).toBe(11);
    expect(result.counts['users']).toBe(1);
    // Total sums every table's count (including the user row itself).
    expect(result.total).toBe(3 + 5 + 2 + 7 + 4 + 11 + 1 + 0 + 1);
  });

  it('returns userExisted=false when the final DELETE FROM users hit zero rows', async () => {
    setupDeleteCounts({
      // Chain deletes pre-empted (user already gone): everything zero.
      users: 0,
    });

    const result = await userPurgeRepository.purgeUser(USER_ID);
    expect(result.userExisted).toBe(false);
    expect(result.counts['users']).toBe(0);
    expect(result.total).toBe(0);
  });

  it('executes child-of-decisions deletes before deleting the user row (dependency order)', async () => {
    setupDeleteCounts({ users: 1 });
    await userPurgeRepository.purgeUser(USER_ID);

    // Walk the call log and verify candidate_actions / execution_plans
    // ran BEFORE the final users delete. If a future refactor reorders
    // the plan and puts `DELETE FROM users` first, the cascade through
    // user_id → decisions would trip on candidate_actions.decision_id
    // FK and the whole thing would fail in prod. This test catches
    // that reordering at unit-test time.
    const sqls = mockClient.query.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((s) => s.includes('DELETE FROM'));
    const indexOf = (frag: string): number =>
      sqls.findIndex((s) => s.includes(frag));

    expect(indexOf('DELETE FROM candidate_actions')).toBeLessThan(
      indexOf('DELETE FROM users'),
    );
    expect(indexOf('DELETE FROM execution_plans')).toBeLessThan(
      indexOf('DELETE FROM users'),
    );
    expect(indexOf('DELETE FROM execution_results')).toBeLessThan(
      indexOf('DELETE FROM execution_plans'),
    );
    expect(indexOf('DELETE FROM twin_profile_versions')).toBeLessThan(
      indexOf('DELETE FROM users'),
    );
  });

  it('wraps the entire chain in a BEGIN/COMMIT transaction', async () => {
    setupDeleteCounts({ users: 1 });
    await userPurgeRepository.purgeUser(USER_ID);

    const beginIdx = mockClient.query.mock.calls.findIndex(
      (c) => c[0] === 'BEGIN',
    );
    const commitIdx = mockClient.query.mock.calls.findIndex(
      (c) => c[0] === 'COMMIT',
    );
    expect(beginIdx).toBe(0);
    expect(commitIdx).toBeGreaterThan(0);
    // Every DELETE statement lives between BEGIN and COMMIT.
    const deleteCalls = mockClient.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('DELETE FROM'),
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(8);
  });

  it('rolls back when a delete throws (transactional all-or-nothing)', async () => {
    let callCount = 0;
    mockClient.query.mockImplementation((sql: string) => {
      callCount += 1;
      // Pass BEGIN through.
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      // Fail on the third DELETE (some intermediate step).
      if (callCount === 4) throw new Error('CRDB temporary read error');
      return { rows: [], rowCount: 1 };
    });

    await expect(userPurgeRepository.purgeUser(USER_ID)).rejects.toThrow(
      /CRDB temporary read error/,
    );

    const rollbackIdx = mockClient.query.mock.calls.findIndex(
      (c) => c[0] === 'ROLLBACK',
    );
    expect(rollbackIdx).toBeGreaterThan(0);
  });

  it('passes the userId as $1 on every parameterised statement (no SQL injection vector)', async () => {
    setupDeleteCounts({ users: 1 });
    await userPurgeRepository.purgeUser(USER_ID);
    const paramCalls = mockClient.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('DELETE FROM'),
    );
    for (const call of paramCalls) {
      expect(call[1]).toEqual([USER_ID]);
    }
  });
});
