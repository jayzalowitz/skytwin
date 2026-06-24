import type { OAuthTokenSet } from '@skytwin/shared-types';
import { generatePkcePair, type PkcePair } from './google-oauth.js';

/**
 * Microsoft Entra (Azure AD) OAuth 2.0 — the foundation for connecting
 * Outlook mail + calendar via Microsoft Graph. Mirrors `google-oauth.ts`:
 * pure, transport-only functions returning the shared `OAuthTokenSet`, with
 * no DB / route concerns, so it unit-tests against a mocked `fetch`.
 *
 * PKCE generation is provider-agnostic, so it's reused from `google-oauth`.
 *
 * Key differences from Google, all handled here:
 *   - Endpoints are tenant-scoped: `/{tenant}/oauth2/v2.0/...`. `common`
 *     (default) accepts both personal Outlook.com and work/school accounts.
 *   - A refresh token is granted via the `offline_access` scope, NOT via
 *     Google's `access_type=offline` query param.
 *   - Microsoft does NOT rotate the refresh token on every refresh; we reuse
 *     the stored one unless the response returns a new value.
 *   - Microsoft has no simple token-revocation endpoint like Google's
 *     `/revoke`; disconnect is "delete the stored token" (see note below).
 */
export interface MicrosoftOAuthConfig {
  clientId: string;
  /**
   * Empty string ('') means PKCE / public-client mode (no shared secret) —
   * the right mode for an installed desktop client. A non-empty secret is the
   * confidential web-server flow. Same contract as the Google module.
   */
  clientSecret: string;
  redirectUri: string;
  /**
   * Microsoft Entra tenant. `common` (default) supports both personal
   * Outlook.com accounts and work/school Microsoft 365 accounts; a specific
   * tenant id locks the flow to one organization.
   */
  tenant?: string;
}

export type { PkcePair };
export { generatePkcePair };

const DEFAULT_TENANT = 'common';

/**
 * How Microsoft grants a refresh token. Google uses `access_type=offline`;
 * Microsoft requires this scope instead. We add it automatically so callers
 * can't accidentally request an access-only grant that breaks background sync.
 */
const OFFLINE_ACCESS_SCOPE = 'offline_access';

/** Convenience Graph scopes for the Outlook connector (read-only). */
export const MICROSOFT_GRAPH_SCOPES = {
  userRead: 'User.Read',
  mailRead: 'Mail.Read',
  calendarsRead: 'Calendars.Read',
} as const;

function tenantOf(config: MicrosoftOAuthConfig): string {
  return config.tenant && config.tenant.length > 0 ? config.tenant : DEFAULT_TENANT;
}

function authBase(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

function withOfflineAccess(scopes: string[]): string[] {
  return scopes.includes(OFFLINE_ACCESS_SCOPE) ? scopes : [...scopes, OFFLINE_ACCESS_SCOPE];
}

/**
 * Build a Microsoft authorization URL. PKCE params attach when a
 * `codeChallenge` is supplied (use this whenever the matching `exchangeCode`
 * won't have a `clientSecret`). `offline_access` is force-added so the grant
 * always yields a refresh token.
 */
export function generateAuthUrl(
  config: MicrosoftOAuthConfig,
  scopes: string[],
  state?: string,
  codeChallenge?: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: withOfflineAccess(scopes).join(' '),
    prompt: 'consent',
  });
  if (state) {
    params.set('state', state);
  }
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${authBase(tenantOf(config))}/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens. Confidential mode passes
 * `clientSecret`; PKCE mode passes the `codeVerifier` from the matching
 * /authorize call. Mixing the two is rejected by Microsoft — pick one per
 * flow, same as Google.
 */
export async function exchangeCode(
  config: MicrosoftOAuthConfig,
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
      'Microsoft OAuth: either clientSecret (confidential client) or codeVerifier (PKCE) is required.',
    );
  }

  const response = await fetch(`${authBase(tenantOf(config))}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Microsoft OAuth token exchange failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
    provider: 'microsoft',
  };
}

/**
 * Error indicating the refresh token is permanently invalid (re-auth needed)
 * vs. a transient failure worth retrying. Mirrors the Google module's
 * classification (4xx auth errors are permanent).
 */
export class MicrosoftOAuthRefreshError extends Error {
  readonly statusCode: number;
  readonly permanent: boolean;

  constructor(statusCode: number, detail: string) {
    const permanent = statusCode === 400 || statusCode === 401 || statusCode === 403;
    super(
      `Microsoft OAuth token refresh failed (${permanent ? 'permanent' : 'transient'}): ${statusCode} ${detail}`,
    );
    this.name = 'MicrosoftOAuthRefreshError';
    this.statusCode = statusCode;
    this.permanent = permanent;
  }
}

/**
 * Refresh an expired access token. Microsoft does not rotate refresh tokens
 * by default, so we keep the stored one unless the response returns a new
 * value (some conditional-access configs do rotate).
 */
export async function refreshAccessToken(
  config: MicrosoftOAuthConfig,
  refreshToken: string,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    grant_type: 'refresh_token',
  });
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }

  const response = await fetch(`${authBase(tenantOf(config))}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new MicrosoftOAuthRefreshError(response.status, errorText);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    // Non-rotating by default — fall back to the token we already hold.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
    provider: 'microsoft',
  };
}
