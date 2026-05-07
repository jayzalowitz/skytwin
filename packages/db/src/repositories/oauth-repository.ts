import type { PoolClient } from 'pg';
import { query } from '../connection.js';
import type { OAuthTokenRow, OAuthTokenRowWithEncrypted } from '../types.js';

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
   * Legacy single-account save. When a row already exists for this
   * (userId, provider) we update it in place; otherwise we look up the
   * user's primary email and key the new row on that, so legacy callers
   * never produce a placeholder `account_email = ''` row that would
   * shadow the real per-account row created by /google/callback.
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
    let accountEmail = existing?.account_email ?? '';
    let accountProviderId = existing?.account_provider_id ?? null;
    if (!accountEmail) {
      const userRow = await query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [userId],
      );
      accountEmail = userRow.rows[0]?.email ?? '';
    }
    return this.saveTokenForAccount({
      userId,
      provider,
      accountEmail,
      accountProviderId,
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

  // ── Encrypted-column methods (credential vault) ────────────────────────

  /**
   * Return the full row including encrypted_* columns for a given row id.
   * Used by the lazy-migration path in DbTokenStore.
   */
  async findByIdWithEncrypted(id: string): Promise<OAuthTokenRowWithEncrypted | null> {
    const result = await query<OAuthTokenRowWithEncrypted>(
      `SELECT id, user_id, provider, account_email, account_provider_id,
              access_token, refresh_token, expires_at, scopes, created_at, updated_at,
              encrypted_access_token, encrypted_refresh_token,
              encryption_iv, encryption_tag, encryption_key_version
       FROM oauth_tokens
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Write encrypted columns for a token row.
   * Clears the plaintext columns (sets them to NULL) as part of the lazy migration.
   *
   * IMPORTANT: After this call the plaintext columns are NULL. Do not call
   * this unless the decrypted value has been successfully verified first.
   */
  async updateEncrypted(
    id: string,
    input: {
      encryptedAccessToken: Buffer;
      encryptedRefreshToken: Buffer;
      iv: Buffer;
      tag: Buffer;
      keyVersion: number;
    },
  ): Promise<void> {
    await query(
      `UPDATE oauth_tokens
       SET encrypted_access_token  = $1,
           encrypted_refresh_token = $2,
           encryption_iv           = $3,
           encryption_tag          = $4,
           encryption_key_version  = $5,
           access_token            = NULL,
           refresh_token           = NULL,
           updated_at              = now()
       WHERE id = $6`,
      [
        input.encryptedAccessToken,
        input.encryptedRefreshToken,
        input.iv,
        input.tag,
        input.keyVersion,
        id,
      ],
    );
  },

  /**
   * Return all rows for a user that have encrypted_access_token present.
   * Used by the key-rotation path to iterate over rows that need re-encryption.
   *
   * Accepts an optional PoolClient so the caller can include this SELECT in a
   * serialisable transaction — required by the rotation flow to avoid a TOCTOU
   * race between SELECT and the per-row UPDATEs.
   */
  async listEncryptedForUser(
    userId: string,
    client?: PoolClient,
  ): Promise<OAuthTokenRowWithEncrypted[]> {
    const sql = `SELECT id, user_id, provider, account_email, account_provider_id,
              access_token, refresh_token, expires_at, scopes, created_at, updated_at,
              encrypted_access_token, encrypted_refresh_token,
              encryption_iv, encryption_tag, encryption_key_version
       FROM oauth_tokens
       WHERE user_id = $1
         AND encrypted_access_token IS NOT NULL`;
    const result = client
      ? await client.query<OAuthTokenRowWithEncrypted>(sql, [userId])
      : await query<OAuthTokenRowWithEncrypted>(sql, [userId]);
    return result.rows;
  },

  /**
   * Re-encrypt a single row's encrypted columns in place.
   * Unlike updateEncrypted, this does NOT touch plaintext columns — they are
   * already NULL for fully-migrated rows, and rotation must not clear them again.
   *
   * Accepts an optional PoolClient so the caller can include this in a
   * serialisable transaction.
   */
  async rotateEncrypted(
    id: string,
    input: {
      encryptedAccessToken: Buffer;
      encryptedRefreshToken: Buffer;
      keyVersion: number;
    },
    client?: PoolClient,
  ): Promise<void> {
    const sql = `UPDATE oauth_tokens
       SET encrypted_access_token  = $1,
           encrypted_refresh_token = $2,
           encryption_key_version  = $3,
           updated_at              = now()
       WHERE id = $4`;
    const params = [
      input.encryptedAccessToken,
      input.encryptedRefreshToken,
      input.keyVersion,
      id,
    ];

    if (client) {
      await client.query(sql, params);
    } else {
      await query(sql, params);
    }
  },
};
