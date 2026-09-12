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
const MAX_REFRESH_RESPONSE_BYTES = 16 * 1024;
const MAX_REFRESH_SCOPES = 128;
const MAX_REFRESH_SCOPE_LENGTH = 512;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleOAuthRefreshTransportOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /**
   * The exact scopes on the persisted grant. RFC 6749 permits a refresh
   * response to omit `scope` when the grant is unchanged, so callers that
   * own the persisted credential may supply that authority snapshot.
   */
  persistedScopes?: readonly string[];
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort resource cleanup must not expose provider response detail.
  }
}

async function readBoundedJsonBody(response: Response): Promise<unknown | null> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json') {
    await cancelResponseBody(response);
    return null;
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 ||
        parsedLength > MAX_REFRESH_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      return null;
    }
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_REFRESH_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function snapshotScopes(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        value.length < 1 || value.length > MAX_REFRESH_SCOPES) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors);
    if (names.length !== value.length + 1 || !names.includes('length')) return null;
    const scopes: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      const scope = descriptor.value as unknown;
      if (typeof scope !== 'string' || scope.length === 0 ||
          scope.length > MAX_REFRESH_SCOPE_LENGTH || seen.has(scope)) return null;
      seen.add(scope);
      scopes.push(scope);
    }
    return scopes;
  } catch {
    return null;
  }
}

function snapshotRefreshResponse(
  value: unknown,
  persistedScopes: readonly string[] | null | undefined,
): {
  accessToken: string;
  expiresIn: number;
  scopes: string[];
} | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    if (names.length > 32 || !names.includes('access_token') ||
        !names.includes('expires_in') || !names.includes('token_type')) {
      return null;
    }
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
    }
    const accessToken = descriptors['access_token']!.value as unknown;
    const expiresIn = descriptors['expires_in']!.value as unknown;
    const tokenType = descriptors['token_type']!.value as unknown;
    if (typeof accessToken !== 'string' || accessToken.length === 0 ||
        accessToken.length > MAX_REFRESH_RESPONSE_BYTES ||
        !Number.isSafeInteger(expiresIn) || (expiresIn as number) < 1 ||
        (expiresIn as number) > 7 * 24 * 60 * 60 ||
        typeof tokenType !== 'string' || !/^[Bb][Ee][Aa][Rr][Ee][Rr]$/.test(tokenType)) return null;
    const scopeDescriptor = descriptors['scope'];
    let scopes: string[] | null;
    if (scopeDescriptor) {
      const scope = scopeDescriptor.value as unknown;
      if (typeof scope !== 'string' || scope.length === 0 ||
          scope.length > MAX_REFRESH_RESPONSE_BYTES) return null;
      scopes = snapshotScopes(scope.split(' '));
    } else {
      scopes = persistedScopes === null || persistedScopes === undefined
        ? null
        : [...persistedScopes];
    }
    if (!scopes) return null;
    return { accessToken, expiresIn: expiresIn as number, scopes };
  } catch {
    return null;
  }
}

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
  readonly errorCode: string | null;

  constructor(statusCode: number, detail: string, errorCode: string | null = null) {
    const permanent = statusCode === 400 || statusCode === 401 || statusCode === 403;
    super(`Google OAuth token refresh failed (${permanent ? 'permanent' : 'transient'}): ${statusCode} ${detail}`);
    this.name = 'OAuthRefreshError';
    this.statusCode = statusCode;
    this.permanent = permanent;
    this.errorCode = errorCode;
  }
}

function snapshotOAuthErrorCode(value: unknown): string | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length > 32) return null;
    for (const descriptor of Object.values(descriptors)) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
    }
    const code = descriptors['error']?.value as unknown;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Refresh an expired access token using a refresh token.
 */
export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  transport: GoogleOAuthRefreshTransportOptions = {},
): Promise<OAuthTokenSet> {
  // Snapshot caller-owned options before the first await. An omitted provider
  // scope may only inherit the exact, validated persisted grant supplied here.
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const persistedScopesInput = transport.persistedScopes;
  const persistedScopes = persistedScopesInput === undefined
    ? undefined
    : snapshotScopes(persistedScopesInput);
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
  const timeoutMs = transport.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Google OAuth refresh timeout must be between 1 and 60000 milliseconds.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let data: ReturnType<typeof snapshotRefreshResponse>;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200) {
      let errorCode: string | null = null;
      try {
        errorCode = snapshotOAuthErrorCode(await readBoundedJsonBody(response));
      } catch {
        await cancelResponseBody(response);
      }
      const detail = errorCode ? JSON.stringify({ error: errorCode }) : 'provider rejected refresh';
      throw new OAuthRefreshError(response.status, detail, errorCode);
    }
    data = snapshotRefreshResponse(await readBoundedJsonBody(response), persistedScopes);
    if (!data) throw new OAuthRefreshError(200, 'invalid provider response');
  } catch (error) {
    if (error instanceof OAuthRefreshError) throw error;
    throw new Error('Google OAuth token refresh transport unavailable.');
  } finally {
    clearTimeout(timeout);
  }

  return {
    accessToken: data.accessToken,
    refreshToken, // refresh token doesn't change on refresh
    expiresAt: new Date(Date.now() + data.expiresIn * 1000),
    scopes: data.scopes,
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
