import type { OAuthTokenSet } from '@skytwin/shared-types';

/**
 * Port interface for persisting and refreshing OAuth tokens.
 */
export interface OAuthTokenStore {
  getToken(userId: string, provider: string): Promise<OAuthTokenSet | null>;
  saveToken(userId: string, provider: string, tokenSet: OAuthTokenSet): Promise<void>;
  deleteToken(userId: string, provider: string): Promise<void>;
  refreshIfExpired(userId: string, provider: string): Promise<OAuthTokenSet>;
}
