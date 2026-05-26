/**
 * Unit tests for the audit-log repository (#393).
 *
 * Append-only by design — there's no `update` or `delete` API
 * surface to test. The user-driven purge (#376) drops audit history
 * via ON DELETE CASCADE; that path is exercised in
 * `cascade-cleanup.e2e.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { accessLogRepository } = await import(
  '../repositories/access-log-repository.js'
);

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000033';

describe('accessLogRepository.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('appends with the canonical column order + parameters', async () => {
    await accessLogRepository.record({
      userId: USER_ID,
      actor: 'worker',
      action: 'decrypt_oauth_token',
      resourceType: 'oauth_token',
      resourceId: 'token-row-1',
      requestId: 'req-abc',
    });
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO access_log');
    expect(args).toEqual([
      USER_ID,
      'worker',
      'decrypt_oauth_token',
      'oauth_token',
      'token-row-1',
      'req-abc',
    ]);
  });

  it('null-coalesces optional resourceId + requestId so callers can omit them', async () => {
    await accessLogRepository.record({
      userId: USER_ID,
      actor: 'api',
      action: 'list_decisions',
      resourceType: 'decision',
    });
    const [, args] = mockQuery.mock.calls[0]!;
    expect(args[4]).toBeNull();
    expect(args[5]).toBeNull();
  });
});

describe('accessLogRepository.findByUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads by user, newest first, default limit 100', async () => {
    const row = {
      id: 'al-1',
      user_id: USER_ID,
      actor: 'worker',
      action: 'decrypt_oauth_token',
      resource_type: 'oauth_token',
      resource_id: 'token-row-1',
      request_id: null,
      occurred_at: new Date('2026-05-26T01:00:00Z'),
    };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

    const result = await accessLogRepository.findByUser(USER_ID);
    expect(result).toEqual([row]);
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).toContain('ORDER BY occurred_at DESC');
    expect(sql).toContain('LIMIT 100');
    expect(args).toEqual([USER_ID]);
  });

  it('honors a custom limit and clamps it to [1, 1000]', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await accessLogRepository.findByUser(USER_ID, { limit: 50 });
    expect(mockQuery.mock.calls[0]![0]).toContain('LIMIT 50');

    await accessLogRepository.findByUser(USER_ID, { limit: 0 });
    expect(mockQuery.mock.calls[1]![0]).toContain('LIMIT 1');

    await accessLogRepository.findByUser(USER_ID, { limit: 100_000 });
    expect(mockQuery.mock.calls[2]![0]).toContain('LIMIT 1000');
  });

  it('sanitises non-integer / NaN / negative limits before SQL interpolation', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    // Fractional input → floored, NEVER emits "LIMIT 50.5".
    await accessLogRepository.findByUser(USER_ID, { limit: 50.5 });
    expect(mockQuery.mock.calls[0]![0]).toContain('LIMIT 50');
    expect(mockQuery.mock.calls[0]![0]).not.toContain('LIMIT 50.5');

    // NaN → falls through to default (100), NEVER emits "LIMIT NaN".
    await accessLogRepository.findByUser(USER_ID, { limit: Number.NaN });
    expect(mockQuery.mock.calls[1]![0]).toContain('LIMIT 100');

    // Negative → clamped up to 1.
    await accessLogRepository.findByUser(USER_ID, { limit: -10 });
    expect(mockQuery.mock.calls[2]![0]).toContain('LIMIT 1');

    // Infinity → clamped down to 1000.
    await accessLogRepository.findByUser(USER_ID, { limit: Number.POSITIVE_INFINITY });
    expect(mockQuery.mock.calls[3]![0]).toContain('LIMIT 1000');
  });
});
