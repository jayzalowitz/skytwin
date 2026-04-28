import { query } from '../connection.js';
import type { OAuthTokenRow } from '../types.js';

/**
 * Repository for OAuth token CRUD.
 *
 * A user may have multiple accounts per provider (e.g. personal + work
 * Gmail), uniquely keyed by `(user_id, provider, account_email)`. Methods
 * that take only `(userId, provider)` operate on the *first* matching row
 * — kept around as a backwards-compatible shorthand for the common
 * single-account case. Anything that needs to disambiguate (worker, multi-
 * account UI, disconnect-one) should use the *ByAccount variants.
 */
export const oauthRepository = {
  /** First matching row for (userId, provider). For multi-account-aware callers, use getTokenByAccount. */
  async getToken(userId: string, provider: string): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = $2 ORDER BY updated_at DESC LIMIT 1',
      [userId, provider],
    );
    return result.rows[0] ?? null;
  },

  async getTokenByAccount(
    userId: string,
    provider: string,
    accountEmail: string,
  ): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = $2 AND account_email = $3',
      [userId, provider, accountEmail],
    );
    return result.rows[0] ?? null;
  },

  /** All accounts a user has connected for a given provider. */
  async listAccountsForUser(userId: string, provider: string): Promise<OAuthTokenRow[]> {
    const result = await query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = $2 ORDER BY updated_at DESC',
      [userId, provider],
    );
    return result.rows;
  },

  /** Every connection across every user; used by the worker's poll loop. */
  async listAllConnections(): Promise<OAuthTokenRow[]> {
    const result = await query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE refresh_token IS NOT NULL',
    );
    return result.rows;
  },

  /**
   * Multi-account-aware save: idempotent on (user_id, provider, account_email).
   * Use this from the OAuth callback so adding a second account creates a new
   * row, while reconsenting on the same email updates in place.
   */
  async saveTokenForAccount(input: {
    userId: string;
    provider: string;
    accountEmail: string;
    accountProviderId?: string | null;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scopes: string[];
  }): Promise<OAuthTokenRow> {
    const result = await query<OAuthTokenRow>(
      `INSERT INTO oauth_tokens (
         user_id, provider, account_email, account_provider_id,
         access_token, refresh_token, expires_at, scopes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
         account_provider_id = COALESCE(EXCLUDED.account_provider_id, oauth_tokens.account_provider_id),
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = now()
       RETURNING *`,
      [
        input.userId,
        input.provider,
        input.accountEmail,
        input.accountProviderId ?? null,
        input.accessToken,
        input.refreshToken,
        input.expiresAt,
        input.scopes,
      ],
    );
    return result.rows[0]!;
  },

  /**
   * Legacy single-account save. Persists to the row keyed on the user's
   * primary email if a multi-account row doesn't already exist; otherwise
   * updates the most recently touched row. Kept for callers that haven't
   * migrated to the multi-account flow yet.
   */
  async saveToken(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
    scopes: string[],
  ): Promise<OAuthTokenRow> {
    const existing = await this.getToken(userId, provider);
    const accountEmail = existing?.account_email ?? '';
    return this.saveTokenForAccount({
      userId,
      provider,
      accountEmail,
      accountProviderId: existing?.account_provider_id ?? null,
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
    });
  },

  /** Delete every account for (userId, provider). */
  async deleteAllForProvider(userId: string, provider: string): Promise<number> {
    const result = await query(
      'DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
    return result.rowCount ?? 0;
  },

  /** Delete a single account row. */
  async deleteAccount(
    userId: string,
    provider: string,
    accountEmail: string,
  ): Promise<boolean> {
    const result = await query(
      'DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2 AND account_email = $3',
      [userId, provider, accountEmail],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async updateAccessTokenByAccount(
    userId: string,
    provider: string,
    accountEmail: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      `UPDATE oauth_tokens
       SET access_token = $1, expires_at = $2, updated_at = now()
       WHERE user_id = $3 AND provider = $4 AND account_email = $5
       RETURNING *`,
      [accessToken, expiresAt, userId, provider, accountEmail],
    );
    return result.rows[0] ?? null;
  },

  // ── Backwards-compat shims ─────────────────────────────────────────────
  // Older single-account callers; equivalent to operating on the first
  // (or all) row(s) for (userId, provider).

  async deleteToken(userId: string, provider: string): Promise<boolean> {
    const removed = await this.deleteAllForProvider(userId, provider);
    return removed > 0;
  },

  async updateAccessToken(
    userId: string,
    provider: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      `UPDATE oauth_tokens
       SET access_token = $1, expires_at = $2, updated_at = now()
       WHERE user_id = $3 AND provider = $4
       RETURNING *`,
      [accessToken, expiresAt, userId, provider],
    );
    return result.rows[0] ?? null;
  },

  async getUsersWithActiveTokens(): Promise<OAuthTokenRow[]> {
    return this.listAllConnections();
  },
};
