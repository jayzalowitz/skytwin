import { query } from '../connection.js';
import type { OauthPkcePendingRow } from '../types.js';

/**
 * PKCE verifier store for the Google OAuth round-trip.
 *
 * Backed by the `oauth_pkce_pending` table (migration 058) so a process
 * restart between /authorize and /callback doesn't drop the verifier and
 * leave the user stuck on "OAuth verifier expired."
 *
 * Semantics:
 *   - `remember()` upserts: if a state token is re-issued (the desktop
 *     re-clicks Sign in within the TTL window), we overwrite the verifier
 *     so the freshest one wins. The state itself is HMAC-signed and
 *     long-random, so collisions don't happen in practice.
 *   - `consume()` is consume-on-read: it returns the verifier AND deletes
 *     the row in a single statement. A replayed /callback can't redeem
 *     the same code twice.
 *   - `sweepExpired()` clears rows whose TTL has passed. Cheap; safe to
 *     call from any insert path.
 */
export const oauthPkcePendingRepository = {
  /** Store (or replace) the verifier for this signed state token. */
  async remember(state: string, codeVerifier: string, expiresAt: Date): Promise<void> {
    await query(
      `INSERT INTO oauth_pkce_pending (state, code_verifier, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (state) DO UPDATE SET
         code_verifier = EXCLUDED.code_verifier,
         expires_at = EXCLUDED.expires_at`,
      [state, codeVerifier, expiresAt],
    );
  },

  /**
   * Atomically delete-and-return the verifier for this state. Returns
   * undefined if the row doesn't exist OR has already expired.
   */
  async consume(state: string, now: Date = new Date()): Promise<string | undefined> {
    const result = await query<Pick<OauthPkcePendingRow, 'code_verifier' | 'expires_at'>>(
      `DELETE FROM oauth_pkce_pending
        WHERE state = $1
       RETURNING code_verifier, expires_at`,
      [state],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.expires_at.getTime() < now.getTime()) return undefined;
    return row.code_verifier;
  },

  /** Drop expired rows. Safe to call from insert paths. */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const result = await query(
      'DELETE FROM oauth_pkce_pending WHERE expires_at < $1',
      [now],
    );
    return result.rowCount ?? 0;
  },

  /** Test/observability helper — current row count. */
  async _countForTests(): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM oauth_pkce_pending',
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  },
};
