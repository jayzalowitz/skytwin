import { query } from '../connection.js';

export interface AppSuggestionRow {
  id: string;
  user_id: string;
  registry_id: string;
  display_name: string;
  evidence_count: number;
  evidence_sources: unknown;
  evidence_kinds_distinct: number;
  first_evidence_at: Date;
  last_evidence_at: Date;
  confidence_score: string;
  status: 'pending' | 'dismissed' | 'accepted' | 'snoozed' | 'superseded' | 'auto-installed';
  snoozed_until: Date | null;
  reason_summary: string | null;
  push_notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertPendingSuggestionInput {
  userId: string;
  registryId: string;
  displayName: string;
  evidenceCount: number;
  evidenceSources: unknown;
  evidenceKindsDistinct: number;
  firstEvidenceAt: Date;
  lastEvidenceAt: Date;
  confidenceScore: number;
  reasonSummary?: string;
}

export const appSuggestionRepository = {
  /**
   * Insert a new pending suggestion or update an existing pending row's
   * evidence fields. Conflicts on (user_id, registry_id) WHERE status='pending'
   * update in place so we don't accumulate duplicate pending rows.
   * Does not overwrite rows whose status is already non-pending.
   */
  async upsertPending(input: UpsertPendingSuggestionInput): Promise<AppSuggestionRow> {
    const result = await query<AppSuggestionRow>(
      `INSERT INTO app_suggestions
         (user_id, registry_id, display_name, evidence_count, evidence_sources,
          evidence_kinds_distinct, first_evidence_at, last_evidence_at,
          confidence_score, reason_summary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       ON CONFLICT (user_id, registry_id) WHERE status = 'pending'
       DO UPDATE SET
         display_name             = EXCLUDED.display_name,
         evidence_count           = EXCLUDED.evidence_count,
         evidence_sources         = EXCLUDED.evidence_sources,
         evidence_kinds_distinct  = EXCLUDED.evidence_kinds_distinct,
         first_evidence_at        = LEAST(app_suggestions.first_evidence_at, EXCLUDED.first_evidence_at),
         last_evidence_at         = GREATEST(app_suggestions.last_evidence_at, EXCLUDED.last_evidence_at),
         confidence_score         = EXCLUDED.confidence_score,
         reason_summary           = EXCLUDED.reason_summary,
         updated_at               = now()
       RETURNING *`,
      [
        input.userId,
        input.registryId,
        input.displayName,
        input.evidenceCount,
        JSON.stringify(input.evidenceSources),
        input.evidenceKindsDistinct,
        input.firstEvidenceAt,
        input.lastEvidenceAt,
        input.confidenceScore,
        input.reasonSummary ?? null,
      ],
    );
    return result.rows[0]!;
  },

  async getPendingForUser(userId: string): Promise<AppSuggestionRow[]> {
    const result = await query<AppSuggestionRow>(
      `SELECT * FROM app_suggestions
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY confidence_score DESC, last_evidence_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Returns all active (pending + snoozed) suggestion rows for a user,
   * keyed on registry_id. Useful for the inference job's snooze check.
   */
  async getActiveForUser(userId: string): Promise<AppSuggestionRow[]> {
    const result = await query<AppSuggestionRow>(
      `SELECT * FROM app_suggestions
       WHERE user_id = $1 AND status IN ('pending', 'snoozed')
       ORDER BY confidence_score DESC, last_evidence_at DESC`,
      [userId],
    );
    return result.rows;
  },

  async markDismissed(id: string): Promise<AppSuggestionRow | null> {
    const result = await query<AppSuggestionRow>(
      `UPDATE app_suggestions
       SET status = 'dismissed', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async markSnoozed(id: string, untilDate: Date): Promise<AppSuggestionRow | null> {
    const result = await query<AppSuggestionRow>(
      `UPDATE app_suggestions
       SET status = 'snoozed', snoozed_until = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [untilDate, id],
    );
    return result.rows[0] ?? null;
  },

  async markAccepted(id: string): Promise<AppSuggestionRow | null> {
    const result = await query<AppSuggestionRow>(
      `UPDATE app_suggestions
       SET status = 'accepted', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Returns dismissed rows updated within the last `withinDays` days for a
   * user. Used by the capability inference job to honour the dismissed-cooldown
   * rule before re-surfacing a suggestion.
   */
  async getRecentlyDismissedForUser(
    userId: string,
    withinDays: number,
  ): Promise<AppSuggestionRow[]> {
    const result = await query<AppSuggestionRow>(
      `SELECT * FROM app_suggestions
       WHERE user_id = $1
         AND status = 'dismissed'
         AND updated_at >= now() - ($2::INT * INTERVAL '1 day')`,
      [userId, withinDays],
    );
    return result.rows;
  },
};
