import type { OAuthTokenSet } from '@skytwin/shared-types';
import { createHash, randomBytes } from 'node:crypto';

export interface GoogleOAuthConfig {
  clientId: string;
  /**
   * Empty string ('') means "use PKCE" — the OAuth flow becomes a public-
   * client flow (no shared secret). That's the right mode for installed
   * apps: SkyTwin desktop ships one verified `clientId` that's safe to
   * reveal (client IDs are designed to be public), and PKCE binds the
   * authorization code to a per-flow code_verifier instead of to a
   * baked-in secret. Confidential web-server deployments keep using the
   * non-empty form, which uses `client_secret`.
   */
  clientSecret: string;
  redirectUri: string;
}

/**
 * PKCE pair generated at /authorize and consumed at /callback. The
 * verifier never leaves the server; only the (S256-hashed) challenge
 * goes to Google. That's the whole point of PKCE — an attacker who
 * intercepts the redirect can't redeem the code without the verifier.
 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Generate a PKCE pair (RFC 7636 §4). 32 random bytes → 43-char URL-safe
 * base64. Google accepts verifiers from 43 to 128 characters; 43 is the
 * minimum-length sweet spot.
 */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Generate a Google OAuth2 authorization URL.
 *
 * When `codeChallenge` is provided, we attach S256-style PKCE params and
 * Google enforces a matching `code_verifier` at the token-exchange step.
 * Use PKCE whenever the corresponding `exchangeCode` call won't have a
 * client_secret (the desktop "Installed application" client type).
 */
export function generateAuthUrl(
  config: GoogleOAuthConfig,
  scopes: string[],
  state?: string,
  codeChallenge?: string,
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
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 *
 * Confidential mode (web servers): pass `clientSecret` on the config.
 * Public/PKCE mode (desktop installs): pass an empty `clientSecret` and
 * supply the `codeVerifier` from the matching /authorize call. Google
 * rejects requests that mix the two — pick one consistently per flow.
 */
export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
  codeVerifier?: string,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  } else if (codeVerifier) {
    body.set('code_verifier', codeVerifier);
  } else {
    throw new Error(
      'Google OAuth: either clientSecret (confidential client) or codeVerifier (PKCE) is required.',
    );
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
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
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    grant_type: 'refresh_token',
  });
  // PKCE/public clients (installed apps) don't ship a client_secret to
  // Google's token endpoint — including an empty string would 400. Only
  // confidential web-server flows send the secret on refresh.
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
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
