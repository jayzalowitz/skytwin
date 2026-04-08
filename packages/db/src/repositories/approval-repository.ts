import { query } from '../connection.js';
import type { ApprovalRequestRow } from '../types.js';

/**
 * Repository for approval request CRUD operations.
 */
export const approvalRepository = {
  async create(input: {
    userId: string;
    decisionId: string;
    candidateAction: Record<string, unknown>;
    reason: string;
    urgency: string;
    expiresAt?: Date;
  }): Promise<ApprovalRequestRow> {
    const result = await query<ApprovalRequestRow>(
      `INSERT INTO approval_requests (user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now(), $6)
       RETURNING *`,
      [
        input.userId,
        input.decisionId,
        JSON.stringify(input.candidateAction),
        input.reason,
        input.urgency,
        input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
    return result.rows[0]!;
  },

  async findPending(userId: string, limit: number = 100): Promise<ApprovalRequestRow[]> {
    const result = await query<ApprovalRequestRow>(
      `SELECT * FROM approval_requests
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY requested_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },

  async findById(id: string): Promise<ApprovalRequestRow | null> {
    const result = await query<ApprovalRequestRow>(
      'SELECT * FROM approval_requests WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  async respond(
    id: string,
    action: 'approve' | 'reject',
    userId: string,
    reason?: string,
  ): Promise<ApprovalRequestRow | null> {
    const result = await query<ApprovalRequestRow>(
      `UPDATE approval_requests
       SET status = $1, responded_at = now(), response = $2
       WHERE id = $3 AND status = 'pending' AND user_id = $4
       RETURNING *`,
      [
        action === 'approve' ? 'approved' : 'rejected',
        JSON.stringify({ action, reason: reason ?? null }),
        id,
        userId,
      ],
    );
    return result.rows[0] ?? null;
  },

  async findByUser(userId: string, limit: number = 50): Promise<ApprovalRequestRow[]> {
    const result = await query<ApprovalRequestRow>(
      `SELECT * FROM approval_requests
       WHERE user_id = $1 AND status != 'cleaned'
       ORDER BY requested_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },

  /**
   * Mark all pending approvals past their expiry as 'expired'.
   * Returns the number of expired requests.
   */
  async expirePending(): Promise<number> {
    const result = await query(
      `UPDATE approval_requests
       SET status = 'expired', responded_at = now()
       WHERE status = 'pending' AND expires_at < now()`,
      [],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Soft-delete stale escalation-only approval requests by setting status = 'cleaned'.
   * These are "escalate_to_user" actions that expired without user response.
   * Keeps the records for pattern analysis while hiding them from the active UI.
   */
  async deleteStaleEscalations(userId: string): Promise<number> {
    const result = await query(
      `UPDATE approval_requests
       SET status = 'cleaned', responded_at = now()
       WHERE user_id = $1
         AND candidate_action->>'actionType' = 'escalate_to_user'
         AND status IN ('expired', 'pending')
         AND (status = 'expired' OR expires_at < now())`,
      [userId],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Find all approvals in a batch.
   */
  async findByBatch(batchId: string): Promise<ApprovalRequestRow[]> {
    const result = await query<ApprovalRequestRow>(
      `SELECT * FROM approval_requests
       WHERE batch_id = $1
       ORDER BY requested_at DESC`,
      [batchId],
    );
    return result.rows;
  },

  /**
   * Respond to multiple approval requests at once.
   * Only updates requests owned by the given userId and still pending.
   * Returns the updated rows.
   */
  async batchRespond(
    ids: string[],
    action: 'approve' | 'reject',
    userId: string,
    reason?: string,
  ): Promise<ApprovalRequestRow[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map((_, i) => `$${i + 4}`).join(', ');
    const status = action === 'approve' ? 'approved' : 'rejected';

    const result = await query<ApprovalRequestRow>(
      `UPDATE approval_requests
       SET status = $1, responded_at = now(), response = $2
       WHERE id IN (${placeholders}) AND status = 'pending' AND user_id = $3
       RETURNING *`,
      [
        status,
        JSON.stringify({ action, reason: reason ?? null }),
        userId,
        ...ids,
      ],
    );
    return result.rows;
  },
};
