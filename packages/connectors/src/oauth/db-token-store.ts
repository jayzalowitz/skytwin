import type { OAuthTokenSet } from '@skytwin/shared-types';
import type { OAuthTokenStore } from './token-store.js';
import type { GoogleOAuthConfig } from './google-oauth.js';
import { refreshAccessToken } from './google-oauth.js';

/**
 * Interface matching the @skytwin/db oauthRepository shape.
 * Defined here to avoid a direct dependency on the DB package from connectors.
 */
interface OAuthRepositoryLike {
  getToken(userId: string, provider: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scopes: string[];
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
}

/**
 * OAuthTokenStore implementation backed by a database repository.
 *
 * Bridges the connectors package's OAuthTokenStore port to the
 * @skytwin/db oauthRepository. Handles automatic token refresh
 * when access tokens are expired.
 */
export class DbTokenStore implements OAuthTokenStore {
  constructor(
    private readonly repo: OAuthRepositoryLike,
    private readonly oauthConfig: GoogleOAuthConfig,
  ) {}

  async getToken(userId: string, provider: string): Promise<OAuthTokenSet | null> {
    const row = await this.repo.getToken(userId, provider);
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      scopes: row.scopes,
      provider: provider as OAuthTokenSet['provider'],
    };
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
