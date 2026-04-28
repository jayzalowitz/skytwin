import { query } from '../connection.js';

export interface ForwardedSignalRow {
  user_id: string;
  signal_key: string;
  forwarded_at: Date;
}

/**
 * Persistent ledger of `(userId, signalKey)` pairs the worker has already
 * forwarded to the API. Backs the in-memory SignalDeduper so the dedup
 * window survives worker restarts.
 *
 * `signal_key` is the same key the in-memory deduper composes —
 * `${signal.source}:${signal.id}` — so the two layers stay in lockstep
 * without a translation step.
 */
export const forwardedSignalsRepository = {
  /**
   * Idempotent insert. Many callers go through here on startup hydration
   * and during per-poll write-through, so collisions are expected.
   */
  async mark(userId: string, signalKey: string): Promise<void> {
    await query(
      `INSERT INTO forwarded_signals (user_id, signal_key)
       VALUES ($1, $2)
       ON CONFLICT (user_id, signal_key) DO NOTHING`,
      [userId, signalKey],
    );
  },

  /**
   * Bulk version of mark(). Used when hydrating the deduper or writing
   * a batch of newly forwarded signals.
   */
  async markBatch(entries: Array<{ userId: string; signalKey: string }>): Promise<void> {
    if (entries.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const entry of entries) {
      values.push(`($${i++}, $${i++})`);
      params.push(entry.userId, entry.signalKey);
    }
    await query(
      `INSERT INTO forwarded_signals (user_id, signal_key)
       VALUES ${values.join(', ')}
       ON CONFLICT (user_id, signal_key) DO NOTHING`,
      params,
    );
  },

  /**
   * All rows newer than `now() - ttlMs`. Used by the worker's startup
   * hydration to repopulate the in-memory deduper.
   */
  async listSince(ttlMs: number): Promise<ForwardedSignalRow[]> {
    const result = await query<ForwardedSignalRow>(
      `SELECT user_id, signal_key, forwarded_at
         FROM forwarded_signals
        WHERE forwarded_at > now() - ($1::INTERVAL)`,
      [`${Math.max(1, Math.floor(ttlMs / 1000))} seconds`],
    );
    return result.rows;
  },

  /**
   * Drop rows past the TTL window. Returns the number of rows removed
   * so the caller can log it.
   */
  async gcOlderThan(ttlMs: number): Promise<number> {
    const result = await query(
      `DELETE FROM forwarded_signals
        WHERE forwarded_at <= now() - ($1::INTERVAL)`,
      [`${Math.max(1, Math.floor(ttlMs / 1000))} seconds`],
    );
    return result.rowCount ?? 0;
  },
};
