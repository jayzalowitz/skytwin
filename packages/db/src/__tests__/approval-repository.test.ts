import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { approvalRepository } = await import('../repositories/approval-repository.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeApprovalRow(overrides: Partial<{
  id: string;
  user_id: string;
  decision_id: string;
  candidate_action: Record<string, unknown>;
  reason: string;
  urgency: string;
  status: string;
  requested_at: Date;
  responded_at: Date | null;
  response: Record<string, unknown> | null;
  expires_at: Date;
  batch_id: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'ar-001',
    user_id: overrides.user_id ?? 'u-001',
    decision_id: overrides.decision_id ?? 'd-001',
    candidate_action: overrides.candidate_action ?? { type: 'send_email' },
    reason: overrides.reason ?? 'High cost action',
    urgency: overrides.urgency ?? 'normal',
    status: overrides.status ?? 'pending',
    requested_at: overrides.requested_at ?? new Date('2026-03-01'),
    responded_at: overrides.responded_at ?? null,
    response: overrides.response ?? null,
    expires_at: overrides.expires_at ?? new Date('2026-03-02'),
    batch_id: overrides.batch_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approvalRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('inserts a pending approval request with correct params', async () => {
      const row = fakeApprovalRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await approvalRepository.create({
        userId: 'u-001',
        decisionId: 'd-001',
        candidateAction: { type: 'send_email' },
        reason: 'High cost action',
        urgency: 'normal',
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO approval_requests');
      expect(sql).toContain("'pending'");
      expect(sql).toContain('RETURNING *');
      expect(params![0]).toBe('u-001');
      expect(params![1]).toBe('d-001');
      expect(params![2]).toBe(JSON.stringify({ type: 'send_email' }));
      expect(params![3]).toBe('High cost action');
      expect(params![4]).toBe('normal');
      // Default expiry should be ~24h from now
      expect(params![5]).toBeInstanceOf(Date);
    });

    it('uses provided expiresAt when specified', async () => {
      const customExpiry = new Date('2026-06-15T12:00:00Z');
      const row = fakeApprovalRow({ expires_at: customExpiry });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await approvalRepository.create({
        userId: 'u-001',
        decisionId: 'd-001',
        candidateAction: {},
        reason: 'test',
        urgency: 'high',
        expiresAt: customExpiry,
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![5]).toEqual(customExpiry);
    });

    it("defaults confirmation_level to 'single' when not provided", async () => {
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      await approvalRepository.create({
        userId: 'u-001',
        decisionId: 'd-001',
        candidateAction: {},
        reason: 'test',
        urgency: 'normal',
      });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('confirmation_level');
      expect(params![6]).toBe('single');
    });

    it("passes confirmation_level='dual' through for extreme-severity approvals", async () => {
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      await approvalRepository.create({
        userId: 'u-001',
        decisionId: 'd-001',
        candidateAction: {},
        reason: 'extreme action',
        urgency: 'high',
        confirmationLevel: 'dual',
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![6]).toBe('dual');
    });

    it('uses ON CONFLICT (decision_id) DO NOTHING so re-ingestion never stacks a duplicate', async () => {
      // Regression: the same signal can be ingested more than once (a worker
      // restart, an at-least-once delivery retry, or — the original bug —
      // two worker processes both polling). Without this guard every
      // re-ingestion created another approval_request and the dashboard
      // showed every email twice. The unique index in migration 046 backs
      // this clause.
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      await approvalRepository.create({
        userId: 'u-001',
        decisionId: 'd-001',
        candidateAction: {},
        reason: 'test',
        urgency: 'normal',
      });

      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT (decision_id) DO NOTHING');
    });

    it('returns the existing approval when the INSERT conflicts (re-ingestion is a no-op)', async () => {
      // ON CONFLICT DO NOTHING returns zero rows when an approval already
      // exists for the decision. create() must then fetch and return the
      // existing row so callers (events.ts, assistant.ts) always get a valid
      // approval back and re-ingestion never stacks a duplicate. The
      // fallback SELECT is scoped by user_id to match every other read in
      // this repository.
      const existing = fakeApprovalRow({ id: 'ar-existing', decision_id: 'd-001' });
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT … ON CONFLICT DO NOTHING
        .mockResolvedValueOnce({ rows: [existing], rowCount: 1 }); // fallback SELECT

      const result = await approvalRepository.create({
        userId: 'u-001',
        decisionId: 'd-001',
        candidateAction: {},
        reason: 'test',
        urgency: 'normal',
      });

      expect(result).toEqual(existing);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const [fallbackSql, fallbackParams] = mockQuery.mock.calls[1]!;
      expect(fallbackSql).toContain('SELECT * FROM approval_requests');
      expect(fallbackSql).toContain('WHERE decision_id = $1');
      expect(fallbackSql).toContain('AND user_id = $2');
      expect(fallbackParams).toEqual(['d-001', 'u-001']);
    });

    it('throws when the INSERT conflicts but the fallback SELECT finds nothing', async () => {
      // The conflicting row was hard-deleted between the INSERT and the
      // fallback SELECT (a concurrent migration dedup or admin cleanup).
      // create() must throw a typed error rather than return `undefined`
      // typed as a valid ApprovalRequestRow — callers dereference `.id`.
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT … ON CONFLICT DO NOTHING
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // fallback SELECT also empty

      await expect(
        approvalRepository.create({
          userId: 'u-001',
          decisionId: 'd-001',
          candidateAction: {},
          reason: 'test',
          urgency: 'normal',
        }),
      ).rejects.toThrow(/vanished between INSERT conflict and fallback SELECT/);
    });
  });

  // -----------------------------------------------------------------------
  // recordFirstConfirmation (dual-confirmation injection guard)
  // -----------------------------------------------------------------------

  describe('recordFirstConfirmation', () => {
    it('issues a token and scopes the UPDATE to pending dual requests', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      const token = await approvalRepository.recordFirstConfirmation('ar-001', 'u-001');

      expect(typeof token).toBe('string');
      expect((token as string).length).toBeGreaterThan(0);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE approval_requests');
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("confirmation_level = 'dual'");
      // Strictly single-shot: the `first_confirmed_at IS NULL` guard means a
      // token is minted exactly once per request. Re-calling never re-mints,
      // so a replayed first-confirmation POST cannot invalidate the token the
      // legitimate user already holds. It is also race-safe — a concurrent
      // first-confirmation matches zero rows and returns null.
      expect(sql).toContain('first_confirmed_at IS NULL');
      // The issued token is param 1; it must match the returned value.
      expect(params![0]).toBe(token);
      expect(params![1]).toBe('ar-001');
      expect(params![2]).toBe('u-001');
    });

    it('returns null when the request is not an updatable dual/pending row', async () => {
      // A row already first-confirmed, no longer pending, or not dual fails the
      // WHERE clause — the UPDATE matches nothing and no token is issued.
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const token = await approvalRepository.recordFirstConfirmation('ar-001', 'u-001');
      expect(token).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // findPending
  // -----------------------------------------------------------------------

  describe('findPending', () => {
    it('returns only pending approvals for the user, ordered by requested_at DESC', async () => {
      const rows = [
        fakeApprovalRow({ id: 'ar-002', requested_at: new Date('2026-03-02') }),
        fakeApprovalRow({ id: 'ar-001', requested_at: new Date('2026-03-01') }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await approvalRepository.findPending('u-001');

      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('user_id = $1');
      expect(sql).toContain('ORDER BY requested_at DESC');
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual(['u-001', 100]);
    });

    it('returns empty array when no pending approvals exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await approvalRepository.findPending('u-001');
      expect(result).toEqual([]);
    });

    it('respects custom limit parameter', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await approvalRepository.findPending('u-001', 50);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual(['u-001', 50]);
    });
  });

  // -----------------------------------------------------------------------
  // findById
  // -----------------------------------------------------------------------

  describe('findById', () => {
    it('returns approval when found', async () => {
      const row = fakeApprovalRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await approvalRepository.findById('ar-001');
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await approvalRepository.findById('ghost');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // respond
  // -----------------------------------------------------------------------

  describe('respond', () => {
    it('includes AND status = \'pending\' in WHERE clause to prevent double-response', async () => {
      const row = fakeApprovalRow({ status: 'approved' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'approve', 'user-1', 'LGTM');

      const [sql, params] = mockQuery.mock.calls[0]!;
      // This is the critical safety check -- only pending approvals can be responded to
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('AND user_id = $4');
      expect(sql).toContain('RETURNING *');
      expect(params![0]).toBe('approved');
      expect(params![2]).toBe('ar-001');
      expect(params![3]).toBe('user-1');
    });

    it('maps "approve" action to "approved" status', async () => {
      const row = fakeApprovalRow({ status: 'approved' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'approve', 'user-1');

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![0]).toBe('approved');
      expect(params![1]).toBe(JSON.stringify({ action: 'approve', reason: null }));
    });

    it('maps "reject" action to "rejected" status', async () => {
      const row = fakeApprovalRow({ status: 'rejected' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'reject', 'user-1', 'Too expensive');

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![0]).toBe('rejected');
      expect(params![1]).toBe(JSON.stringify({ action: 'reject', reason: 'Too expensive' }));
    });

    it('returns null when no pending approval is found (already responded or wrong id)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await approvalRepository.respond('ar-already-done', 'approve', 'user-1');
      expect(result).toBeNull();
    });

    it('serializes reason as null when omitted', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'approve', 'user-1');

      const [_sql, params] = mockQuery.mock.calls[0]!;
      const parsedResponse = JSON.parse(params![1] as string);
      expect(parsedResponse.reason).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // findByUser
  // -----------------------------------------------------------------------

  describe('findByUser', () => {
    it('queries with default limit of 50', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await approvalRepository.findByUser('u-001');

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).toContain('ORDER BY requested_at DESC');
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual(['u-001', 50]);
    });

    it('respects custom limit', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await approvalRepository.findByUser('u-001', 10);

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual(['u-001', 10]);
    });
  });

  // -----------------------------------------------------------------------
  // expirePending
  // -----------------------------------------------------------------------

  describe('expirePending', () => {
    it('updates past-due pending approvals to expired', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 5 });

      const count = await approvalRepository.expirePending();

      expect(count).toBe(5);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('UPDATE approval_requests');
      expect(sql).toContain("SET status = 'expired'");
      expect(sql).toContain("WHERE status = 'pending'");
      expect(sql).toContain('expires_at < now()');
      expect(sql).toContain('responded_at = now()');
      expect(params).toEqual([]);
    });

    it('returns 0 when no approvals are past-due', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const count = await approvalRepository.expirePending();
      expect(count).toBe(0);
    });

    it('returns 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null });

      const count = await approvalRepository.expirePending();
      expect(count).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // findByBatch
  // -----------------------------------------------------------------------

  describe('findByBatch', () => {
    it('returns approvals for a batch id', async () => {
      const rows = [
        fakeApprovalRow({ id: 'ar-001', batch_id: 'batch-1' }),
        fakeApprovalRow({ id: 'ar-002', batch_id: 'batch-1' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await approvalRepository.findByBatch('batch-1');

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE batch_id = $1');
      expect(params).toEqual(['batch-1']);
    });
  });

  // -----------------------------------------------------------------------
  // batchRespond
  // -----------------------------------------------------------------------

  describe('batchRespond', () => {
    it('returns empty array for empty ids list', async () => {
      const result = await approvalRepository.batchRespond([], 'approve', 'user-1');

      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('generates correct placeholder SQL for multiple ids', async () => {
      const rows = [
        fakeApprovalRow({ id: 'ar-001', status: 'approved' }),
        fakeApprovalRow({ id: 'ar-002', status: 'approved' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await approvalRepository.batchRespond(
        ['ar-001', 'ar-002', 'ar-003'],
        'approve',
        'user-1',
        'Bulk approve',
      );

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      // IDs start at $4, $5, $6
      expect(sql).toContain('WHERE id IN ($4, $5, $6)');
      expect(sql).toContain("AND status = 'pending'");
      expect(sql).toContain('AND user_id = $3');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'approved',
        JSON.stringify({ action: 'approve', reason: 'Bulk approve' }),
        'user-1',
        'ar-001',
        'ar-002',
        'ar-003',
      ]);
    });

    it('uses "rejected" status for reject action', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await approvalRepository.batchRespond(['ar-001'], 'reject', 'user-1', 'Nope');

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE id IN ($4)');
      expect(params![0]).toBe('rejected');
    });

    it('generates sequential placeholders for single id', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      await approvalRepository.batchRespond(['ar-only'], 'approve', 'user-1');

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE id IN ($4)');
      expect(params).toEqual([
        'approved',
        JSON.stringify({ action: 'approve', reason: null }),
        'user-1',
        'ar-only',
      ]);
    });

    it('only affects pending approvals (includes status = pending in WHERE)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await approvalRepository.batchRespond(['ar-001'], 'approve', 'user-1');

      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("AND status = 'pending'");
      expect(sql).toContain('AND user_id = $3');
    });
  });

  // -----------------------------------------------------------------------
  // findByUser — cleaned filter
  // -----------------------------------------------------------------------

  describe('findByUser', () => {
    it('excludes cleaned status from results', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await approvalRepository.findByUser('u-001');

      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status != 'cleaned'");
    });
  });

  // -----------------------------------------------------------------------
  // deleteStaleEscalations (soft-delete)
  // -----------------------------------------------------------------------

  describe('deleteStaleEscalations', () => {
    it('soft-deletes stale escalations by setting status to cleaned', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 3 });

      const count = await approvalRepository.deleteStaleEscalations('u-001');

      expect(count).toBe(3);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("SET status = 'cleaned'");
      expect(sql).toContain('responded_at = now()');
      expect(sql).toContain('user_id = $1');
      expect(sql).toContain("candidate_action->>'actionType' = 'escalate_to_user'");
      expect(sql).toContain("status IN ('expired', 'pending')");
      expect(params).toEqual(['u-001']);
    });

    it('returns 0 when no stale escalations exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const count = await approvalRepository.deleteStaleEscalations('u-001');
      expect(count).toBe(0);
    });

    it('returns 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null });

      const count = await approvalRepository.deleteStaleEscalations('u-001');
      expect(count).toBe(0);
    });
  });
});
