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
      expect(params).toEqual(['u-001']);
    });

    it('returns empty array when no pending approvals exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await approvalRepository.findPending('u-001');
      expect(result).toEqual([]);
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

      await approvalRepository.respond('ar-001', 'approve', 'LGTM');

      const [sql, params] = mockQuery.mock.calls[0]!;
      // This is the critical safety check -- only pending approvals can be responded to
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('WHERE id = $3 AND');
      expect(sql).toContain('RETURNING *');
      expect(params![0]).toBe('approved');
      expect(params![2]).toBe('ar-001');
    });

    it('maps "approve" action to "approved" status', async () => {
      const row = fakeApprovalRow({ status: 'approved' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'approve');

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![0]).toBe('approved');
      expect(params![1]).toBe(JSON.stringify({ action: 'approve', reason: null }));
    });

    it('maps "reject" action to "rejected" status', async () => {
      const row = fakeApprovalRow({ status: 'rejected' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'reject', 'Too expensive');

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![0]).toBe('rejected');
      expect(params![1]).toBe(JSON.stringify({ action: 'reject', reason: 'Too expensive' }));
    });

    it('returns null when no pending approval is found (already responded or wrong id)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await approvalRepository.respond('ar-already-done', 'approve');
      expect(result).toBeNull();
    });

    it('serializes reason as null when omitted', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeApprovalRow()], rowCount: 1 });

      await approvalRepository.respond('ar-001', 'approve');

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
});
