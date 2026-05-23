import { query } from '../connection.js';

/**
 * Pending-completion handoff for desktop new-user OAuth flows
 * (`oauth_pending_signin`, migration 059). The desktop wizard
 * generates a UUID before opening the system browser; /callback
 * writes the resulting userId here; the wizard polls `consume()` and
 * advances on hit.
 *
 * Semantics mirror `oauth-pkce-pending-repository`:
 *   - `remember()` upserts on pending_key. A re-issued key (same
 *     wizard click, different OAuth round-trip) overwrites.
 *   - `consume()` is DELETE...RETURNING so a leaked key can only be
 *     redeemed once.
 *   - `sweepExpired()` called best-effort on every remember().
 */
export interface RememberPendingSigninInput {
  pendingKey: string;
  userId: string;
  accountEmail: string;
  scopes: string[];
  nextHash: string | null;
  expiresAt: Date;
}

export interface ConsumedPendingSignin {
  userId: string;
  accountEmail: string;
  scopes: string[];
  nextHash: string | null;
}

export const oauthPendingSigninRepository = {
  async remember(input: RememberPendingSigninInput): Promise<void> {
    await query(
      `INSERT INTO oauth_pending_signin
         (pending_key, user_id, account_email, scopes, next_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pending_key) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         account_email = EXCLUDED.account_email,
         scopes = EXCLUDED.scopes,
         next_hash = EXCLUDED.next_hash,
         expires_at = EXCLUDED.expires_at`,
      [
        input.pendingKey,
        input.userId,
        input.accountEmail,
        JSON.stringify(input.scopes),
        input.nextHash,
        input.expiresAt,
      ],
    );
    // Best-effort sweep. The header docstring promises this, and without
    // it the table grows monotonically as users abandon mid-flight OAuth
    // (close the consent tab, kill the wizard, hit the 5-min poll
    // timeout). Sweep failures are logged (not swallowed) so operators
    // can see if the table is growing because cleanup is broken — empty
    // catch was the original sin. Called by explicit reference instead
    // of `this` so a future destructuring caller (`const { remember } = repo`)
    // doesn't TypeError on `this.sweepExpired`.
    oauthPendingSigninRepository.sweepExpired().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[oauth-pending-signin] sweepExpired failed (housekeeping, primary write succeeded):', err);
    });
  },

  /**
   * Consume-on-read. Returns null if the row doesn't exist or has expired
   * — the desktop wizard treats both the same way (keep polling, or time
   * out after its own 5-minute window).
   *
   * The DELETE's WHERE includes `expires_at >= $now` so an expired row
   * is NOT deleted on read — `sweepExpired()` is the only path that
   * removes expired rows, and it runs from /callback's `remember()`.
   * Without this predicate, a poll that arrives 1ms past the TTL would
   * destroy the row, and any subsequent legitimate poll from the same
   * wizard (network jitter, tab discarded then restored) would 404 even
   * though the OAuth round-trip succeeded.
   */
  async consume(
    pendingKey: string,
    now: Date = new Date(),
  ): Promise<ConsumedPendingSignin | null> {
    const result = await query<{
      user_id: string;
      account_email: string;
      scopes: unknown;
      next_hash: string | null;
      expires_at: Date;
    }>(
      `DELETE FROM oauth_pending_signin
        WHERE pending_key = $1
          AND expires_at >= $2
       RETURNING user_id, account_email, scopes, next_hash, expires_at`,
      [pendingKey, now],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      accountEmail: row.account_email,
      scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
      nextHash: row.next_hash,
    };
  },

  async sweepExpired(now: Date = new Date()): Promise<number> {
    const result = await query(
      'DELETE FROM oauth_pending_signin WHERE expires_at < $1',
      [now],
    );
    return result.rowCount ?? 0;
  },

  async _countForTests(): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM oauth_pending_signin',
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  },
};
