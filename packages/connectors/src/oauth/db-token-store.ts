import type { OAuthTokenSet } from '@skytwin/shared-types';
import type { OAuthTokenStore } from './token-store.js';
import type { GoogleOAuthConfig } from './google-oauth.js';
import { refreshAccessToken } from './google-oauth.js';
import type { MicrosoftOAuthConfig } from './microsoft-oauth.js';
import { refreshAccessToken as refreshMicrosoftAccessToken } from './microsoft-oauth.js';
import { encrypt, decrypt, IV_LENGTH, TAG_LENGTH } from '@skytwin/credential-vault';
import { createLogger } from '@skytwin/core';

const log = createLogger('connectors:db-token-store');

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
interface OAuthRepositoryLike {
  getToken(userId: string, provider: string): Promise<{
    id?: string;
    access_token: string | null;
    refresh_token: string | null;
    expires_at: Date;
    scopes: string[];
    encrypted_access_token?: Buffer | null;
    encrypted_refresh_token?: Buffer | null;
    encryption_iv?: Buffer | null;
    encryption_tag?: Buffer | null;
    encryption_key_version?: number;
  } | null>;
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
  /**
   * Write encrypted columns and clear the plaintext columns.
   * Optional — callers that do not pass this method will skip lazy migration.
   */
  updateEncrypted?: (
    id: string,
    input: {
      encryptedAccessToken: Buffer;
      encryptedRefreshToken: Buffer;
      iv: Buffer;
      tag: Buffer;
      keyVersion: number;
    },
  ) => Promise<void>;
  /**
   * Update only the encrypted access token (for refresh-rotation when the
   * row is stored encrypted). Leaves refresh token alone, NULLs the
   * plaintext column so subsequent reads cannot fall back to the old value.
   */
  updateEncryptedAccessToken?: (
    id: string,
    encryptedAccessToken: Buffer,
    expiresAt: Date,
  ) => Promise<void>;
}

/**
 * Interface for looking up a per-user derived key from the KeyCache.
 * Avoids importing the KeyCache class directly (no hard dep on credential-vault
 * from the connectors interface layer).
 */
export interface KeyCacheLike {
  get(userId: string): Buffer | null;
  has(userId: string): boolean;
  set(userId: string, key: Buffer): void;
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
     * change.
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
    const row = await this.repo.getToken(userId, provider);
    if (!row) return null;

    const key = this.keyCache?.get(userId) ?? null;

    // Case 1: encrypted columns present AND vault is unlocked → decrypt
    if (
      row.encrypted_access_token &&
      row.encrypted_refresh_token &&
      key !== null
    ) {
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
      if (row.id && this.repo.updateEncrypted) {
        // Fire-and-forget migration — do not block the caller. Failures are
        // surfaced via createLogger.warn AND a counter so downstream
        // observability can detect a stuck migration loop.
        const rowId = row.id;
        this._lazyMigrate(
          rowId,
          row.access_token,
          row.refresh_token,
          row.encryption_key_version ?? 1,
          key,
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
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
        scopes: row.scopes,
        provider: provider as OAuthTokenSet['provider'],
      };
    }

    // Case 4: encrypted but vault locked
    if (row.encrypted_access_token) {
      throw new Error('credentials unavailable; please unlock the credential vault to continue');
    }

    // Case 5: no usable token
    return null;
  }

  /**
   * Encrypt access and refresh tokens independently (each gets a fresh IV)
   * and write them to the encrypted columns, clearing the plaintext columns.
   */
  private async _lazyMigrate(
    id: string,
    accessToken: string,
    refreshToken: string,
    keyVersion: number,
    key: Buffer,
  ): Promise<void> {
    if (!this.repo.updateEncrypted) return;

    const atPacked = packEncrypted(encrypt(accessToken, key));
    const rtPacked = packEncrypted(encrypt(refreshToken, key));

    // encryption_iv and encryption_tag are set to zero-length buffers because
    // the IV/tag are now embedded in each packed column. We pass small sentinel
    // buffers to satisfy NOT NULL constraints if any; the DB columns are NULL-able
    // per the migration, so we just use the sentinel value NULL via Buffer(0).
    await this.repo.updateEncrypted(id, {
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
    await this.repo.deleteToken(userId, provider);
  }

  async refreshIfExpired(userId: string, provider: string): Promise<OAuthTokenSet> {
    // Validate the provider up-front — fail loud on an unsupported provider
    // BEFORE fetching (and potentially decrypting) any stored secret. The
    // switch below keeps a defensive `default: throw` as a backstop.
    if (provider !== 'google' && provider !== 'microsoft') {
      throw new Error(`DbTokenStore: unsupported provider '${provider}' for token refresh.`);
    }

    const existing = await this.getToken(userId, provider);
    if (!existing) {
      throw new Error(`No OAuth token found for user ${userId} provider ${provider}`);
    }

    // If not expired yet (with 60s buffer), return as-is
    const bufferMs = 60 * 1000;
    if (existing.expiresAt.getTime() > Date.now() + bufferMs) {
      return existing;
    }

    // Token is expired or about to expire — refresh it via the RIGHT
    // provider's endpoint. Never fall back to Google for a non-Google token:
    // that would POST the refresh token to the wrong vendor (the token-leak
    // class fixed in the disconnect routes). For non-rotating Microsoft
    // tokens the stored refresh token is reused (rotation persistence is a
    // follow-up); the access token is updated below.
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
        refreshed = await refreshMicrosoftAccessToken(this.microsoftConfig, existing.refreshToken);
        break;
      case 'google':
        if (!this.oauthConfig) {
          throw new Error(
            'DbTokenStore: refusing to refresh a google token — no Google OAuth config was wired. ' +
              'Construct DbTokenStore with a googleConfig.',
          );
        }
        refreshed = await refreshAccessToken(this.oauthConfig, existing.refreshToken);
        break;
      default:
        throw new Error(`DbTokenStore: unsupported provider '${provider}' for token refresh.`);
    }

    // Persist the new access token. If the row is currently stored
    // encrypted (key cache populated AND row has encrypted_access_token),
    // write the new token to the ENCRYPTED column — otherwise getToken
    // would keep returning the old, still-encrypted access token while
    // the new plaintext sat unread.
    const row = await this.repo.getToken(userId, provider);
    const key = this.keyCache?.get(userId) ?? null;
    if (
      row?.id
      && row.encrypted_access_token
      && key !== null
      && this.repo.updateEncryptedAccessToken
    ) {
      const packed = packEncrypted(encrypt(refreshed.accessToken, key));
      await this.repo.updateEncryptedAccessToken(row.id, packed, refreshed.expiresAt);
    } else {
      await this.repo.updateAccessToken(
        userId,
        provider,
        refreshed.accessToken,
        refreshed.expiresAt,
      );
    }

    // TODO(outlook-connector): persist a ROTATED Microsoft refresh token.
    // The persist above only writes the access token, and this returns the
    // original refresh token. Google never rotates, so this is correct there;
    // Microsoft is non-rotating by default but CAN rotate under some
    // conditional-access configs — when it does, the new refresh token is
    // currently dropped, so the next poll re-submits the stale one and the
    // grant dies (permanent MicrosoftOAuthRefreshError) until re-auth. The
    // Outlook signal connector PR must persist `refreshed.refreshToken` (and
    // return it) when it differs from `existing.refreshToken`, handling the
    // encrypted-column path too.
    return {
      ...refreshed,
      refreshToken: existing.refreshToken,
    };
  }
}
