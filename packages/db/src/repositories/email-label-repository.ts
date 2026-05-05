import { query } from '../connection.js';

/**
 * One observed (sender, label) tuple from a Gmail message.
 *
 * The connector emits one of these per labelId on each message it fetches.
 * `sender` is the bare email address (display name stripped). `listId` is
 * the parsed RFC 2919 List-Id header value when present.
 */
export interface EmailLabelObservation {
  sender: string;
  label: string;
  listId?: string | null;
}

/**
 * Aggregated row read back from `email_label_signals` for a given sender.
 */
export interface SenderLabelStat {
  label: string;
  count: number;
  lastSeenAt: Date;
}

interface EmailLabelSignalRow {
  user_id: string;
  sender: string;
  label: string;
  list_id: string | null;
  count: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

/**
 * Per-user, per-sender Gmail label evidence store.
 *
 * Issue #122: replaces the hardcoded keyword `inferLabels()` classifier with
 * a learned model populated from each user's actual Gmail history. The
 * connector calls `recordObservations` on every fetched message; the
 * decision-engine calls `topLabelsForSender` when generating a `label_email`
 * candidate.
 */
export const emailLabelRepository = {
  /**
   * Bulk-upsert label observations for a single message.
   *
   * Increments `count` and bumps `last_seen_at` on each existing
   * `(user_id, sender, label)`; inserts new rows otherwise. The call is
   * idempotent per row but additive across calls — observing the same
   * message twice would over-count, so callers should dedupe upstream
   * (the Gmail history-API path already does via `forwarded_signals`).
   */
  async recordObservations(
    userId: string,
    observations: EmailLabelObservation[],
  ): Promise<void> {
    if (observations.length === 0) return;

    for (const obs of observations) {
      if (!obs.sender || !obs.label) continue;
      await query(
        `INSERT INTO email_label_signals (user_id, sender, label, list_id, count)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (user_id, sender, label) DO UPDATE SET
           count = email_label_signals.count + 1,
           list_id = COALESCE(EXCLUDED.list_id, email_label_signals.list_id),
           last_seen_at = now()`,
        [userId, obs.sender, obs.label, obs.listId ?? null],
      );
    }
  },

  /**
   * Top labels seen for a given sender, most-frequent first.
   *
   * Returns an empty array when the sender has no history — the caller
   * should fall back to keyword inference (or List-Id lookup) in that case.
   */
  async topLabelsForSender(
    userId: string,
    sender: string,
    limit = 3,
  ): Promise<SenderLabelStat[]> {
    if (!sender) return [];
    const result = await query<EmailLabelSignalRow>(
      `SELECT label, count, last_seen_at
         FROM email_label_signals
        WHERE user_id = $1 AND sender = $2
        ORDER BY count DESC, last_seen_at DESC
        LIMIT $3`,
      [userId, sender, limit],
    );
    return result.rows.map((row) => ({
      label: row.label,
      count: row.count,
      lastSeenAt: row.last_seen_at,
    }));
  },

  /**
   * Top labels seen for a given List-Id (mailing-list traffic), most-frequent
   * first. Used as a secondary signal when the per-sender lookup is empty
   * but the message belongs to a mailing list we've observed before.
   */
  async topLabelsForListId(
    userId: string,
    listId: string,
    limit = 3,
  ): Promise<SenderLabelStat[]> {
    if (!listId) return [];
    const result = await query<{ label: string; count: number; last_seen_at: Date }>(
      `SELECT label, SUM(count)::INT AS count, MAX(last_seen_at) AS last_seen_at
         FROM email_label_signals
        WHERE user_id = $1 AND list_id = $2
        GROUP BY label
        ORDER BY count DESC, last_seen_at DESC
        LIMIT $3`,
      [userId, listId, limit],
    );
    return result.rows.map((row) => ({
      label: row.label,
      count: row.count,
      lastSeenAt: row.last_seen_at,
    }));
  },
};
