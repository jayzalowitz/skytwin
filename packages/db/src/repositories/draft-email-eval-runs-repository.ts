import { query, withTransaction } from '../connection.js';
import type { EvalResult, EvalThresholds } from '@skytwin/decision-engine';

/**
 * Audit-trail storage for draft-email eval-bench runs (#301).
 *
 * Each call to the bench writes one row here. The most recent row's
 * `passed=true` timestamp also updates `twin_profiles.drafts_eval_passed_at`
 * (via `recordRun` below, in the same transaction), so the gating
 * check is a single read on twin_profiles rather than a join.
 */

export interface DraftEmailEvalRunRow {
  id: string;
  user_id: string;
  corpus_size: number;
  voice_score: number;
  topical_score: number;
  length_score: number;
  passed: boolean;
  thresholds: EvalThresholds;
  notes: string;
  ran_at: Date;
}

export interface RecordEvalRunInput {
  userId: string;
  result: EvalResult;
}

export const draftEmailEvalRunsRepository = {
  /**
   * Persist a completed eval run. On `result.passed === true`, also
   * stamps `twin_profiles.drafts_eval_passed_at = now()` in the same
   * transaction so a downstream gate-check reads a consistent view.
   * Returns the inserted run row.
   */
  async recordRun(input: RecordEvalRunInput): Promise<DraftEmailEvalRunRow> {
    return withTransaction(async (client) => {
      const insertResult = await client.query<DraftEmailEvalRunRow>(
        `INSERT INTO draft_email_eval_runs
           (user_id, corpus_size, voice_score, topical_score, length_score,
            passed, thresholds, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.userId,
          input.result.corpusSize,
          input.result.voicePassRate,
          input.result.topicalPassRate,
          input.result.lengthPassRate,
          input.result.passed,
          JSON.stringify(input.result.thresholds),
          input.result.notes,
        ],
      );
      if (input.result.passed) {
        await client.query(
          'UPDATE twin_profiles SET drafts_eval_passed_at = now(), updated_at = now() WHERE user_id = $1',
          [input.userId],
        );
      }
      return insertResult.rows[0]!;
    });
  },

  /**
   * Most recent eval run for a user, regardless of pass/fail. Used
   * by the dashboard to render "last eval ran X ago, passed/failed."
   */
  async getLatestForUser(userId: string): Promise<DraftEmailEvalRunRow | null> {
    const result = await query<DraftEmailEvalRunRow>(
      `SELECT * FROM draft_email_eval_runs
       WHERE user_id = $1
       ORDER BY ran_at DESC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Recent run history for trend analysis. Newest first.
   */
  async listForUser(
    userId: string,
    limit: number = 20,
  ): Promise<DraftEmailEvalRunRow[]> {
    const result = await query<DraftEmailEvalRunRow>(
      `SELECT * FROM draft_email_eval_runs
       WHERE user_id = $1
       ORDER BY ran_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },
};
