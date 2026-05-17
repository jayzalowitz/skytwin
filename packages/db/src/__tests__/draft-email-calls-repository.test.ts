import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { draftEmailCallsRepository } = await import(
  '../repositories/draft-email-calls-repository.js'
);

describe('draftEmailCallsRepository.countInWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts rows in the trailing window — single COUNT(*) against the (user_id, called_at DESC) index', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '42' }], rowCount: 1 });
    expect(await draftEmailCallsRepository.countInWindow('u-1')).toBe(42);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('SELECT COUNT(*)');
    expect(sql).toContain('FROM draft_email_calls');
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(params).toEqual(['u-1', 24]);
  });

  it('accepts a custom window in hours', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '7' }], rowCount: 1 });
    expect(await draftEmailCallsRepository.countInWindow('u-1', 1)).toBe(7);
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params).toEqual(['u-1', 1]);
  });

  it('returns 0 when SUM is NULL (no rows in window)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: null }], rowCount: 1 });
    expect(await draftEmailCallsRepository.countInWindow('u-1')).toBe(0);
  });

  it('returns 0 when the result set is empty (edge case — CockroachDB normally always returns a row for COUNT)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await draftEmailCallsRepository.countInWindow('u-1')).toBe(0);
  });
});

describe('draftEmailCallsRepository.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts one row with all the supplied fields and returns it', async () => {
    const row = {
      id: 'r-1',
      user_id: 'u-1',
      decision_id: 'd-1',
      estimated_cost_cents: 5,
      provider: 'anthropic',
      succeeded: true,
      called_at: new Date(),
    };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });
    const result = await draftEmailCallsRepository.record({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
      provider: 'anthropic',
      succeeded: true,
    });
    expect(result).toEqual(row);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO draft_email_calls');
    expect(sql).toContain('user_id, decision_id, estimated_cost_cents, provider, succeeded');
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual(['u-1', 'd-1', 5, 'anthropic', true]);
  });

  it('defaults succeeded=true and provider=null/decisionId=null when omitted', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'r-1' }], rowCount: 1 });
    await draftEmailCallsRepository.record({
      userId: 'u-1',
      estimatedCostCents: 0,
    });
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params).toEqual(['u-1', null, 0, null, true]);
  });

  it('records FAILED calls explicitly — the per-day cap counts attempts, not successes', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'r-1' }], rowCount: 1 });
    await draftEmailCallsRepository.record({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
      provider: 'anthropic',
      succeeded: false,
    });
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[4]).toBe(false);
  });
});
