import type { PoolClient } from 'pg';
import { query, withTransaction } from '../connection.js';
import type { OAuthTokenRow, OAuthTokenRowWithEncrypted } from '../types.js';
import {
  connectedAccountRepository,
  canonicalizeScopes,
  digestProviderSubject,
} from './connected-account-repository.js';

export class OAuthAccountBindingConflictError extends Error {
  readonly code = 'oauth_account_binding_conflict';
}

async function withSerializableRetry<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(fn);
    } catch (error) {
      lastError = error;
      if ((error as { code?: unknown } | null)?.code !== '40001' || attempt === 2) throw error;
    }
  }
  throw lastError;
}

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

  /** Resolve one credential through its stable owner/account binding. */
  async getTokenByConnectorAccount(
    userId: string,
    provider: string,
    connectorAccountId: string,
  ): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      `SELECT t.* FROM oauth_tokens AS t
       JOIN connected_accounts AS ca
         ON ca.id = t.connector_account_id
        AND ca.user_id = t.user_id
        AND ca.provider = t.provider
      WHERE t.user_id = $1 AND t.provider = $2 AND t.connector_account_id = $3
        AND ca.is_active = true AND ca.identity_verified = true`,
      [userId, provider, connectorAccountId],
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
      `SELECT t.* FROM oauth_tokens AS t
       JOIN connected_accounts AS ca
         ON ca.id = t.connector_account_id
        AND ca.user_id = t.user_id
        AND ca.provider = t.provider
      WHERE ca.is_active = true AND ca.identity_verified = true
        AND (t.refresh_token IS NOT NULL OR t.encrypted_refresh_token IS NOT NULL)
      ORDER BY t.user_id, t.provider, t.updated_at DESC, t.id DESC`,
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
    return withSerializableRetry(async (client) => {
      const provider = input.provider.trim().toLowerCase();
      const accountEmail = input.accountEmail.trim().toLowerCase();
      const scopes = canonicalizeScopes(input.scopes);
      const prior = await client.query<Pick<OAuthTokenRow, 'id' | 'connector_account_id'> & {
        provider_subject_digest: string | null;
        identity_verified: boolean;
      }>(
        `SELECT t.id, t.connector_account_id, ca.provider_subject_digest, ca.identity_verified
           FROM oauth_tokens AS t
           JOIN connected_accounts AS ca ON ca.id = t.connector_account_id
          WHERE t.user_id = $1 AND t.provider = $2 AND lower(t.account_email) = lower($3)
          ORDER BY t.updated_at DESC, t.id DESC
          FOR UPDATE`,
        [input.userId, provider, accountEmail],
      );
      if (prior.rows.length > 1) {
        throw new OAuthAccountBindingConflictError(
          'Multiple legacy credentials match this display email case-insensitively; reconnect requires operator reconciliation.',
        );
      }

      const account = input.accountProviderId?.trim()
        ? await connectedAccountRepository.upsertVerified({
            userId: input.userId,
            provider,
            providerSubject: input.accountProviderId,
            accountDisplay: accountEmail,
            scopes,
          }, client)
        : prior.rows[0]?.connector_account_id
          ? await connectedAccountRepository.findOwnedActive(
              input.userId,
              prior.rows[0].connector_account_id,
              provider,
              client,
            ) ?? await connectedAccountRepository.createUnverified({
              userId: input.userId,
              provider,
              accountDisplay: accountEmail,
              scopes,
            }, client)
          : await connectedAccountRepository.createUnverified({
              userId: input.userId,
              provider,
              accountDisplay: accountEmail,
              scopes,
            }, client);

      if (input.accountProviderId?.trim() && prior.rows[0]?.identity_verified) {
        const expectedDigest = digestProviderSubject(provider, input.accountProviderId);
        if (prior.rows[0].provider_subject_digest !== expectedDigest) {
          throw new OAuthAccountBindingConflictError(
            'Display email is already bound to a different verified provider subject.',
          );
        }
      }

      // A verified callback can move a legacy token onto the verified stable
      // identity. Retire the old identity in the same transaction so there is
      // never a second active account that appears to own this credential.
      const priorConnectorAccountId = prior.rows[0]?.connector_account_id;
      if (priorConnectorAccountId && priorConnectorAccountId !== account.id) {
        await client.query(
          `UPDATE connector_cursors
              SET connector_account_id = $1, updated_at = now()
            WHERE connector_account_id = $2 AND user_id = $3`,
          [account.id, priorConnectorAccountId, input.userId],
        );
        await client.query(
          `DELETE FROM connector_health
            WHERE user_id = $1 AND connector_name IN (
              'gmail:' || $2, 'google-calendar:' || $2,
              'outlook_mail:' || $2, 'outlook_calendar:' || $2
            )`,
          [input.userId, priorConnectorAccountId],
        );
        await client.query(
          `UPDATE connected_accounts
              SET is_active = false, disconnected_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND provider = $3`,
          [priorConnectorAccountId, input.userId, provider],
        );
      }

      const tokenUpdateSql = `UPDATE oauth_tokens SET
           account_email = $1,
           account_provider_id = COALESCE($2, account_provider_id),
           access_token = $3,
           refresh_token = $4,
           expires_at = $5,
           scopes = $6,
           encrypted_access_token = NULL,
           encrypted_refresh_token = NULL,
           encryption_iv = NULL,
           encryption_tag = NULL,
           encryption_key_version = 1,
           connector_account_id = $7,
           credential_revision = gen_random_uuid(),
           updated_at = now()`;
      const updateParams = [
        accountEmail,
        input.accountProviderId?.trim() || null,
        input.accessToken,
        input.refreshToken,
        input.expiresAt,
        scopes,
        account.id,
      ];

      // Prefer the row found through the case-insensitive display-email lookup.
      // This atomically rebinds migration-era mixed-case rows instead of
      // creating a second secret row under a normalized email.
      if (prior.rows[0]) {
        const rebound = await client.query<OAuthTokenRow>(
          `${tokenUpdateSql} WHERE id = $8 AND user_id = $9 AND provider = $10 RETURNING *`,
          [...updateParams, prior.rows[0].id, input.userId, provider],
        );
        if (rebound.rows[0]) return rebound.rows[0];
      }

      // Otherwise prefer the stable account binding. This preserves the token
      // row when a provider changes its display email.
      const byStableAccount = await client.query<OAuthTokenRow>(
        `${tokenUpdateSql}
         WHERE user_id = $8 AND provider = $9 AND connector_account_id = $7
         RETURNING *`,
        [...updateParams, input.userId, provider],
      );
      if (byStableAccount.rows[0]) return byStableAccount.rows[0];

      const result = await client.query<OAuthTokenRow>(
        `INSERT INTO oauth_tokens (
           user_id, provider, account_email, account_provider_id,
           access_token, refresh_token, expires_at, scopes, connector_account_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
           account_provider_id = COALESCE(EXCLUDED.account_provider_id, oauth_tokens.account_provider_id),
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           scopes = EXCLUDED.scopes,
           encrypted_access_token = NULL,
           encrypted_refresh_token = NULL,
           encryption_iv = NULL,
           encryption_tag = NULL,
           encryption_key_version = 1,
           connector_account_id = EXCLUDED.connector_account_id,
           credential_revision = gen_random_uuid(),
           updated_at = now()
         WHERE oauth_tokens.connector_account_id = EXCLUDED.connector_account_id
         RETURNING *`,
        [
          input.userId,
          provider,
          accountEmail,
          input.accountProviderId?.trim() || null,
          input.accessToken,
          input.refreshToken,
          input.expiresAt,
          scopes,
          account.id,
        ],
      );
      if (!result.rows[0]) {
        throw new OAuthAccountBindingConflictError(
          'Display email is already bound to a different verified provider subject.',
        );
      }
      return result.rows[0];
    });
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
    return withTransaction(async (client) => {
      await client.query(
        `DELETE FROM connector_health AS h
          WHERE h.user_id = $1 AND EXISTS (
            SELECT 1 FROM connected_accounts AS ca
             WHERE ca.user_id = $1 AND ca.provider = $2
               AND h.connector_name IN (
                 'gmail:' || ca.id::STRING,
                 'google-calendar:' || ca.id::STRING,
                 'outlook_mail:' || ca.id::STRING,
                 'outlook_calendar:' || ca.id::STRING
               )
          )`,
        [userId, provider],
      );
      await connectedAccountRepository.deactivateAllForProvider(userId, provider, client);
      const result = await client.query(
        'DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2',
        [userId, provider],
      );
      return result.rowCount ?? 0;
    });
  },

  /** Delete a single account row. */
  async deleteAccount(
    userId: string,
    provider: string,
    accountEmail: string,
  ): Promise<boolean> {
    return connectedAccountRepository.deactivateAndDeleteAccount(
      userId,
      provider,
      accountEmail,
    );
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
       SET access_token = $1, expires_at = $2,
           credential_revision = gen_random_uuid(), updated_at = now()
       WHERE user_id = $3 AND provider = $4 AND account_email = $5
       RETURNING *`,
      [accessToken, expiresAt, userId, provider, accountEmail],
    );
    return result.rows[0] ?? null;
  },

  async updateAccessTokenByConnectorAccount(
    userId: string,
    provider: string,
    connectorAccountId: string,
    accessToken: string,
    expiresAt: Date,
    expectedCredentialRevision: string,
  ): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      `UPDATE oauth_tokens AS t
       SET access_token = $1, expires_at = $2,
           credential_revision = gen_random_uuid(), updated_at = now()
       FROM connected_accounts AS ca
       WHERE t.user_id = $3 AND t.provider = $4 AND t.connector_account_id = $5
         AND ca.id = t.connector_account_id AND ca.user_id = t.user_id
         AND ca.provider = t.provider AND ca.is_active = true
         AND ca.identity_verified = true AND t.credential_revision = $6
       RETURNING t.*`,
      [accessToken, expiresAt, userId, provider, connectorAccountId, expectedCredentialRevision],
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
       SET access_token = $1, expires_at = $2,
           credential_revision = gen_random_uuid(), updated_at = now()
       WHERE user_id = $3 AND provider = $4
       RETURNING *`,
      [accessToken, expiresAt, userId, provider],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Update the encrypted access-token column for a row whose tokens are
   * stored encrypted (packed IV+tag+ciphertext format). Leaves the refresh
   * token alone — Google rotates access tokens on refresh but not refresh
   * tokens. Critical: also clears `access_token` plaintext so a subsequent
   * read can't fall back to the old/stale plaintext.
   *
   * Without this method, refreshIfExpired wrote the new token to
   * `access_token` (plaintext) while `encrypted_access_token` continued to
   * hold the previous value — and getToken would then decrypt the old one.
   */
  async updateEncryptedAccessToken(
    id: string,
    encryptedAccessToken: Buffer,
    expiresAt: Date,
    expectedCredentialRevision?: string,
  ): Promise<boolean> {
    const result = await query(
      `UPDATE oauth_tokens AS t
       SET encrypted_access_token = $1,
           access_token           = NULL,
           expires_at             = $2,
           credential_revision    = gen_random_uuid(),
           updated_at             = now()
       FROM connected_accounts AS ca
       WHERE t.id = $3 AND ca.id = t.connector_account_id
         AND ca.user_id = t.user_id AND ca.provider = t.provider
         AND ca.is_active = true AND ca.identity_verified = true
         AND ($4::UUID IS NULL OR t.credential_revision = $4)`,
      [encryptedAccessToken, expiresAt, id, expectedCredentialRevision ?? null],
    );
    return (result.rowCount ?? 0) > 0;
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
      `SELECT id, user_id, provider, account_email, account_provider_id, connector_account_id,
              access_token, refresh_token, expires_at, scopes, credential_revision, created_at, updated_at,
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
      expiresAt: Date;
    },
    expectedCredentialRevision?: string,
  ): Promise<boolean> {
    const result = await query(
      `UPDATE oauth_tokens
       SET encrypted_access_token  = $1,
           encrypted_refresh_token = $2,
           encryption_iv           = $3,
           encryption_tag          = $4,
           encryption_key_version  = $5,
           expires_at              = $6,
           access_token            = NULL,
           refresh_token           = NULL,
           credential_revision     = gen_random_uuid(),
           updated_at              = now()
       WHERE id = $7
         AND ($8::UUID IS NULL OR credential_revision = $8)`,
      [
        input.encryptedAccessToken,
        input.encryptedRefreshToken,
        input.iv,
        input.tag,
        input.keyVersion,
        input.expiresAt,
        id,
        expectedCredentialRevision ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
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
    const sql = `SELECT id, user_id, provider, account_email, account_provider_id, connector_account_id,
              access_token, refresh_token, expires_at, scopes, credential_revision, created_at, updated_at,
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
      // null means "this row had no refresh token to begin with — leave the
      // column alone". Required for access-only rows; previously the type
      // forced both Buffers and rotation skipped them, leaving them
      // encrypted under the OLD key after rotation (undecryptable).
      encryptedRefreshToken: Buffer | null;
      keyVersion: number;
    },
    client?: PoolClient,
  ): Promise<void> {
    // When refresh token is null we omit it from the UPDATE so the column
    // keeps its existing value (NULL stays NULL). Two SQL shapes is fewer
    // foot-guns than COALESCE on a Buffer column.
    const sql = input.encryptedRefreshToken === null
      ? `UPDATE oauth_tokens
         SET encrypted_access_token = $1,
             encryption_key_version = $2,
             credential_revision = gen_random_uuid(),
             updated_at             = now()
         WHERE id = $3`
      : `UPDATE oauth_tokens
         SET encrypted_access_token  = $1,
             encrypted_refresh_token = $2,
             encryption_key_version  = $3,
             credential_revision     = gen_random_uuid(),
             updated_at              = now()
         WHERE id = $4`;
    const params = input.encryptedRefreshToken === null
      ? [input.encryptedAccessToken, input.keyVersion, id]
      : [
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
