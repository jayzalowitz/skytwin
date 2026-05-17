import { query, withTransaction } from '../connection.js';

/**
 * Worker→API bridge for trust-tier promotion ceremonies (#310).
 *
 * The worker writes one row per eligible (server, proposed_tier) tuple.
 * The dashboard polls `listPending(userId)` to render the modal. When
 * the user clicks Accept, the API hits `markResponded(id, 'accepted')`
 * and separately bumps `mcp_servers.trust_tier`.
 *
 * Idempotency. `createIfPending` is INSERT ... ON CONFLICT DO NOTHING
 * against the partial unique index on (server_id, proposed_tier)
 * WHERE responded_at IS NULL, so re-runs of the eligibility job don't
 * pile up duplicate offers for the same server.
 */

export interface PromotionOfferRow {
  id: string;
  user_id: string;
  server_id: string;
  current_tier: string;
  proposed_tier: string;
  reason: string;
  decisions_observed_count: number;
  approved_count: number;
  offered_at: Date;
  responded_at: Date | null;
  response: string | null;
}

export interface CreatePromotionOfferInput {
  userId: string;
  serverId: string;
  currentTier: string;
  proposedTier: string;
  reason: string;
  decisionsObservedCount: number;
  approvedCount: number;
}

export type PromotionOfferResponse = 'accepted' | 'rejected' | 'dismissed';

export const promotionOffersRepository = {
  /**
   * Insert a new pending offer. Returns the inserted row, or `null`
   * when a pending offer already exists for (server, proposed_tier) —
   * the partial unique index dedups concurrent writes.
   */
  async createIfPending(
    input: CreatePromotionOfferInput,
  ): Promise<PromotionOfferRow | null> {
    const result = await query<PromotionOfferRow>(
      `INSERT INTO promotion_offers
         (user_id, server_id, current_tier, proposed_tier, reason,
          decisions_observed_count, approved_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT promotion_offers_pending_uniq DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.serverId,
        input.currentTier,
        input.proposedTier,
        input.reason,
        input.decisionsObservedCount,
        input.approvedCount,
      ],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Return all pending offers for a user, newest first. The dashboard
   * calls this on connect and on every poll tick. The query reads
   * from the `(user_id, responded_at, offered_at DESC)` composite
   * index — partial-index-equivalent lookup with no full scan.
   */
  async listPending(userId: string): Promise<PromotionOfferRow[]> {
    const result = await query<PromotionOfferRow>(
      `SELECT * FROM promotion_offers
       WHERE user_id = $1 AND responded_at IS NULL
       ORDER BY offered_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Return pending offers joined with their server's display name so
   * the dashboard can render the modal without a second roundtrip.
   * Used by the API GET endpoint.
   */
  async listPendingWithServerName(
    userId: string,
  ): Promise<Array<PromotionOfferRow & { server_name: string | null }>> {
    const result = await query<PromotionOfferRow & { server_name: string | null }>(
      `SELECT po.*, ms.display_name AS server_name
       FROM promotion_offers po
       LEFT JOIN mcp_servers ms ON ms.id = po.server_id
       WHERE po.user_id = $1 AND po.responded_at IS NULL
       ORDER BY po.offered_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Get a single offer by id. Used by the response endpoint to read
   * the current_tier/proposed_tier snapshot before promoting the
   * mcp_servers row.
   */
  async findById(id: string): Promise<PromotionOfferRow | null> {
    const result = await query<PromotionOfferRow>(
      'SELECT * FROM promotion_offers WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Mark an offer as responded. Returns the updated row, or `null`
   * when the offer didn't exist or was already responded to (the
   * WHERE filter excludes already-responded rows so a duplicate
   * click can't overwrite an earlier response). Used by the
   * rejected/dismissed paths; the accept path uses `acceptAtomic`
   * below for transaction-safety against concurrent double-clicks.
   */
  async markResponded(
    id: string,
    response: PromotionOfferResponse,
  ): Promise<PromotionOfferRow | null> {
    const result = await query<PromotionOfferRow>(
      `UPDATE promotion_offers
       SET responded_at = now(), response = $1
       WHERE id = $2 AND responded_at IS NULL
       RETURNING *`,
      [response, id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Atomic accept: validate the offer is still pending AND the
   * server is still at the snapshot tier AND bump the server's
   * trust_tier — all in one CRDB serializable transaction.
   *
   * Replaces a prior sequence that did "validate, update tier,
   * mark responded" as three separate queries (Copilot caught the
   * race: two concurrent Accept clicks could each pass the
   * snapshot check, both bump the tier, and confuse the ledger
   * about which response "won"). With SELECT FOR UPDATE on both
   * the offer row and the server row, concurrent transactions
   * serialize through and the second click sees `alreadyResponded`.
   *
   * Returns a tagged result the caller can branch on:
   *   - { row, ...all-false }                      → success
   *   - { row: null, alreadyResponded: true }      → 409
   *   - { row: null, staleSnapshot: true }         → 409 (tier changed)
   *   - { row: null, serverMissing: true }         → 409 (server gone)
   * In the stale / missing cases the offer is also marked
   * responded='rejected' inside the transaction so it doesn't stay
   * pending forever — the partial unique index on (server_id,
   * proposed_tier) WHERE responded_at IS NULL would otherwise
   * prevent the worker from offering at the same tier again.
   */
  async acceptAtomic(input: {
    offerId: string;
    serverId: string;
    expectedCurrentTier: string;
    proposedTier: string;
  }): Promise<{
    row: PromotionOfferRow | null;
    alreadyResponded: boolean;
    staleSnapshot: boolean;
    serverMissing: boolean;
    notFound: boolean;
  }> {
    return withTransaction(async (client) => {
      const offerResult = await client.query<PromotionOfferRow>(
        'SELECT * FROM promotion_offers WHERE id = $1 FOR UPDATE',
        [input.offerId],
      );
      const offer = offerResult.rows[0];
      if (!offer) {
        return {
          row: null,
          alreadyResponded: false,
          staleSnapshot: false,
          serverMissing: false,
          notFound: true,
        };
      }
      if (offer.responded_at !== null) {
        return {
          row: offer,
          alreadyResponded: true,
          staleSnapshot: false,
          serverMissing: false,
          notFound: false,
        };
      }

      const serverResult = await client.query<{ trust_tier: string }>(
        'SELECT trust_tier FROM mcp_servers WHERE id = $1 FOR UPDATE',
        [input.serverId],
      );
      const server = serverResult.rows[0];
      if (!server) {
        // Server gone — clean up the offer ledger so it doesn't
        // dangle. Same transaction as the SELECT for consistency.
        await client.query(
          `UPDATE promotion_offers
           SET responded_at = now(), response = $1
           WHERE id = $2`,
          ['rejected', input.offerId],
        );
        return {
          row: null,
          alreadyResponded: false,
          staleSnapshot: false,
          serverMissing: true,
          notFound: false,
        };
      }
      if (server.trust_tier !== input.expectedCurrentTier) {
        await client.query(
          `UPDATE promotion_offers
           SET responded_at = now(), response = $1
           WHERE id = $2`,
          ['rejected', input.offerId],
        );
        return {
          row: null,
          alreadyResponded: false,
          staleSnapshot: true,
          serverMissing: false,
          notFound: false,
        };
      }

      // All checks pass — promote + mark accepted, both in this txn.
      await client.query(
        'UPDATE mcp_servers SET trust_tier = $1, updated_at = now() WHERE id = $2',
        [input.proposedTier, input.serverId],
      );
      const updatedResult = await client.query<PromotionOfferRow>(
        `UPDATE promotion_offers
         SET responded_at = now(), response = $1
         WHERE id = $2
         RETURNING *`,
        ['accepted', input.offerId],
      );
      return {
        row: updatedResult.rows[0] ?? null,
        alreadyResponded: false,
        staleSnapshot: false,
        serverMissing: false,
        notFound: false,
      };
    });
  },

  /**
   * Find offers across all users that became visible after `since`,
   * joined with the server's display name for SSE payload assembly.
   * The API's SSE sweeper uses this to emit `capability:promotion-
   * offered` events on live connections — a UX optimization on top
   * of the durable poll surface. Excludes responded offers so a
   * sweep doesn't re-emit anything the user already acted on.
   */
  async listOfferedSince(
    since: Date,
  ): Promise<Array<PromotionOfferRow & { server_name: string | null }>> {
    const result = await query<PromotionOfferRow & { server_name: string | null }>(
      `SELECT po.*, ms.display_name AS server_name
       FROM promotion_offers po
       LEFT JOIN mcp_servers ms ON ms.id = po.server_id
       WHERE po.offered_at > $1 AND po.responded_at IS NULL
       ORDER BY po.offered_at ASC`,
      [since],
    );
    return result.rows;
  },
};
