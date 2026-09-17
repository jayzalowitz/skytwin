import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../connection.js';
import type { OAuthTokenRow, OAuthTokenRowWithEncrypted } from '../types.js';
import {
  authorizeCredentialMutationWithClient,
  expireCredentialDispatchLeasesWithClient,
  hasActiveCredentialDispatchWithClient,
  type CredentialMutationLeaseProof,
} from './credential-dispatch-lease-repository.js';
import {
  connectedAccountRepository,
  canonicalizeScopes,
  digestProviderSubject,
} from './connected-account-repository.js';

export class CredentialDispatchConflictError extends Error {
  readonly code = 'credential_dispatch_pending';

  constructor(readonly retryAfter: Date | null) {
    super('A credential-backed request is active or ambiguous. Retry after it settles.');
    this.name = 'CredentialDispatchConflictError';
  }
}

export class CredentialDisconnectInProgressError extends Error {
  readonly code = 'credential_disconnect_pending';

  constructor() {
    super('This provider is being disconnected. Retry the connection after it settles.');
    this.name = 'CredentialDisconnectInProgressError';
  }
}

export class CredentialVaultLockedError extends Error {
  readonly code = 'credential_vault_locked';

  constructor() {
    super('Unlock the credential vault before storing a newly connected grant.');
    this.name = 'CredentialVaultLockedError';
  }
}

export class CredentialConnectionAuthorityError extends Error {
  readonly code = 'credential_connection_stale';

  constructor() {
    super('This OAuth authorization flow is stale. Start a new connection after disconnect completes.');
    this.name = 'CredentialConnectionAuthorityError';
  }
}

export class OAuthAccountBindingConflictError extends Error {
  readonly code = 'oauth_account_binding_conflict';

  constructor(message = 'The provider account is already bound to a different credential.') {
    super(message);
    this.name = 'OAuthAccountBindingConflictError';
  }
}

export type BeginCredentialDisconnectResult =
  | { status: 'not_found' }
  | { status: 'pending'; retryAfter: Date | null }
  | { status: 'ready'; accounts: OAuthTokenRowWithEncrypted[] };

const OAUTH_AUTHORITY_SECRET = process.env['SESSION_SECRET'] ?? 'skytwin-dev-secret';

async function lockOwner(client: PoolClient, userId: string): Promise<boolean> {
  const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  return !!owner.rows[0];
}

async function assertTokenIdle(
  client: PoolClient,
  row: OAuthTokenRow,
  dispatchProof?: CredentialMutationLeaseProof,
): Promise<void> {
  if (dispatchProof) {
    const own = await authorizeCredentialMutationWithClient(client, {
      ...dispatchProof,
      oauthTokenId: row.id,
    });
    if (own.authorized) return;
    throw new CredentialDispatchConflictError(own.retryAfter);
  }
  await expireCredentialDispatchLeasesWithClient(client, row.id);
  const active = await hasActiveCredentialDispatchWithClient(client, {
    oauthTokenId: row.id,
    userId: row.user_id,
    provider: row.provider,
    accountEmail: row.account_email,
  });
  if (active.active) throw new CredentialDispatchConflictError(active.retryAfter);
}

async function bumpConnectionAuthority(
  client: PoolClient,
  userId: string,
  provider: string,
): Promise<void> {
  await client.query(
    `INSERT INTO oauth_connection_authority (user_id, provider, generation)
     VALUES ($1, $2, gen_random_uuid())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       generation = gen_random_uuid(), updated_at = now()`,
    [userId, provider],
  );
}

function normalizeAccountEmail(accountEmail: string): string {
  return accountEmail.trim().toLowerCase();
}

function opaqueAuthorityKey(kind: 'account' | 'owner', value: string): string {
  return createHmac('sha256', OAUTH_AUTHORITY_SECRET)
    .update(`${kind}\0${value}`, 'utf8')
    .digest('hex');
}

function accountAuthorityKey(provider: string, accountEmail: string): string {
  return opaqueAuthorityKey('account', `${provider}\0${normalizeAccountEmail(accountEmail)}`);
}

function ownerAuthorityKey(userId: string): string {
  return opaqueAuthorityKey('owner', userId);
}

async function invalidateAccountConnectionAuthority(
  client: PoolClient,
  provider: string,
  accountEmail: string,
): Promise<void> {
  await client.query(
    `INSERT INTO oauth_account_connection_authority
       (provider, account_key, generation, invalidated_at)
     VALUES ($1, $2, gen_random_uuid(), now())
     ON CONFLICT (provider, account_key) DO UPDATE SET
       generation = gen_random_uuid(), invalidated_at = now(),
       expires_at = now() + INTERVAL '15 minutes', updated_at = now()`,
    [provider, accountAuthorityKey(provider, accountEmail)],
  );
}

/** Invalidate only account identities owned by a user being deleted. */
export async function invalidateOAuthAccountsForUserWithClient(
  client: PoolClient,
  userId: string,
  userEmail: string,
): Promise<{
  accounts: Array<{ provider: string; accountEmail: string }>;
  pendingAuthorizationsDeleted: number;
}> {
  const result = await client.query<{ provider: string; account_email: string }>(
    `SELECT DISTINCT provider, lower(trim(account_email)) AS account_email
       FROM oauth_tokens
      WHERE user_id = $1
      ORDER BY provider, account_email`,
    [userId],
  );
  const pendingCleanup = await client.query(
    'DELETE FROM oauth_new_user_authorizations WHERE claimed_owner_key = $1',
    [ownerAuthorityKey(userId)],
  );
  const accounts = new Map<string, { provider: string; accountEmail: string }>();
  for (const row of result.rows) {
    const email = normalizeAccountEmail(row.account_email);
    if (row.provider && email) accounts.set(`${row.provider}\0${email}`, {
      provider: row.provider, accountEmail: email,
    });
  }
  // Google is currently the sole account-unknown signup route. Fence the
  // owner's login email even if no OAuth token was ever persisted.
  const ownerEmail = normalizeAccountEmail(userEmail);
  if (ownerEmail) accounts.set(`google\0${ownerEmail}`, {
    provider: 'google', accountEmail: ownerEmail,
  });
  const ordered = [...accounts.values()].sort((left, right) =>
    `${left.provider}\0${left.accountEmail}`.localeCompare(`${right.provider}\0${right.accountEmail}`));
  for (const account of ordered) {
    await invalidateAccountConnectionAuthority(client, account.provider, account.accountEmail);
  }
  return {
    accounts: ordered,
    pendingAuthorizationsDeleted: pendingCleanup.rowCount ?? 0,
  };
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
  /** Issue a one-shot DB-timestamped authority for an account-unknown flow. */
  async issueNewUserAuthorization(provider: string, expiresAt: Date): Promise<string> {
    return withTransaction(async (client) => {
      await client.query(
        'DELETE FROM oauth_new_user_authorizations WHERE expires_at < now()',
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO oauth_new_user_authorizations (provider, expires_at)
         VALUES ($1, $2) RETURNING id`,
        [provider, expiresAt],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('OAuth new-user authorization could not be issued.');
      return id;
    });
  },

  /**
   * Resolve verified identity and materialize/lock the owner in the same
   * transaction that checks the DB-issued flow against its account tombstone.
   */
  async claimNewUserAuthorization(input: {
    authorizationId: string;
    provider: string;
    accountEmail: string;
    userName: string;
    trustTier: string;
  }): Promise<{ userId: string; claimGeneration: string }> {
    return withTransaction(async (client) => {
      const pending = await client.query<{ issued_at: Date; claim_generation: string | null }>(
        `SELECT issued_at, claim_generation
           FROM oauth_new_user_authorizations
          WHERE id = $1 AND provider = $2 AND expires_at > now() FOR UPDATE`,
        [input.authorizationId, input.provider],
      );
      const flow = pending.rows[0];
      if (!flow || flow.claim_generation) {
        throw new CredentialConnectionAuthorityError();
      }
      const accountEmail = normalizeAccountEmail(input.accountEmail);
      const accountKey = accountAuthorityKey(input.provider, accountEmail);
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 FOR UPDATE',
        [accountEmail],
      );
      let userId = existing.rows[0]?.id;
      if (!userId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (email, name, trust_tier, autonomy_settings)
           VALUES ($1, $2, $3, '{}'::JSONB) RETURNING id`,
          [accountEmail, input.userName, input.trustTier],
        );
        userId = created.rows[0]?.id;
      }
      if (!userId) throw new Error('OAuth credential owner could not be resolved.');
      await client.query(
        `INSERT INTO oauth_account_connection_authority (provider, account_key)
         VALUES ($1, $2) ON CONFLICT (provider, account_key) DO NOTHING`,
        [input.provider, accountKey],
      );
      await client.query(
        `SELECT generation FROM oauth_account_connection_authority
          WHERE provider = $1 AND account_key = $2 FOR UPDATE`,
        [input.provider, accountKey],
      );
      const insertedOwnerAuthority = await client.query<{ generation: string }>(
        `INSERT INTO oauth_connection_authority (user_id, provider)
         VALUES ($1, $2) ON CONFLICT (user_id, provider) DO NOTHING
         RETURNING generation`,
        [userId, input.provider],
      );
      const ownerGeneration = insertedOwnerAuthority.rows[0]?.generation ??
        (await client.query<{ generation: string }>(
          `SELECT generation FROM oauth_connection_authority
            WHERE user_id = $1 AND provider = $2 AND updated_at < $3
            FOR UPDATE`,
          [userId, input.provider, flow.issued_at],
        )).rows[0]?.generation;
      if (!ownerGeneration) throw new CredentialConnectionAuthorityError();
      const claimed = await client.query<{ claim_generation: string }>(
        `UPDATE oauth_new_user_authorizations
            SET claimed_owner_key = $2, claimed_account_key = $3,
                claimed_owner_generation = $5, claim_generation = gen_random_uuid()
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM oauth_account_connection_authority authority
               WHERE authority.provider = $4
                 AND authority.account_key = $3
                 AND authority.invalidated_at IS NOT NULL
                 AND authority.invalidated_at >= oauth_new_user_authorizations.issued_at
            )
          RETURNING claim_generation`,
        [input.authorizationId, ownerAuthorityKey(userId), accountKey,
          input.provider, ownerGeneration],
      );
      const claimGeneration = claimed.rows[0]?.claim_generation;
      if (!claimGeneration) throw new CredentialConnectionAuthorityError();
      return { userId, claimGeneration };
    });
  },

  /** Bind an authorization redirect to the current provider connection epoch. */
  async getOrCreateConnectionAuthority(userId: string, provider: string): Promise<string> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, userId)) {
        throw new Error('OAuth credential owner is unavailable.');
      }
      await client.query(
        `INSERT INTO oauth_connection_authority (user_id, provider)
         VALUES ($1, $2) ON CONFLICT (user_id, provider) DO NOTHING`,
        [userId, provider],
      );
      const result = await client.query<{ generation: string }>(
        `SELECT generation FROM oauth_connection_authority
          WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
        [userId, provider],
      );
      const generation = result.rows[0]?.generation;
      if (!generation) throw new Error('OAuth connection authority is unavailable.');
      return generation;
    });
  },

  /** First matching row for (userId, provider). For multi-account-aware callers, use getTokenByAccount. */
  async getToken(userId: string, provider: string): Promise<OAuthTokenRowWithEncrypted | null> {
    const result = await query<OAuthTokenRowWithEncrypted>(
      `SELECT * FROM oauth_tokens
        WHERE user_id = $1 AND provider = $2 AND dispatch_state = 'active'
        ORDER BY updated_at DESC LIMIT 1`,
      [userId, provider],
    );
    return result.rows[0] ?? null;
  },

  async getTokenByAccount(
    userId: string,
    provider: string,
    accountEmail: string,
  ): Promise<OAuthTokenRowWithEncrypted | null> {
    const result = await query<OAuthTokenRowWithEncrypted>(
      `SELECT * FROM oauth_tokens
        WHERE user_id = $1 AND provider = $2 AND account_email = $3
          AND dispatch_state = 'active'`,
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
  async listAllConnections(): Promise<OAuthTokenRowWithEncrypted[]> {
    const result = await query<OAuthTokenRowWithEncrypted>(
      `SELECT t.* FROM oauth_tokens AS t
       JOIN connected_accounts AS ca
         ON ca.id = t.connector_account_id
        AND ca.user_id = t.user_id
        AND ca.provider = t.provider
      WHERE ca.is_active = true AND ca.identity_verified = true
        AND (t.refresh_token IS NOT NULL OR t.encrypted_refresh_token IS NOT NULL)
        AND t.dispatch_state = 'active'
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
    expectedConnectionGeneration?: string;
    newUserAuthorization?: { id: string; claimGeneration: string };
    credentialStorage?:
      | { mode: 'plaintext' }
      | {
          mode: 'encrypted';
          encryptedAccessToken: Buffer;
          encryptedRefreshToken: Buffer;
          keyVersion: number;
          vaultGeneration: string;
        };
  }): Promise<OAuthTokenRow> {
    return withSerializableRetry(async (client) => {
      const provider = input.provider.trim().toLowerCase();
      const accountEmail = normalizeAccountEmail(input.accountEmail);
      const scopes = canonicalizeScopes(input.scopes);
      if (!await lockOwner(client, input.userId)) {
        throw new Error('OAuth credential owner is unavailable.');
      }
      if (input.expectedConnectionGeneration !== undefined) {
        const authority = await client.query<{ generation: string }>(
          `SELECT generation FROM oauth_connection_authority
            WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
          [input.userId, input.provider],
        );
        if (authority.rows[0]?.generation !== input.expectedConnectionGeneration) {
          throw new CredentialConnectionAuthorityError();
        }
      }
      if (input.newUserAuthorization) {
        const pending = await client.query<{ issued_at: Date; claimed_owner_generation: string }>(
          `SELECT issued_at, claimed_owner_generation FROM oauth_new_user_authorizations
            WHERE id = $1 AND provider = $2 AND claimed_owner_key = $3
              AND claimed_account_key = $4 AND claim_generation = $5
              AND expires_at > now()
            FOR UPDATE`,
          [input.newUserAuthorization.id, input.provider, ownerAuthorityKey(input.userId),
            accountAuthorityKey(input.provider, input.accountEmail),
            input.newUserAuthorization.claimGeneration],
        );
        if (!pending.rows[0]) throw new CredentialConnectionAuthorityError();
        const ownerAuthority = await client.query<{ generation: string }>(
          `SELECT generation FROM oauth_connection_authority
            WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
          [input.userId, input.provider],
        );
        if (ownerAuthority.rows[0]?.generation !== pending.rows[0].claimed_owner_generation) {
          throw new CredentialConnectionAuthorityError();
        }
        const authority = await client.query<{ generation: string }>(
          `SELECT generation FROM oauth_account_connection_authority
            WHERE provider = $1 AND account_key = $2
              AND (invalidated_at IS NULL OR invalidated_at < $3)
            FOR UPDATE`,
          [input.provider, accountAuthorityKey(input.provider, input.accountEmail),
            pending.rows[0].issued_at],
        );
        if (!authority.rows[0]) throw new CredentialConnectionAuthorityError();
      }
      // The user-row lock serializes callbacks with beginDisconnect. Once a
      // remote-revocation saga has committed its fence, neither a reconnect
      // of the same account nor a new provider account may appear behind it.
      // This also prevents an old remote revoke from invalidating a freshly
      // reconnected grant while the route is awaiting the provider.
      const disconnecting = await client.query<{ id: string }>(
        `SELECT id FROM oauth_tokens
          WHERE user_id = $1 AND provider = $2 AND dispatch_state = 'disconnecting'
          LIMIT 1 FOR UPDATE`,
        [input.userId, input.provider],
      );
      if (disconnecting.rows[0]) throw new CredentialDisconnectInProgressError();
      const vault = await client.query<{
        current_key_version: number;
        vault_state: 'locked' | 'unlocked';
        vault_generation: string;
      }>(
        `SELECT current_key_version, vault_state, vault_generation FROM user_credential_vault_meta
          WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      const currentKeyVersion = vault.rows[0]?.current_key_version;
      const currentVaultState = vault.rows[0]?.vault_state;
      const currentVaultGeneration = vault.rows[0]?.vault_generation;
      const storage = input.credentialStorage ?? { mode: 'plaintext' as const };
      if ((storage.mode === 'plaintext' && currentKeyVersion !== undefined) ||
          (storage.mode === 'encrypted' && (currentKeyVersion !== storage.keyVersion ||
            currentVaultState !== 'unlocked' ||
            currentVaultGeneration !== storage.vaultGeneration))) {
        throw new CredentialVaultLockedError();
      }
      const emailMatches = await client.query<OAuthTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE user_id = $1 AND provider = $2 AND lower(account_email) = lower($3)
          ORDER BY updated_at DESC, id DESC
          FOR UPDATE`,
        [input.userId, provider, accountEmail],
      );
      if (emailMatches.rows.length > 1) {
        throw new OAuthAccountBindingConflictError(
          'Multiple credentials match this display email; operator reconciliation is required.',
        );
      }
      const providerSubjectDigest = input.accountProviderId?.trim()
        ? digestProviderSubject(provider, input.accountProviderId)
        : null;
      const subjectMatches = providerSubjectDigest
        ? await client.query<OAuthTokenRow>(
            `SELECT t.* FROM oauth_tokens AS t
              JOIN connected_accounts AS ca
                ON ca.id = t.connector_account_id
               AND ca.user_id = t.user_id
               AND ca.provider = t.provider
             WHERE t.user_id = $1 AND t.provider = $2
               AND ca.provider_subject_digest = $3
             ORDER BY t.updated_at DESC, t.id DESC
             FOR UPDATE`,
            [input.userId, provider, providerSubjectDigest],
          )
        : { rows: [] as OAuthTokenRow[] };
      if (subjectMatches.rows.length > 1) {
        throw new OAuthAccountBindingConflictError(
          'Multiple credentials match this verified provider subject; operator reconciliation is required.',
        );
      }
      const emailMatch = emailMatches.rows[0];
      const subjectMatch = subjectMatches.rows[0];
      if (emailMatch && subjectMatch && emailMatch.id !== subjectMatch.id) {
        throw new OAuthAccountBindingConflictError(
          'Display email and verified provider subject resolve to different credentials.',
        );
      }
      // Provider subject is the durable identity. Display email/UPN is mutable,
      // so a re-consent after an alias change must update the same credential
      // instead of attempting to insert a second row for the same account.
      const existing = subjectMatch ?? emailMatch;
      const activeDispatch = await hasActiveCredentialDispatchWithClient(
        client,
        { userId: input.userId, provider },
      );
      if (activeDispatch.active) {
        throw new CredentialDispatchConflictError(activeDispatch.retryAfter);
      }
      if (existing) await assertTokenIdle(client, existing);

      const priorAccount = existing?.connector_account_id
        ? await connectedAccountRepository.findOwnedActive(
            input.userId,
            existing.connector_account_id,
            provider,
            client,
          )
        : null;
      if (input.accountProviderId?.trim() && priorAccount?.identity_verified) {
        const expectedDigest = digestProviderSubject(provider, input.accountProviderId);
        if (priorAccount.provider_subject_digest !== expectedDigest) {
          throw new OAuthAccountBindingConflictError(
            'Display email is already bound to a different verified provider subject.',
          );
        }
      }
      const account = input.accountProviderId?.trim()
        ? await connectedAccountRepository.upsertVerified({
            userId: input.userId,
            provider,
            providerSubject: input.accountProviderId,
            accountDisplay: accountEmail,
            scopes,
          }, client)
        : priorAccount ?? await connectedAccountRepository.createUnverified({
            userId: input.userId,
            provider,
            accountDisplay: accountEmail,
            scopes,
          }, client);
      if (priorAccount && priorAccount.id !== account.id) {
        await client.query(
          `UPDATE connector_cursors SET connector_account_id = $1, updated_at = now()
            WHERE connector_account_id = $2 AND user_id = $3`,
          [account.id, priorAccount.id, input.userId],
        );
        await client.query(
          `DELETE FROM connector_health
            WHERE user_id = $1 AND connector_name IN (
              'gmail:' || $2, 'google-calendar:' || $2,
              'outlook_mail:' || $2, 'outlook_calendar:' || $2
            )`,
          [input.userId, priorAccount.id],
        );
        await client.query(
          `UPDATE connected_accounts
              SET is_active = false, disconnected_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND provider = $3`,
          [priorAccount.id, input.userId, provider],
        );
      }
      if (subjectMatch && subjectMatch.account_email !== accountEmail) {
        await client.query(
          `UPDATE oauth_tokens
              SET account_email = $1, updated_at = now()
            WHERE id = $2 AND user_id = $3 AND provider = $4`,
          [accountEmail, subjectMatch.id, input.userId, provider],
        );
      }

      const result = await client.query<OAuthTokenRow>(
        `INSERT INTO oauth_tokens (
           user_id, provider, account_email, account_provider_id,
           access_token, refresh_token, expires_at, scopes,
           encrypted_access_token, encrypted_refresh_token,
           encryption_iv, encryption_tag, encryption_key_version,
           credential_revision, dispatch_generation, dispatch_state,
           connector_account_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, gen_random_uuid(), gen_random_uuid(), 'active', $14)
         ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
           account_provider_id = COALESCE(EXCLUDED.account_provider_id, oauth_tokens.account_provider_id),
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           encryption_iv = EXCLUDED.encryption_iv,
           encryption_tag = EXCLUDED.encryption_tag,
           encryption_key_version = EXCLUDED.encryption_key_version,
           expires_at = EXCLUDED.expires_at,
           scopes = EXCLUDED.scopes,
           credential_revision = gen_random_uuid(),
           dispatch_generation = gen_random_uuid(),
           dispatch_state = 'active',
           connector_account_id = EXCLUDED.connector_account_id,
           updated_at = now()
         RETURNING *`,
        [input.userId, provider, accountEmail,
          input.accountProviderId ?? null,
          storage.mode === 'plaintext' ? input.accessToken : null,
          storage.mode === 'plaintext' ? input.refreshToken : null,
          input.expiresAt, scopes,
          storage.mode === 'encrypted' ? storage.encryptedAccessToken : null,
          storage.mode === 'encrypted' ? storage.encryptedRefreshToken : null,
          storage.mode === 'encrypted' ? Buffer.alloc(0) : null,
          storage.mode === 'encrypted' ? Buffer.alloc(0) : null,
          storage.mode === 'encrypted' ? storage.keyVersion : 1,
          account.id],
      );
      if (!result.rows[0]) throw new Error('OAuth credential could not be saved.');
      if (input.newUserAuthorization) {
        const consumed = await client.query(
          `DELETE FROM oauth_new_user_authorizations
            WHERE id = $1 AND claim_generation = $2`,
          [input.newUserAuthorization.id, input.newUserAuthorization.claimGeneration],
        );
        if ((consumed.rowCount ?? 0) !== 1) throw new CredentialConnectionAuthorityError();
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

  /** Fence new leases before a remote provider revoke. */
  async beginDisconnect(
    userId: string,
    provider: string,
    accountEmail?: string,
  ): Promise<BeginCredentialDisconnectResult> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, userId)) return { status: 'not_found' };
      // Advance the owner-scoped epoch even if no token row is visible yet: a
      // known-owner callback may be paused before persistence.
      await bumpConnectionAuthority(client, userId, provider);
      const rows = await client.query<OAuthTokenRowWithEncrypted>(
        `SELECT * FROM oauth_tokens
          WHERE user_id = $1 AND provider = $2
            AND ($3::STRING IS NULL OR account_email = $3)
          ORDER BY updated_at DESC FOR UPDATE`,
        [userId, provider, accountEmail ?? null],
      );
      if (rows.rows.length === 0) return { status: 'not_found' };
      for (const account of new Set(rows.rows.map((row) =>
        normalizeAccountEmail(row.account_email)))) {
        await invalidateAccountConnectionAuthority(client, provider, account);
      }
      for (const row of rows.rows) {
        await expireCredentialDispatchLeasesWithClient(client, row.id);
      }
      await client.query(
        `UPDATE oauth_tokens
            SET dispatch_state = 'disconnecting', dispatch_generation = gen_random_uuid(),
                updated_at = now()
          WHERE user_id = $1 AND provider = $2
            AND ($3::STRING IS NULL OR account_email = $3)
            AND dispatch_state = 'active'`,
        [userId, provider, accountEmail ?? null],
      );
      const active = await hasActiveCredentialDispatchWithClient(client, {
        userId,
        provider,
        accountEmail,
      });
      if (active.active) return { status: 'pending', retryAfter: active.retryAfter };
      const fenced = await client.query<OAuthTokenRowWithEncrypted>(
        `SELECT * FROM oauth_tokens
          WHERE user_id = $1 AND provider = $2
            AND ($3::STRING IS NULL OR account_email = $3)
            AND dispatch_state = 'disconnecting'
          ORDER BY updated_at DESC`,
        [userId, provider, accountEmail ?? null],
      );
      return { status: 'ready', accounts: fenced.rows };
    });
  },

  /** Complete only the rows that remain fenced; reconnect wins safely. */
  async completeDisconnect(
    userId: string,
    provider: string,
    expectedAccounts: ReadonlyArray<Pick<OAuthTokenRow,
      'id' | 'credential_revision' | 'dispatch_generation'>>,
  ): Promise<number> {
    if (expectedAccounts.length === 0) return 0;
    return withTransaction(async (client) => {
      if (!await lockOwner(client, userId)) return 0;
      const rows = await client.query<OAuthTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE user_id = $1 AND provider = $2
            AND id = ANY($3::UUID[])
          FOR UPDATE`,
        [userId, provider, expectedAccounts.map((row) => row.id)],
      );
      if (rows.rows.length !== expectedAccounts.length || expectedAccounts.some((expected) => {
        const current = rows.rows.find((row) => row.id === expected.id);
        return !current || current.dispatch_state !== 'disconnecting' ||
          current.credential_revision !== expected.credential_revision ||
          current.dispatch_generation !== expected.dispatch_generation;
      })) return 0;
      for (const row of rows.rows) await assertTokenIdle(client, row);
      for (const row of rows.rows) {
        await client.query(
          `DELETE FROM connector_health
            WHERE user_id = $1 AND connector_name IN (
              'gmail:' || $2, 'google-calendar:' || $2,
              'outlook_mail:' || $2, 'outlook_calendar:' || $2
            )`,
          [userId, row.connector_account_id],
        );
        await connectedAccountRepository.deactivateForTokenAccount(
          userId,
          provider,
          row.account_email,
          client,
        );
      }
      const result = await client.query(
        `DELETE FROM oauth_tokens
          WHERE user_id = $1 AND provider = $2
            AND id = ANY($3::UUID[]) AND dispatch_state = 'disconnecting'`,
        [userId, provider, expectedAccounts.map((row) => row.id)],
      );
      return result.rowCount ?? 0;
    });
  },

  /** Delete every account for (userId, provider). */
  async deleteAllForProvider(userId: string, provider: string): Promise<number> {
    const begun = await this.beginDisconnect(userId, provider);
    if (begun.status === 'pending') throw new CredentialDispatchConflictError(begun.retryAfter);
    if (begun.status === 'not_found') return 0;
    return this.completeDisconnect(userId, provider, begun.accounts);
  },

  /** Delete a single account row. */
  async deleteAccount(
    userId: string,
    provider: string,
    accountEmail: string,
  ): Promise<boolean> {
    const begun = await this.beginDisconnect(userId, provider, accountEmail);
    if (begun.status === 'pending') throw new CredentialDispatchConflictError(begun.retryAfter);
    if (begun.status === 'not_found') return false;
    return (await this.completeDisconnect(userId, provider, begun.accounts)) > 0;
  },

  async deleteById(userId: string, id: string): Promise<boolean> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, userId)) return false;
      const locked = await client.query<OAuthTokenRow>(
        'SELECT * FROM oauth_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, userId],
      );
      const row = locked.rows[0];
      if (!row) return false;
      await assertTokenIdle(client, row);
      await bumpConnectionAuthority(client, userId, row.provider);
      await invalidateAccountConnectionAuthority(client, row.provider, row.account_email);
      await connectedAccountRepository.deactivateForTokenAccount(
        userId,
        row.provider,
        row.account_email,
        client,
      );
      const removed = await client.query(
        'DELETE FROM oauth_tokens WHERE id = $1 AND user_id = $2',
        [id, userId],
      );
      return (removed.rowCount ?? 0) > 0;
    });
  },

  /**
   * Invalidate every materialized credential revision before an in-memory
   * vault key is evicted. Owner-first locking serializes this fence with lease
   * acquisition, so either a request has already started or its stale
   * materialized token can no longer acquire authority after lock.
   */
  async fenceVaultLock(userId: string): Promise<number> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, userId)) return 0;
      await client.query(
        `UPDATE user_credential_vault_meta
            SET vault_state = 'locked', vault_generation = gen_random_uuid()
          WHERE user_id = $1`,
        [userId],
      );
      const fenced = await client.query(
        `UPDATE oauth_tokens
            SET credential_revision = gen_random_uuid(),
                dispatch_generation = gen_random_uuid(), updated_at = now()
          WHERE user_id = $1 AND dispatch_state = 'active'`,
        [userId],
      );
      return fenced.rowCount ?? 0;
    });
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
           credential_revision = gen_random_uuid(),
           dispatch_generation = gen_random_uuid(), updated_at = now()
       WHERE user_id = $3 AND provider = $4 AND account_email = $5
         AND dispatch_state = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM credential_dispatch_leases l
            WHERE (l.oauth_token_id = oauth_tokens.id OR
                   (l.oauth_token_id IS NULL AND l.user_id = oauth_tokens.user_id
                    AND l.provider = oauth_tokens.provider))
              AND l.state IN ('request_started', 'ambiguous')
         )
       RETURNING *`,
      [accessToken, expiresAt, userId, provider, accountEmail],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Persist a refresh only while the exact row that authorized the remote
   * refresh is still current. A disconnect deletes the row and a reconnect or
   * rotation changes the access/refresh grant, so neither can be
   * resurrected or overwritten by a late refresh response.
   */
  async rotateTokenIfCurrent(input: {
    id: string;
    userId: string;
    provider: string;
    expectedAccessToken: string | null;
    expectedRefreshToken: string;
    expectedCredentialRevision: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scopes: string[];
    dispatchProof?: CredentialMutationLeaseProof;
  }): Promise<OAuthTokenRow | null> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, input.userId)) return null;
      const locked = await client.query<OAuthTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE id = $1 AND user_id = $2 AND provider = $3 FOR UPDATE`,
        [input.id, input.userId, input.provider],
      );
      const row = locked.rows[0];
      if (!row || row.dispatch_state !== 'active' ||
          row.credential_revision !== input.expectedCredentialRevision) return null;
      try {
        await assertTokenIdle(client, row, input.dispatchProof);
      } catch (error) {
        if (error instanceof CredentialDispatchConflictError) return null;
        throw error;
      }
      const result = await client.query<OAuthTokenRow>(
        `UPDATE oauth_tokens
         SET access_token = $1, refresh_token = $2, expires_at = $3, scopes = $4,
             credential_revision = gen_random_uuid(),
             dispatch_generation = gen_random_uuid(), updated_at = now()
         WHERE id = $5 AND user_id = $6 AND provider = $7
           AND access_token IS NOT DISTINCT FROM $8 AND refresh_token = $9
           AND credential_revision = $10 AND dispatch_state = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM user_credential_vault_meta v
              WHERE v.user_id = oauth_tokens.user_id
           )
         RETURNING *`,
        [input.accessToken, input.refreshToken, input.expiresAt, input.scopes,
          input.id, input.userId, input.provider, input.expectedAccessToken,
          input.expectedRefreshToken, input.expectedCredentialRevision],
      );
      return result.rows[0] ?? null;
    });
  },

  /** Commit a provider refresh only against the exact credential revision that initiated it. */
  async updateAccessTokenIfCurrent(input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    accessToken: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const result = await query(
      `UPDATE oauth_tokens
          SET access_token = $1, expires_at = $2,
              credential_revision = gen_random_uuid(),
              dispatch_generation = gen_random_uuid(), updated_at = now()
        WHERE id = $3 AND user_id = $4 AND provider = $5
          AND credential_revision = $6 AND dispatch_state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM user_credential_vault_meta v
             WHERE v.user_id = oauth_tokens.user_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM credential_dispatch_leases l
             WHERE (l.oauth_token_id = oauth_tokens.id OR
                    (l.oauth_token_id IS NULL AND l.user_id = oauth_tokens.user_id
                     AND l.provider = oauth_tokens.provider))
               AND l.state IN ('request_started', 'ambiguous')
          )`,
      [input.accessToken, input.expiresAt, input.id, input.userId,
        input.provider, input.expectedCredentialRevision],
    );
    return (result.rowCount ?? 0) === 1;
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
           credential_revision = gen_random_uuid(),
           dispatch_generation = gen_random_uuid(), updated_at = now()
       FROM connected_accounts AS ca
       WHERE t.user_id = $3 AND t.provider = $4 AND t.connector_account_id = $5
         AND ca.id = t.connector_account_id AND ca.user_id = t.user_id
         AND ca.provider = t.provider AND ca.is_active = true
         AND ca.identity_verified = true AND t.credential_revision = $6
         AND t.dispatch_state = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM user_credential_vault_meta v
            WHERE v.user_id = t.user_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM credential_dispatch_leases l
            WHERE (l.oauth_token_id = t.id OR
                   (l.oauth_token_id IS NULL AND l.user_id = t.user_id
                    AND l.provider = t.provider))
              AND l.state IN ('request_started', 'ambiguous')
         )
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
           credential_revision = gen_random_uuid(),
           dispatch_generation = gen_random_uuid(), updated_at = now()
       WHERE user_id = $3 AND provider = $4
         AND dispatch_state = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM credential_dispatch_leases l
            WHERE (l.oauth_token_id = oauth_tokens.id OR
                   (l.oauth_token_id IS NULL AND l.user_id = oauth_tokens.user_id
                    AND l.provider = oauth_tokens.provider))
              AND l.state IN ('request_started', 'ambiguous')
         )
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
  /** Encrypted equivalent of updateAccessTokenIfCurrent. */
  async updateEncryptedAccessTokenIfCurrent(input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    expectedVaultGeneration: string;
    encryptedAccessToken: Buffer;
    expiresAt: Date;
  }): Promise<boolean> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, input.userId)) return false;
      const vault = await client.query(
        `SELECT 1 FROM user_credential_vault_meta
          WHERE user_id = $1 AND vault_state = 'unlocked' AND vault_generation = $2
          FOR UPDATE`,
        [input.userId, input.expectedVaultGeneration],
      );
      if (!vault.rows[0]) return false;
      const result = await client.query(
      `UPDATE oauth_tokens
          SET encrypted_access_token = $1, access_token = NULL, expires_at = $2,
              credential_revision = gen_random_uuid(),
              dispatch_generation = gen_random_uuid(), updated_at = now()
        WHERE id = $3 AND user_id = $4 AND provider = $5
          AND credential_revision = $6 AND dispatch_state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM credential_dispatch_leases l
             WHERE (l.oauth_token_id = oauth_tokens.id OR
                    (l.oauth_token_id IS NULL AND l.user_id = oauth_tokens.user_id
                     AND l.provider = oauth_tokens.provider))
               AND l.state IN ('request_started', 'ambiguous')
          )`,
      [input.encryptedAccessToken, input.expiresAt, input.id, input.userId,
        input.provider, input.expectedCredentialRevision],
    );
      return (result.rowCount ?? 0) === 1;
    });
  },

  /** Exact-revision refresh for a vault-encrypted OAuth grant. */
  async rotateEncryptedTokenIfCurrent(input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    expectedVaultGeneration: string;
    encryptedAccessToken: Buffer;
    encryptedRefreshToken?: Buffer;
    expiresAt: Date;
    dispatchProof?: CredentialMutationLeaseProof;
  }): Promise<OAuthTokenRowWithEncrypted | null> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, input.userId)) return null;
      const vault = await client.query(
        `SELECT 1 FROM user_credential_vault_meta
          WHERE user_id = $1 AND vault_state = 'unlocked' AND vault_generation = $2
          FOR UPDATE`,
        [input.userId, input.expectedVaultGeneration],
      );
      if (!vault.rows[0]) return null;
      const locked = await client.query<OAuthTokenRowWithEncrypted>(
        `SELECT * FROM oauth_tokens
          WHERE id = $1 AND user_id = $2 AND provider = $3 FOR UPDATE`,
        [input.id, input.userId, input.provider],
      );
      const row = locked.rows[0];
      if (!row || row.dispatch_state !== 'active' ||
          row.credential_revision !== input.expectedCredentialRevision ||
          !row.encrypted_access_token) return null;
      try {
        await assertTokenIdle(client, row, input.dispatchProof);
      } catch (error) {
        if (error instanceof CredentialDispatchConflictError) return null;
        throw error;
      }
      const result = await client.query<OAuthTokenRowWithEncrypted>(
        `UPDATE oauth_tokens
            SET encrypted_access_token = $1,
                encrypted_refresh_token = COALESCE($2, encrypted_refresh_token),
                access_token = NULL, refresh_token = NULL, expires_at = $3,
                credential_revision = gen_random_uuid(),
                dispatch_generation = gen_random_uuid(), updated_at = now()
          WHERE id = $4 AND user_id = $5 AND provider = $6
            AND credential_revision = $7 AND dispatch_state = 'active'
          RETURNING *`,
        [input.encryptedAccessToken, input.encryptedRefreshToken ?? null, input.expiresAt,
          input.id, input.userId, input.provider, input.expectedCredentialRevision],
      );
      return result.rows[0] ?? null;
    });
  },

  async getUsersWithActiveTokens(): Promise<OAuthTokenRowWithEncrypted[]> {
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
              encryption_iv, encryption_tag, encryption_key_version,
              credential_revision, dispatch_generation, dispatch_state
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
  /** Lazy-migrate only the exact plaintext revision that was decrypted/read. */
  async updateEncryptedIfCurrent(input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    expectedVaultGeneration: string;
    encryptedAccessToken: Buffer;
    encryptedRefreshToken: Buffer;
    iv: Buffer;
    tag: Buffer;
    keyVersion: number;
    dispatchProof?: CredentialMutationLeaseProof;
  }): Promise<boolean> {
    return withTransaction(async (client) => {
      if (!await lockOwner(client, input.userId)) return false;
      const vault = await client.query(
        `SELECT 1 FROM user_credential_vault_meta
          WHERE user_id = $1 AND vault_state = 'unlocked'
            AND vault_generation = $2 AND current_key_version = $3
          FOR UPDATE`,
        [input.userId, input.expectedVaultGeneration, input.keyVersion],
      );
      if (!vault.rows[0]) return false;
      const locked = await client.query<OAuthTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE id = $1 AND user_id = $2 AND provider = $3
            AND credential_revision = $4 AND dispatch_state = 'active'
          FOR UPDATE`,
        [input.id, input.userId, input.provider, input.expectedCredentialRevision],
      );
      const row = locked.rows[0];
      if (!row) return false;
      try {
        await assertTokenIdle(client, row, input.dispatchProof);
      } catch (error) {
        if (error instanceof CredentialDispatchConflictError) return false;
        throw error;
      }
      const result = await client.query(
      `UPDATE oauth_tokens
          SET encrypted_access_token = $1, encrypted_refresh_token = $2,
              encryption_iv = $3, encryption_tag = $4, encryption_key_version = $5,
              credential_revision = gen_random_uuid(), dispatch_generation = gen_random_uuid(),
              access_token = NULL, refresh_token = NULL, updated_at = now()
        WHERE id = $6 AND user_id = $7 AND provider = $8
          AND credential_revision = $9 AND dispatch_state = 'active'`,
      [input.encryptedAccessToken, input.encryptedRefreshToken, input.iv, input.tag,
        input.keyVersion, input.id, input.userId, input.provider,
        input.expectedCredentialRevision],
    );
      return (result.rowCount ?? 0) === 1;
    });
  },

  async validateVaultSession(userId: string, vaultGeneration: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM user_credential_vault_meta
        WHERE user_id = $1 AND vault_state = 'unlocked' AND vault_generation = $2`,
      [userId, vaultGeneration],
    );
    return Boolean(result.rows[0]);
  },

  async getVaultAuthorityState(userId: string): Promise<{
    state: 'absent' | 'locked' | 'unlocked';
    generation: string | null;
    keyVersion: number | null;
  }> {
    const result = await query<{
      vault_state: 'locked' | 'unlocked';
      vault_generation: string;
      current_key_version: number;
    }>(
      `SELECT vault_state, vault_generation, current_key_version
         FROM user_credential_vault_meta WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          state: row.vault_state,
          generation: row.vault_generation,
          keyVersion: row.current_key_version,
        }
      : { state: 'absent', generation: null, keyVersion: null };
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
              encryption_iv, encryption_tag, encryption_key_version,
              credential_revision, dispatch_generation, dispatch_state
       FROM oauth_tokens
       WHERE user_id = $1
         AND encrypted_access_token IS NOT NULL${client ? ' FOR UPDATE' : ''}`;
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
  ): Promise<boolean> {
    // When refresh token is null we omit it from the UPDATE so the column
    // keeps its existing value (NULL stays NULL). Two SQL shapes is fewer
    // foot-guns than COALESCE on a Buffer column.
    const sql = input.encryptedRefreshToken === null
      ? `UPDATE oauth_tokens
         SET encrypted_access_token = $1,
             encryption_key_version = $2,
             credential_revision = gen_random_uuid(),
             dispatch_generation = gen_random_uuid(),
             updated_at             = now()
         WHERE id = $3 AND dispatch_state = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM credential_dispatch_leases l
              WHERE (l.oauth_token_id = oauth_tokens.id OR
                     (l.oauth_token_id IS NULL AND l.user_id = oauth_tokens.user_id
                      AND l.provider = oauth_tokens.provider))
                AND l.state IN ('request_started', 'ambiguous')
           )`
      : `UPDATE oauth_tokens
         SET encrypted_access_token  = $1,
             encrypted_refresh_token = $2,
             encryption_key_version  = $3,
             credential_revision = gen_random_uuid(),
             dispatch_generation = gen_random_uuid(),
             updated_at              = now()
         WHERE id = $4 AND dispatch_state = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM credential_dispatch_leases l
              WHERE (l.oauth_token_id = oauth_tokens.id OR
                     (l.oauth_token_id IS NULL AND l.user_id = oauth_tokens.user_id
                      AND l.provider = oauth_tokens.provider))
                AND l.state IN ('request_started', 'ambiguous')
           )`;
    const params = input.encryptedRefreshToken === null
      ? [input.encryptedAccessToken, input.keyVersion, id]
      : [
          input.encryptedAccessToken,
          input.encryptedRefreshToken,
          input.keyVersion,
          id,
        ];

    const result = client ? await client.query(sql, params) : await query(sql, params);
    return (result.rowCount ?? 0) === 1;
  },
};
