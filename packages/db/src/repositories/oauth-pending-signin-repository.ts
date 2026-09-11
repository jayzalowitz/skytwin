import { query } from '../connection.js';
import type { PoolClient } from 'pg';

/**
 * Pending-completion handoff for new-user OAuth flows. `pending_key` is a
 * legacy column name: it stores only the domain-separated SHA-256 digest of
 * the client-held capability, never the capability itself.
 *
 * Rows are immutable and insert-only. A digest collision is a typed failure;
 * it must never transfer an OAuth result or an already-bound session to a
 * different callback. Redemption retains the row for its bounded TTL so a
 * lost success response returns the same session identity.
 */
export interface RememberPendingSigninInput {
  pendingKeyDigest: string;
  userId: string;
  accountEmail: string;
  scopes: string[];
  nextHash: string | null;
  expiresAt: Date;
}

const PENDING_KEY_DIGEST_RE = /^[0-9a-f]{64}$/;

export class PendingSigninCollisionError extends Error {
  readonly code = 'oauth_pending_signin_collision';

  constructor() {
    super('Pending OAuth handoff already exists');
    this.name = 'PendingSigninCollisionError';
  }
}

export const oauthPendingSigninRepository = {
  async remember(input: RememberPendingSigninInput, client?: PoolClient): Promise<void> {
    if (!PENDING_KEY_DIGEST_RE.test(input.pendingKeyDigest)) {
      throw new TypeError('pendingKeyDigest must be a lowercase SHA-256 digest');
    }
    const sql = `INSERT INTO oauth_pending_signin
         (pending_key, user_id, account_email, scopes, next_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pending_key) DO NOTHING
       RETURNING pending_key`;
    const params = [
      input.pendingKeyDigest,
      input.userId,
      input.accountEmail,
      JSON.stringify(input.scopes),
      input.nextHash,
      input.expiresAt,
    ];
    const result = client
      ? await client.query<{ pending_key: string }>(sql, params)
      : await query<{ pending_key: string }>(sql, params);
    if (!result.rows[0]) throw new PendingSigninCollisionError();

    if (client) return;
    oauthPendingSigninRepository.sweepExpired().catch(() => {
      // Stable text only: database errors may include bound values.
      // eslint-disable-next-line no-console
      console.warn('[oauth-pending-signin] expired-row sweep failed');
    });
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
