import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { connectorHealthRepository } = await import(
  '../repositories/connector-health-repository.js'
);

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

describe('connectorHealthRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('upsert', () => {
    it('writes status + error_code + lastFailureAt for needs_reauth', async () => {
      const lastFailureAt = new Date('2026-05-25T12:00:00Z');
      await connectorHealthRepository.upsert({
        userId: USER_ID,
        connectorName: 'gmail',
        status: 'needs_reauth',
        errorCode: 'invalid_grant',
        lastFailureAt,
      });
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO connector_health');
      expect(sql).toContain('ON CONFLICT (user_id, connector_name) DO UPDATE');
      expect(args).toEqual([
        USER_ID,
        'gmail',
        'needs_reauth',
        'invalid_grant',
        null,
        lastFailureAt,
      ]);
    });

    it('writes status + lastSuccessAt for connected', async () => {
      const lastSuccessAt = new Date('2026-05-25T12:00:00Z');
      await connectorHealthRepository.upsert({
        userId: USER_ID,
        connectorName: 'gmail',
        status: 'connected',
        lastSuccessAt,
      });
      const [, args] = mockQuery.mock.calls[0]!;
      expect(args).toEqual([
        USER_ID,
        'gmail',
        'connected',
        null,
        lastSuccessAt,
        null,
      ]);
    });

    it('uses DB-side now() instead of application time for updated_at', async () => {
      // Catches the convention violation Copilot flagged: passing
      // `new Date()` as a parameter would let clock skew between nodes
      // leak into updated_at. The SQL must call now() inline.
      await connectorHealthRepository.upsert({
        userId: USER_ID,
        connectorName: 'gmail',
        status: 'connected',
        lastSuccessAt: new Date(),
      });
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/VALUES\s*\([^)]*now\(\)\s*\)/);
      expect(sql).toMatch(/updated_at\s*=\s*now\(\)/);
      // Only 6 params (userId, connectorName, status, errorCode,
      // lastSuccessAt, lastFailureAt) — updated_at must NOT be one.
      expect(args).toHaveLength(6);
    });

    it('preserves last_success_at across a needs_reauth flap (COALESCE on the conflict branch)', async () => {
      await connectorHealthRepository.upsert({
        userId: USER_ID,
        connectorName: 'gmail',
        status: 'needs_reauth',
        errorCode: 'invalid_grant',
        lastFailureAt: new Date('2026-05-25T13:00:00Z'),
        // lastSuccessAt deliberately omitted — the existing row's
        // last_success_at marker must survive.
      });
      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain(
        'last_success_at = COALESCE(EXCLUDED.last_success_at, connector_health.last_success_at)',
      );
      expect(sql).toContain(
        'last_failure_at = COALESCE(EXCLUDED.last_failure_at, connector_health.last_failure_at)',
      );
    });

    it('null-coalesces optional fields so callers can omit them', async () => {
      await connectorHealthRepository.upsert({
        userId: USER_ID,
        connectorName: 'gmail',
        status: 'disabled',
      });
      const [, args] = mockQuery.mock.calls[0]!;
      expect(args[3]).toBeNull(); // errorCode
      expect(args[4]).toBeNull(); // lastSuccessAt
      expect(args[5]).toBeNull(); // lastFailureAt
    });
  });

  describe('findByUser', () => {
    it('returns all rows sorted by connector_name', async () => {
      const rows = [
        {
          user_id: USER_ID,
          connector_name: 'gcal',
          status: 'connected',
          error_code: null,
          last_success_at: new Date('2026-05-25T12:00:00Z'),
          last_failure_at: null,
          updated_at: new Date('2026-05-25T12:00:00Z'),
        },
        {
          user_id: USER_ID,
          connector_name: 'gmail',
          status: 'needs_reauth',
          error_code: 'invalid_grant',
          last_success_at: new Date('2026-05-24T12:00:00Z'),
          last_failure_at: new Date('2026-05-25T13:00:00Z'),
          updated_at: new Date('2026-05-25T13:00:00Z'),
        },
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: rows.length });

      const result = await connectorHealthRepository.findByUser(USER_ID);
      expect(result).toEqual(rows);
      const [sql, args] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).toContain('ORDER BY connector_name');
      expect(args).toEqual([USER_ID]);
    });

    it('returns empty array when the user has no rows', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      const result = await connectorHealthRepository.findByUser(USER_ID);
      expect(result).toEqual([]);
    });
  });
});
