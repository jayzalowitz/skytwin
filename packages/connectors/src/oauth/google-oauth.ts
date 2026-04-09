import type { OAuthTokenSet } from '@skytwin/shared-types';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Generate a Google OAuth2 authorization URL.
 */
export function generateAuthUrl(
  config: GoogleOAuthConfig,
  scopes: string[],
  state?: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  if (state) {
    params.set('state', state);
  }
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
): Promise<OAuthTokenSet> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google OAuth token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope.split(' '),
    provider: 'google',
  };
}

/**
 * Error indicating that the OAuth refresh token is permanently invalid.
 * The user must re-authorize — retrying will not help.
 */
export class OAuthRefreshError extends Error {
  readonly statusCode: number;
  readonly permanent: boolean;

  constructor(statusCode: number, detail: string) {
    const permanent = statusCode === 400 || statusCode === 401 || statusCode === 403;
    super(`Google OAuth token refresh failed (${permanent ? 'permanent' : 'transient'}): ${statusCode} ${detail}`);
    this.name = 'OAuthRefreshError';
    this.statusCode = statusCode;
    this.permanent = permanent;
  }
}

/**
 * Refresh an expired access token using a refresh token.
 */
export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<OAuthTokenSet> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new OAuthRefreshError(response.status, errorText);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken, // refresh token doesn't change on refresh
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope.split(' '),
    provider: 'google',
  };
}

/**
 * Revoke a token (access or refresh).
 */
export async function revokeToken(token: string): Promise<void> {
  const response = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google OAuth token revocation failed: ${response.status} ${errorText}`);
  }
}
