import type { OAuthTokenSet } from '@skytwin/shared-types';
import type { OAuthTokenStore } from './token-store.js';
import type { GoogleOAuthConfig } from './google-oauth.js';
import { refreshAccessToken } from './google-oauth.js';
import type { MicrosoftOAuthConfig } from './microsoft-oauth.js';
import { refreshAccessToken as refreshMicrosoftAccessToken } from './microsoft-oauth.js';
import { encrypt, decrypt, IV_LENGTH, TAG_LENGTH } from '@skytwin/credential-vault';
import { createLogger } from '@skytwin/core';

const log = createLogger('connectors:db-token-store');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Counter for lazy-migration failures, exposed for observability tests.
 * Each failed migration attempt increments this; downstream observability
 * tooling can read the value periodically. NEVER reset in production.
 */
export const lazyMigrationFailureCounter = { count: 0 };

/**
 * Packed ciphertext format: [IV (12 bytes)] + [tag (16 bytes)] + [ciphertext]
 *
 * Each token is encrypted independently with its own fresh IV. Both packed
 * buffers are stored together under the DB columns:
 *   encrypted_access_token  = pack(access_token)
 *   encrypted_refresh_token = pack(refresh_token)
 *   encryption_iv / encryption_tag = set to NULL (superseded by packed format)
 *
 * The legacy schema columns (encryption_iv, encryption_tag) are left NULL for
 * rows migrated via this path. A single IV cannot safely be reused across two
 * distinct AES-GCM encryptions.
 */

function packEncrypted(result: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): Buffer {
  return Buffer.concat([result.iv, result.tag, result.ciphertext]);
}

/**
 * Reverse of packEncrypted. Validates length up-front so corruption surfaces
 * as a clear "packed buffer too short" error rather than the cryptic
 * "Unsupported state or unable to authenticate data" thrown by AES-GCM
 * when it's handed a too-short ciphertext.
 *
 * Minimum is IV_LENGTH (12) + TAG_LENGTH (16) = 28 bytes; that's an empty
 * plaintext. Anything shorter is corruption or a wrong-format buffer.
 */
const MIN_PACKED_LENGTH = IV_LENGTH + TAG_LENGTH;

function unpackEncrypted(packed: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!Buffer.isBuffer(packed) || packed.length < MIN_PACKED_LENGTH) {
    throw new Error(
      `unpackEncrypted: packed buffer too short (got ${packed?.length ?? 0} bytes, ` +
        `need at least ${MIN_PACKED_LENGTH} for IV + tag)`,
    );
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  return { iv, tag, ciphertext };
}

/**
 * Interface matching the @skytwin/db oauthRepository shape.
 * Defined here to avoid a direct dependency on the DB package from connectors.
 */
interface OAuthRepositoryTokenRow {
  id?: string;
  credential_revision?: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: Date;
  scopes: string[];
  encrypted_access_token?: Buffer | null;
  encrypted_refresh_token?: Buffer | null;
  encryption_iv?: Buffer | null;
  encryption_tag?: Buffer | null;
  encryption_key_version?: number;
}

interface OAuthRepositoryLike {
  getToken(userId: string, provider: string): Promise<OAuthRepositoryTokenRow | null>;
  getTokenByConnectorAccount?: (
    userId: string,
    provider: string,
    connectorAccountId: string,
  ) => Promise<OAuthRepositoryTokenRow | null>;
  saveToken(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
    scopes: string[],
  ): Promise<unknown>;
  deleteToken(userId: string, provider: string): Promise<unknown>;
  updateAccessToken(
    userId: string,
    provider: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<unknown>;
  updateAccessTokenIfCurrent?(input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    accessToken: string;
    expiresAt: Date;
  }): Promise<boolean>;
  rotateTokenIfCurrent?(input: {
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
  }): Promise<unknown>;
  /** Prove that this process's cached key still belongs to the live vault generation. */
  validateVaultSession?(userId: string, vaultGeneration: string): Promise<boolean>;
  /** Distinguish an uninitialized vault from a durable locked vault. */
  getVaultAuthorityState?(userId: string): Promise<{
    state: 'absent' | 'locked' | 'unlocked';
    generation: string | null;
    keyVersion: number | null;
  }>;
  updateEncryptedIfCurrent?: (input: {
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
  }) => Promise<boolean>;
  updateEncryptedAccessTokenIfCurrent?: (input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    expectedVaultGeneration: string;
    encryptedAccessToken: Buffer;
    expiresAt: Date;
  }) => Promise<boolean>;
  rotateEncryptedTokenIfCurrent?: (input: {
    id: string;
    userId: string;
    provider: string;
    expectedCredentialRevision: string;
    expectedVaultGeneration: string;
    encryptedAccessToken: Buffer;
    encryptedRefreshToken?: Buffer;
    expiresAt: Date;
  }) => Promise<unknown>;
  updateAccessTokenByConnectorAccount?: (
    userId: string,
    provider: string,
    connectorAccountId: string,
    accessToken: string,
    expiresAt: Date,
    expectedCredentialRevision: string,
  ) => Promise<unknown>;
}

interface TokenMaterializationOptions {
  /** Exact key snapshot held for a refresh operation. */
  key?: Buffer | null;
  /** Vault generation paired with the exact key snapshot. */
  vaultGeneration?: string | null;
  /** Ordinary reads migrate in the background; refresh owns its one write. */
  lazyMigrate?: boolean;
}

/**
 * Interface for looking up a per-user derived key from the KeyCache.
 * Avoids importing the KeyCache class directly (no hard dep on credential-vault
 * from the connectors interface layer).
 */
export interface KeyCacheLike {
  get(userId: string): Buffer | null;
  getGeneration(userId: string): string | null;
  has(userId: string): boolean;
  set(userId: string, key: Buffer, generation?: string | null): void;
}

/** Minimum account-bound bearer snapshot plus the exact revision that materialized it. */
export interface RevisionBoundOAuthTokenSet {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
  provider: OAuthTokenSet['provider'];
  credentialRevision: string;
}

function canonicalScopes(scopes: string[]): string[] | null {
  try {
    if (!Array.isArray(scopes) || Object.getPrototypeOf(scopes) !== Array.prototype ||
        Object.getOwnPropertySymbols(scopes).length !== 0 ||
        scopes.length < 1 || scopes.length > 128) return null;
    const descriptors = Object.getOwnPropertyDescriptors(scopes);
    if (Object.getOwnPropertyNames(descriptors).length !== scopes.length + 1) return null;
    const canonical: string[] = [];
    const unique = new Set<string>();
    for (let index = 0; index < scopes.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      const scope = descriptor.value as unknown;
      if (typeof scope !== 'string' || scope.length === 0 || scope.length > 512 ||
          unique.has(scope)) return null;
      unique.add(scope);
      canonical.push(scope);
    }
    return canonical.sort();
  } catch {
    return null;
  }
}

function sameScopeSet(left: string[], right: string[]): boolean {
  const leftScopes = canonicalScopes(left);
  const rightScopes = canonicalScopes(right);
  return leftScopes !== null && rightScopes !== null &&
    leftScopes.length === rightScopes.length &&
    leftScopes.every((scope, index) => scope === rightScopes[index]);
}

function sameTokenSnapshot(left: OAuthTokenSet, right: OAuthTokenSet): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt.getTime() === right.expiresAt.getTime() &&
    left.provider === right.provider &&
    sameScopeSet(left.scopes, right.scopes);
}

/**
 * OAuthTokenStore implementation backed by a database repository.
 *
 * Bridges the connectors package's OAuthTokenStore port to the
 * @skytwin/db oauthRepository. Handles automatic token refresh
 * when access tokens are expired.
 *
 * When a KeyCache is provided via setKeyCache(), the read path performs
 * lazy vault migration:
 *   1. If encrypted_access_token is present AND vault is unlocked → decrypt.
 *   2. If plaintext access_token is present AND vault is unlocked → encrypt
 *      now (lazy migrate), clear plaintext, return the value.
 *   3. If plaintext access_token is present AND vault is NOT unlocked →
 *      return plaintext (backward compat for users who have not enabled vault).
 *   4. Encrypted but vault locked → throw "credentials unavailable".
 *   5. No token at all → return null.
 */
/**
 * Audit-log sink (#393). Fire-and-forget — the implementation MUST
 * NOT throw and SHOULD NOT block the credential-vault read path. A
 * failure here is a logging miss; it must never deny a legitimate
 * token decrypt. The worker wires this to `accessLogRepository.record`
 * from `@skytwin/db` at composition time; tests stub it.
 */
export interface AuditLogPort {
  recordAccess(input: {
    userId: string;
    actor: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    /**
     * Optional correlation id to thread audit rows back to the
     * originating request — HTTP `X-Request-Id` when the action came
     * in via the API, the worker's per-cycle id when it came from a
     * poll. Stored in `access_log.request_id`. Today the DbTokenStore
     * decrypt path doesn't carry one (worker decrypts happen on a
     * timer, not in response to a request), but the port surface is
     * uniform with `accessLogRepository.record` so a future
     * request-scoped caller can pass it through without a wider type
     */
    requestId?: string | null;
  }): void | Promise<void>;
}

export class DbTokenStore implements OAuthTokenStore {
  private keyCache: KeyCacheLike | null = null;
  private auditLog: AuditLogPort | null = null;

  constructor(
    private readonly repo: OAuthRepositoryLike,
    /**
     * Google config. Optional so a Microsoft-only deployment can construct the
     * store without a Google client; refreshing a `google` token without it
     * THROWS (same fail-loud guard as Microsoft below) rather than crashing on
     * an undefined config. Existing 2-arg `(repo, googleConfig)` callers are
     * unaffected.
     */
    private readonly oauthConfig?: GoogleOAuthConfig,
    /**
     * Optional Microsoft (Entra) config. Required to refresh `microsoft`
     * tokens — without it, refreshing a microsoft token THROWS rather than
     * falling back to the Google endpoint (which would POST the token to the
     * wrong vendor; the same token-leak class fixed in the disconnect routes).
     */
    private readonly microsoftConfig?: MicrosoftOAuthConfig,
    /** Fixed stable account identity for worker-side multi-account polling. */
    private readonly connectorAccountId?: string,
  ) {}

  /**
   * Attach a KeyCache so the read path can perform vault decrypt / lazy
   * migration. Call this after creating the store if the credential vault
   * is enabled for this deployment.
   */
  setKeyCache(cache: KeyCacheLike): void {
    this.keyCache = cache;
  }

  /**
   * Attach an audit-log sink. Every successful credential-vault
   * decryption (Case 1 below) emits an `action: 'decrypt_oauth_token'`
   * row through this sink with `actor` supplied by the caller (worker
   * vs. api vs. test). The plaintext-fallback paths (Cases 2-3) do
   * NOT emit — those tokens are stored in cleartext and decryption
   * isn't a privilege action. See #393.
   */
  setAuditLog(port: AuditLogPort, actor: string): void {
    this.auditLog = port;
    this.auditLogActor = actor;
  }

  private auditLogActor = 'unknown';

  async getToken(userId: string, provider: string): Promise<OAuthTokenSet | null> {
    const row = this.connectorAccountId
      ? await this.getBoundRow(userId, provider)
      : await this.repo.getToken(userId, provider);
    if (!row) return null;
    return this.materializeToken(userId, provider, row);
  }

  /** Decode one exact row snapshot; refresh uses this to avoid a second read. */
  private async materializeToken(
    userId: string,
    provider: string,
    row: OAuthRepositoryTokenRow,
    options: TokenMaterializationOptions = {},
  ): Promise<OAuthTokenSet | null> {
    const key = Object.prototype.hasOwnProperty.call(options, 'key')
      ? options.key ?? null
      : this.keyCache?.get(userId) ?? null;
    const vaultGeneration = Object.prototype.hasOwnProperty.call(options, 'vaultGeneration')
      ? options.vaultGeneration ?? null
      : this.keyCache?.getGeneration(userId) ?? null;
    const lazyMigrate = options.lazyMigrate ?? true;
    const vaultAuthority = this.repo.getVaultAuthorityState
      ? await this.repo.getVaultAuthorityState(userId)
      : null;
    const vaultSessionValid = vaultAuthority?.state === 'unlocked' &&
      vaultAuthority.generation === vaultGeneration && key !== null;

    // Any encrypted representation is authoritative. Never fall through to
    // leftover plaintext when the vault is locked or a partially migrated row
    // is missing one encrypted half; that would silently downgrade the vault.
    if (row.encrypted_access_token || row.encrypted_refresh_token) {
      if (!row.encrypted_access_token || !row.encrypted_refresh_token ||
          key === null || vaultGeneration === null || !vaultSessionValid) {
        throw new Error('credentials unavailable; please unlock or repair the credential vault');
      }
      const { iv: atIv, tag: atTag, ciphertext: atCipher } = unpackEncrypted(row.encrypted_access_token);
      const { iv: rtIv, tag: rtTag, ciphertext: rtCipher } = unpackEncrypted(row.encrypted_refresh_token);

      const accessToken = decrypt({ ciphertext: atCipher, iv: atIv, tag: atTag }, key);
      const refreshToken = decrypt({ ciphertext: rtCipher, iv: rtIv, tag: rtTag }, key);

      // Audit-log the decryption (#393). Fire-and-forget; a logging
      // failure must not deny a legitimate token decrypt. The audit
      // port is optional — environments without an audit sink (e.g.
      // unit tests) keep the existing behaviour exactly.
      if (this.auditLog) {
        try {
          const maybePromise = this.auditLog.recordAccess({
            userId,
            actor: this.auditLogActor,
            action: 'decrypt_oauth_token',
            resourceType: 'oauth_token',
            resourceId: row.id ?? null,
          });
          if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
            (maybePromise as Promise<void>).catch((err: unknown) => {
              log.warn('Audit-log recordAccess failed', {
                userId,
                provider,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } catch (err) {
          log.warn('Audit-log recordAccess threw synchronously', {
            userId,
            provider,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        accessToken,
        refreshToken,
        expiresAt: row.expires_at,
        scopes: row.scopes,
        provider: provider as OAuthTokenSet['provider'],
      };
    }

    // Case 2: plaintext present AND vault is unlocked → lazy migrate
    if (row.access_token && row.refresh_token && key !== null) {
      if (vaultGeneration === null || !vaultSessionValid) {
        throw new Error('credentials unavailable; cached credential-vault authority is stale');
      }
      if (lazyMigrate && row.id && row.credential_revision &&
          this.repo.updateEncryptedIfCurrent) {
        // Fire-and-forget migration — do not block the caller. Failures are
        // surfaced via createLogger.warn AND a counter so downstream
        // observability can detect a stuck migration loop.
        const rowId = row.id;
        this._lazyMigrate(
          rowId,
          userId,
          provider,
          row.credential_revision,
          row.access_token,
          row.refresh_token,
          vaultAuthority?.keyVersion ?? row.encryption_key_version ?? 1,
          key,
          vaultGeneration,
        ).catch((err: unknown) => {
          lazyMigrationFailureCounter.count += 1;
          log.warn('Lazy credential-vault migration failed', {
            userId,
            provider,
            rowId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
        scopes: row.scopes,
        provider: provider as OAuthTokenSet['provider'],
      };
    }

    // Case 3: plaintext present AND vault is NOT unlocked → backward compat
    if (row.access_token && row.refresh_token) {
      if (vaultAuthority && vaultAuthority.state !== 'absent') {
        throw new Error('credentials unavailable; please unlock the credential vault');
      }
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
        scopes: row.scopes,
        provider: provider as OAuthTokenSet['provider'],
      };
    }

    // Case 4: no usable token
    return null;
  }

  private async getBoundRow(userId: string, provider: string) {
    if (!this.connectorAccountId || !this.repo.getTokenByConnectorAccount) {
      throw new Error('Account-bound token store requires getTokenByConnectorAccount.');
    }
    return this.repo.getTokenByConnectorAccount(userId, provider, this.connectorAccountId);
  }

  /**
   * Encrypt access and refresh tokens independently (each gets a fresh IV)
   * and write them to the encrypted columns, clearing the plaintext columns.
   */
  private async _lazyMigrate(
    id: string,
    userId: string,
    provider: string,
    expectedCredentialRevision: string,
    accessToken: string,
    refreshToken: string,
    keyVersion: number,
    key: Buffer,
    vaultGeneration: string,
  ): Promise<boolean> {
    if (!this.repo.updateEncryptedIfCurrent) return false;

    const atPacked = packEncrypted(encrypt(accessToken, key));
    const rtPacked = packEncrypted(encrypt(refreshToken, key));

    // encryption_iv and encryption_tag are set to zero-length buffers because
    // the IV/tag are now embedded in each packed column. We pass small sentinel
    // buffers to satisfy NOT NULL constraints if any; the DB columns are NULL-able
    // per the migration, so we just use the sentinel value NULL via Buffer(0).
    return this.repo.updateEncryptedIfCurrent({
      id,
      userId,
      provider,
      expectedCredentialRevision,
      expectedVaultGeneration: vaultGeneration,
      encryptedAccessToken: atPacked,
      encryptedRefreshToken: rtPacked,
      // These legacy fields exist on the schema but are superseded by the
      // packed format above. Pass zero-length buffers — the schema allows NULL.
      iv: Buffer.alloc(0),
      tag: Buffer.alloc(0),
      keyVersion,
    });
  }

  async saveToken(userId: string, provider: string, tokenSet: OAuthTokenSet): Promise<void> {
    if (this.connectorAccountId) {
      throw new Error('Account-bound worker token stores cannot create OAuth identities.');
    }
    await this.repo.saveToken(
      userId,
      provider,
      tokenSet.accessToken,
      tokenSet.refreshToken,
      tokenSet.expiresAt,
      tokenSet.scopes,
    );
  }

  async deleteToken(userId: string, provider: string): Promise<void> {
    if (this.connectorAccountId) {
      throw new Error('Account-bound worker token stores cannot disconnect OAuth identities.');
    }
    await this.repo.deleteToken(userId, provider);
  }

  async refreshIfExpired(
    userId: string,
    provider: string,
    signal?: AbortSignal,
    options: { lazyMigrate?: boolean } = {},
  ): Promise<OAuthTokenSet> {
    signal?.throwIfAborted();
    // Validate the provider up-front — fail loud on an unsupported provider
    // BEFORE fetching (and potentially decrypting) any stored secret. The
    // switch below keeps a defensive `default: throw` as a backstop.
    if (provider !== 'google' && provider !== 'microsoft') {
      throw new Error(`DbTokenStore: unsupported provider '${provider}' for token refresh.`);
    }

    // Capture the exact credential version before any network request. The
    // write after refresh is a compare-and-swap against this exact revision, so a
    // disconnect/reconnect or another refresh that wins while Google is in
    // flight makes this attempt fail closed.
    let refreshSnapshot = this.connectorAccountId
      ? await this.getBoundRow(userId, provider)
      : await this.repo.getToken(userId, provider);
    signal?.throwIfAborted();
    if (!refreshSnapshot) {
      throw new Error(`No OAuth token found for user ${userId} provider ${provider}`);
    }
    // Hold the key and its authority generation as one operation snapshot. A
    // refresh must never decrypt with one cached key and persist with a later
    // replacement key merely because rotation happened during provider I/O.
    const operationKey = this.keyCache?.get(userId) ?? null;
    const operationVaultGeneration = this.keyCache?.getGeneration(userId) ?? null;

    // Do not launch a background lazy migration here. Refresh owns the exact
    // source revision, while the unexpired path below performs any required
    // migration synchronously before returning a live grant.
    let existing = await this.materializeToken(userId, provider, refreshSnapshot, {
      key: operationKey,
      vaultGeneration: operationVaultGeneration,
      lazyMigrate: false,
    });
    signal?.throwIfAborted();
    if (!existing) throw new Error('Stored OAuth credential is unusable.');

    const bufferMs = 60 * 1000;
    if (existing.expiresAt.getTime() > Date.now() + bufferMs) {
      if (options.lazyMigrate !== false &&
          !refreshSnapshot.encrypted_access_token && !refreshSnapshot.encrypted_refresh_token &&
          operationKey !== null) {
        const key = operationKey;
        const vaultGeneration = operationVaultGeneration;
        const vaultAuthority = this.repo.getVaultAuthorityState
          ? await this.repo.getVaultAuthorityState(userId)
          : null;
        if (key === null || vaultGeneration === null || !refreshSnapshot.id ||
            !refreshSnapshot.credential_revision || !refreshSnapshot.access_token ||
            !refreshSnapshot.refresh_token || vaultAuthority?.state !== 'unlocked' ||
            vaultAuthority.generation !== vaultGeneration ||
            vaultAuthority.keyVersion === null) {
          throw new Error('credentials unavailable; credential-vault authority changed during migration');
        }
        const migrated = await this._lazyMigrate(
          refreshSnapshot.id,
          userId,
          provider,
          refreshSnapshot.credential_revision,
          refreshSnapshot.access_token,
          refreshSnapshot.refresh_token,
          vaultAuthority.keyVersion,
          key,
          vaultGeneration,
        );
        if (!migrated) {
          throw new Error('OAuth credential changed while vault migration was in flight.');
        }
      }
      return existing;
    }

    if (!refreshSnapshot.id || !refreshSnapshot.credential_revision) {
      throw new Error('OAuth credential is missing required revision identity.');
    }
    let refreshRowId = refreshSnapshot.id;
    let refreshRevision = refreshSnapshot.credential_revision;

    // An expired legacy plaintext credential under an unlocked vault needs two
    // revision-fenced transitions: migrate the exact source revision first,
    // then refresh the now-encrypted row. updateEncryptedIfCurrent deliberately
    // does not update expiry, so attempting to combine these operations would
    // leave a fresh bearer paired with the stale expiry or bypass vault fencing.
    if (!refreshSnapshot.encrypted_access_token && !refreshSnapshot.encrypted_refresh_token &&
        operationKey !== null) {
      const vaultAuthority = this.repo.getVaultAuthorityState
        ? await this.repo.getVaultAuthorityState(userId)
        : null;
      if (operationVaultGeneration === null || !refreshSnapshot.access_token ||
          !refreshSnapshot.refresh_token || vaultAuthority?.state !== 'unlocked' ||
          vaultAuthority.generation !== operationVaultGeneration ||
          vaultAuthority.keyVersion === null) {
        throw new Error('credentials unavailable; credential-vault authority changed during refresh');
      }
      const migrated = await this._lazyMigrate(
        refreshSnapshot.id,
        userId,
        provider,
        refreshSnapshot.credential_revision,
        refreshSnapshot.access_token,
        refreshSnapshot.refresh_token,
        vaultAuthority.keyVersion,
        operationKey,
        operationVaultGeneration,
      );
      if (!migrated) {
        throw new Error('OAuth credential changed while vault migration was in flight.');
      }
      const migratedRow = this.connectorAccountId
        ? await this.getBoundRow(userId, provider)
        : await this.repo.getToken(userId, provider);
      if (!migratedRow || migratedRow.id !== refreshSnapshot.id ||
          !migratedRow.credential_revision || !migratedRow.encrypted_access_token ||
          !migratedRow.encrypted_refresh_token) {
        throw new Error('OAuth credential changed while vault migration was in flight.');
      }
      refreshSnapshot = migratedRow;
      refreshRowId = migratedRow.id;
      refreshRevision = migratedRow.credential_revision;
      existing = await this.materializeToken(userId, provider, migratedRow, {
        key: operationKey,
        vaultGeneration: operationVaultGeneration,
        lazyMigrate: false,
      });
      if (!existing) throw new Error('Stored OAuth credential is unusable after vault migration.');
    }

    // Token is expired or about to expire — refresh it via the RIGHT
    // provider's endpoint. Never fall back to Google for a non-Google token:
    // that would POST the refresh token to the wrong vendor (the token-leak
    // class fixed in the disconnect routes). For non-rotating Microsoft
    // tokens the stored refresh token is reused; when Microsoft does rotate
    // one, the exact refreshed grant is committed below under the same
    // credential/vault generation fences as the access token.
    // `switch` with a `default: throw` makes the no-fallback property
    // structural: an unrecognized provider can NEVER reach the Google branch,
    // so a future reorder/addition can't silently reintroduce the cross-vendor
    // leak this dispatch exists to prevent.
    let refreshed: OAuthTokenSet;
    switch (provider) {
      case 'microsoft':
        if (!this.microsoftConfig) {
          throw new Error(
            'DbTokenStore: refusing to refresh a microsoft token — no Microsoft OAuth config was wired. ' +
              'Construct DbTokenStore with a microsoftConfig to support Outlook.',
          );
        }
        refreshed = await refreshMicrosoftAccessToken(this.microsoftConfig, existing.refreshToken, {
          persistedScopes: [...existing.scopes],
          signal,
        });
        break;
      case 'google':
        if (!this.oauthConfig) {
          throw new Error(
            'DbTokenStore: refusing to refresh a google token — no Google OAuth config was wired. ' +
              'Construct DbTokenStore with a googleConfig.',
          );
        }
        refreshed = await refreshAccessToken(this.oauthConfig, existing.refreshToken, {
          persistedScopes: [...existing.scopes],
          signal,
        });
        break;
      default:
        throw new Error(`DbTokenStore: unsupported provider '${provider}' for token refresh.`);
    }
    signal?.throwIfAborted();

    // This repository updates bearer material and expiry, but not the stored
    // authority grant. Persisting a bearer returned with a changed scope set
    // would pair it with stale scopes on the next materialization. Reject any
    // added, removed, duplicated, or malformed scope before the credential CAS.
    if (!sameScopeSet(existing.scopes, refreshed.scopes)) {
      throw new Error('OAuth token refresh returned a changed or invalid scope grant.');
    }

    // Persist the new access token. If the row is currently stored
    // encrypted (key cache populated AND row has encrypted_access_token),
    // write the new token to the ENCRYPTED column — otherwise getToken
    // would keep returning the old, still-encrypted access token while
    // the new plaintext sat unread.
    const key = operationKey;
    const vaultGeneration = operationVaultGeneration;
    let persisted = false;
    if (refreshSnapshot.encrypted_access_token || refreshSnapshot.encrypted_refresh_token) {
      if (!refreshSnapshot.encrypted_access_token || !refreshSnapshot.encrypted_refresh_token ||
          key === null || vaultGeneration === null ||
          !this.repo.validateVaultSession ||
          !await this.repo.validateVaultSession(userId, vaultGeneration)) {
        throw new Error('credentials unavailable; credential-vault authority changed during refresh');
      }
      signal?.throwIfAborted();
      const encryptedAccessToken = packEncrypted(encrypt(refreshed.accessToken, key));
      if (refreshed.refreshToken !== existing.refreshToken) {
        if (!this.repo.rotateEncryptedTokenIfCurrent) {
          throw new Error('OAuth repository does not support revision-fenced encrypted grant rotation.');
        }
        persisted = Boolean(await this.repo.rotateEncryptedTokenIfCurrent({
          id: refreshRowId,
          userId,
          provider,
          expectedCredentialRevision: refreshRevision,
          expectedVaultGeneration: vaultGeneration,
          encryptedAccessToken,
          encryptedRefreshToken: packEncrypted(encrypt(refreshed.refreshToken, key)),
          expiresAt: refreshed.expiresAt,
        }));
      } else {
        if (!this.repo.updateEncryptedAccessTokenIfCurrent) {
          throw new Error('OAuth repository does not support revision-fenced encrypted refresh persistence.');
        }
        persisted = await this.repo.updateEncryptedAccessTokenIfCurrent({
          id: refreshRowId,
          userId,
          provider,
          expectedCredentialRevision: refreshRevision,
          expectedVaultGeneration: vaultGeneration,
          encryptedAccessToken,
          expiresAt: refreshed.expiresAt,
        });
      }
    } else if (key !== null) {
      const vaultAuthority = this.repo.getVaultAuthorityState
        ? await this.repo.getVaultAuthorityState(userId)
        : null;
      if (vaultGeneration === null || vaultAuthority?.state !== 'unlocked' ||
          vaultAuthority.generation !== vaultGeneration ||
          vaultAuthority.keyVersion === null ||
          !this.repo.updateEncryptedIfCurrent) {
        throw new Error('credentials unavailable; credential-vault authority changed during refresh');
      }
      persisted = await this.repo.updateEncryptedIfCurrent({
        id: refreshRowId,
        userId,
        provider,
        expectedCredentialRevision: refreshRevision,
        expectedVaultGeneration: vaultGeneration,
        encryptedAccessToken: packEncrypted(encrypt(refreshed.accessToken, key)),
        encryptedRefreshToken: packEncrypted(encrypt(existing.refreshToken, key)),
        iv: Buffer.alloc(0),
        tag: Buffer.alloc(0),
        keyVersion: vaultAuthority.keyVersion,
      });
    } else {
      signal?.throwIfAborted();
      if (refreshed.refreshToken !== existing.refreshToken) {
        if (!this.repo.rotateTokenIfCurrent) {
          throw new Error('OAuth repository does not support revision-fenced grant rotation.');
        }
        persisted = Boolean(await this.repo.rotateTokenIfCurrent({
          id: refreshRowId,
          userId,
          provider,
          expectedCredentialRevision: refreshRevision,
          expectedAccessToken: refreshSnapshot.access_token,
          expectedRefreshToken: existing.refreshToken,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          scopes: refreshed.scopes,
        }));
      } else if (this.connectorAccountId) {
        if (!this.repo.updateAccessTokenByConnectorAccount) {
          throw new Error('Account-bound token store requires revision-fenced refresh persistence.');
        }
        persisted = Boolean(await this.repo.updateAccessTokenByConnectorAccount(
          userId,
          provider,
          this.connectorAccountId,
          refreshed.accessToken,
          refreshed.expiresAt,
          refreshRevision,
        ));
      } else {
        if (!this.repo.updateAccessTokenIfCurrent) {
          throw new Error('OAuth repository does not support revision-fenced refresh persistence.');
        }
        persisted = await this.repo.updateAccessTokenIfCurrent({
          id: refreshRowId,
          userId,
          provider,
          expectedCredentialRevision: refreshRevision,
          accessToken: refreshed.accessToken,
          expiresAt: refreshed.expiresAt,
        });
      }
    }
    if (!persisted) {
      throw new Error('OAuth credential changed while refresh was in flight; refusing stale refresh result.');
    }

    return refreshed;
  }

  /**
   * Materialize an account-bound bearer and prove which credential revision
   * currently stores that exact bearer. Lazy migration is disabled for this
   * operation so it cannot rotate the revision after the proof is returned.
   */
  async refreshIfExpiredWithRevision(
    userId: string,
    provider: string,
  ): Promise<RevisionBoundOAuthTokenSet> {
    if (!this.connectorAccountId) {
      throw new Error('Revision-bound token materialization requires a connector account.');
    }
    const token = await this.refreshIfExpired(userId, provider, undefined, { lazyMigrate: false });
    const row = await this.getBoundRow(userId, provider);
    if (!row?.credential_revision || !UUID.test(row.credential_revision)) {
      throw new Error('Account-bound OAuth row is missing its credential revision.');
    }
    const key = this.keyCache?.get(userId) ?? null;
    const vaultGeneration = this.keyCache?.getGeneration(userId) ?? null;
    const current = await this.materializeToken(userId, provider, row, {
      key,
      vaultGeneration,
      lazyMigrate: false,
    });
    if (!current || !sameTokenSnapshot(current, token)) {
      throw new Error('OAuth credential changed during token materialization.');
    }
    const scopes = [...current.scopes];
    Object.freeze(scopes);
    return Object.freeze({
      accessToken: current.accessToken,
      expiresAt: current.expiresAt,
      provider: current.provider,
      scopes,
      credentialRevision: row.credential_revision,
    });
  }
}
