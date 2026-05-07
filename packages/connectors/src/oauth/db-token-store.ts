import type { OAuthTokenSet } from '@skytwin/shared-types';
import type { OAuthTokenStore } from './token-store.js';
import type { GoogleOAuthConfig } from './google-oauth.js';
import { refreshAccessToken } from './google-oauth.js';
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

function unpackEncrypted(packed: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
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
export class DbTokenStore implements OAuthTokenStore {
  private keyCache: KeyCacheLike | null = null;

  constructor(
    private readonly repo: OAuthRepositoryLike,
    private readonly oauthConfig: GoogleOAuthConfig,
  ) {}

  /**
   * Attach a KeyCache so the read path can perform vault decrypt / lazy
   * migration. Call this after creating the store if the credential vault
   * is enabled for this deployment.
   */
  setKeyCache(cache: KeyCacheLike): void {
    this.keyCache = cache;
  }

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
    const existing = await this.getToken(userId, provider);
    if (!existing) {
      throw new Error(`No OAuth token found for user ${userId} provider ${provider}`);
    }

    // If not expired yet (with 60s buffer), return as-is
    const bufferMs = 60 * 1000;
    if (existing.expiresAt.getTime() > Date.now() + bufferMs) {
      return existing;
    }

    // Token is expired or about to expire — refresh it
    const refreshed = await refreshAccessToken(this.oauthConfig, existing.refreshToken);

    // Persist the new access token
    await this.repo.updateAccessToken(
      userId,
      provider,
      refreshed.accessToken,
      refreshed.expiresAt,
    );

    return {
      ...refreshed,
      refreshToken: existing.refreshToken,
    };
  }
}
