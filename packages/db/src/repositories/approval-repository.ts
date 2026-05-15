import { randomBytes } from 'crypto';
import { query } from '../connection.js';
import type { ApprovalRequestRow } from '../types.js';

/**
 * Repository for approval request CRUD operations.
 */
export const approvalRepository = {
  /**
   * Insert a pending approval for a decision, or return the existing one
   * if a re-ingestion of the same signal already created it.
   *
   * Returns `{ row, created }` where `created` is true only when this call
   * was the one that wrote the row — false when ON CONFLICT (decision_id)
   * absorbed the INSERT and the row came back from the fallback SELECT.
   * Callers gate side-effects (SSE emission, audit-trail entries, badge
   * pings) on `created` so a re-ingestion is invisible end-to-end, not
   * just at the DB level.
   */
  async create(input: {
    userId: string;
    decisionId: string;
    candidateAction: Record<string, unknown>;
    reason: string;
    urgency: string;
    expiresAt?: Date;
    /** 'single' (default) or 'dual'. 'dual' is set by the injection guard
     *  for extreme-severity actions and requires two token-gated confirms. */
    confirmationLevel?: 'single' | 'dual';
  }): Promise<{ row: ApprovalRequestRow; created: boolean }> {
    const result = await query<ApprovalRequestRow>(
      `INSERT INTO approval_requests (user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at, confirmation_level)
       VALUES ($1, $2, $3, $4, $5, 'pending', now(), $6, $7)
       ON CONFLICT (decision_id) DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.decisionId,
        JSON.stringify(input.candidateAction),
        input.reason,
        input.urgency,
        input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
        input.confirmationLevel ?? 'single',
      ],
    );
    if (result.rows[0]) {
      return { row: result.rows[0], created: true };
    }
    // ON CONFLICT DO NOTHING returned no row: an approval_request already
    // exists for this decision. This happens whenever the same signal is
    // re-ingested — a worker restart, an at-least-once delivery retry, or
    // two worker processes both polling. The unique index on decision_id
    // (migration 046) makes the duplicate INSERT a no-op; return the
    // existing row so re-ingestion is transparent to callers and never
    // stacks a duplicate approval. Scoped by user_id to match every other
    // read in this repository — a decision_id belongs to one user, so the
    // scope is also a belt-and-suspenders guard against ever handing back
    // another user's row.
    const existing = await query<ApprovalRequestRow>(
      'SELECT * FROM approval_requests WHERE decision_id = $1 AND user_id = $2',
      [input.decisionId, input.userId],
    );
    if (!existing.rows[0]) {
      // The INSERT conflicted but no row came back — the conflicting row
      // was hard-deleted between the INSERT and this SELECT (a concurrent
      // migration dedup or admin cleanup). Surface a typed error rather
      // than returning `undefined` typed as ApprovalRequestRow: a thrown
      // error is debuggable, `undefined.id` three call frames away is not.
      throw new Error(
        `approval_requests row for decision ${input.decisionId} vanished ` +
          `between INSERT conflict and fallback SELECT`,
      );
    }
    return { row: existing.rows[0], created: false };
  },

  /**
   * Record the FIRST confirmation of a dual-confirmation request and issue a
   * one-time token the caller must present on the second confirmation.
   *
   * The `first_confirmed_at IS NULL` guard makes this strictly single-shot:
   *
   * - A token is minted exactly once per request. Re-calling never re-mints,
   *   so a replayed or double-fired first-confirmation POST can never
   *   invalidate the token the legitimate user is already holding.
   * - It is race-safe. Between the route reading the row and calling this,
   *   another request could first-confirm it; the guard means the second
   *   UPDATE matches zero rows and returns null, and the route returns 409.
   *
   * Trade-off: a page refresh between the two confirmation steps drops the
   * in-memory token and the request cannot be completed in that session —
   * it stays pending and expires (or the user rejects it). For an
   * extreme-severity action that friction is acceptable: "start the whole
   * approval fresh" is the safe behavior, not a re-issued token.
   *
   * Returns the freshly issued token, or null if the request is no longer
   * pending, is not a dual-confirmation request, or was already
   * first-confirmed.
   */
  async recordFirstConfirmation(
    id: string,
    userId: string,
  ): Promise<string | null> {
    const token = randomBytes(24).toString('base64url');
    const result = await query<ApprovalRequestRow>(
      `UPDATE approval_requests
       SET first_confirmed_at = now(), confirmation_token = $1
       WHERE id = $2 AND user_id = $3 AND status = 'pending'
         AND confirmation_level = 'dual' AND first_confirmed_at IS NULL
       RETURNING *`,
      [token, id, userId],
    );
    return result.rows[0] ? token : null;
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

  /**
   * Look up the approval that exists for a decision. The unique index on
   * `approval_requests(decision_id)` (migration 046) means there is at
   * most one row per decision; this is the read counterpart to the
   * ON CONFLICT path inside `create()`. Scoped by `userId` to match
   * every other read in this repository — a decision belongs to one
   * user, so the scope is also a belt-and-suspenders guard against ever
   * handing back another user's row.
   *
   * Used by `events.ts` to recover the existing approval when a signal
   * is re-ingested (decisionRepository.create returned `created: false`)
   * so the API response surfaces the original approval id and status
   * instead of running the approval-creation step a second time.
   */
  async findByDecisionId(
    decisionId: string,
    userId: string,
  ): Promise<ApprovalRequestRow | null> {
    const result = await query<ApprovalRequestRow>(
      'SELECT * FROM approval_requests WHERE decision_id = $1 AND user_id = $2',
      [decisionId, userId],
    );
    return result.rows[0] ?? null;
  },

  async respond(
    id: string,
    action: 'approve' | 'reject',
    userId: string,
    reason?: string,
  ): Promise<ApprovalRequestRow | null> {
    // `confirmation_token = NULL` clears the one-time dual-confirmation token
    // the moment the request resolves — it must not linger in the row after
    // use. Harmless for single-confirmation rows (their token is already
    // NULL). The `status = 'pending'` guard still makes this the atomic
    // single-winner for concurrent responses.
    const result = await query<ApprovalRequestRow>(
      `UPDATE approval_requests
       SET status = $1, responded_at = now(), response = $2, confirmation_token = NULL
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
