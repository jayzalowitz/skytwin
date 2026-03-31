import { query } from '../connection.js';
import type { FeedbackEventRow, PaginationOptions } from '../types.js';

/**
 * Input for creating a feedback event.
 */
export interface CreateFeedbackInput {
  userId: string;
  decisionId: string;
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Repository for feedback event operations.
 */
export const feedbackRepository = {
  /**
   * Create a new feedback event.
   */
  async create(input: CreateFeedbackInput): Promise<FeedbackEventRow> {
    const result = await query<FeedbackEventRow>(
      `INSERT INTO feedback_events (user_id, decision_id, type, data)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.userId,
        input.decisionId,
        input.type,
        JSON.stringify(input.data ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Find feedback events for a user, with pagination.
   * Ordered by most recent first.
   */
  async findByUser(
    userId: string,
    opts: PaginationOptions = {},
  ): Promise<FeedbackEventRow[]> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const result = await query<FeedbackEventRow>(
      `SELECT * FROM feedback_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows;
  },

  /**
   * Find all feedback events for a specific decision.
   */
  async findByDecision(
    decisionId: string,
  ): Promise<FeedbackEventRow[]> {
    const result = await query<FeedbackEventRow>(
      `SELECT * FROM feedback_events
       WHERE decision_id = $1
       ORDER BY created_at`,
      [decisionId],
    );
    return result.rows;
  },
};
