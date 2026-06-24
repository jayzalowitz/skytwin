import { Router } from 'express';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { createLogger } from '@skytwin/core';
import { loadConfig } from '@skytwin/config';
import { withTransaction } from '@skytwin/db';

const log = createLogger('api:oauth');
import {
  oauthRepository,
  oauthPkcePendingRepository,
  oauthPendingSigninRepository,
  serviceCredentialRepository,
  userRepository,
} from '@skytwin/db';
import { hashToken } from '../middleware/session-auth.js';
import {
  generateAuthUrl,
  generatePkcePair,
  exchangeCode,
  revokeToken,
  fetchGoogleProfileSync,
  microsoftOAuth,
  MICROSOFT_GRAPH_SCOPES,
} from '@skytwin/connectors';
import type { GoogleOAuthConfig, MicrosoftOAuthConfig } from '@skytwin/connectors';
import { sessionAuth } from '../middleware/session-auth.js';
import { requireOwnership } from '../middleware/require-ownership.js';

/**
 * Secret used to HMAC-sign OAuth state. Reuses SESSION_SECRET (same secret
 * the session middleware hashes bearer tokens with) so deployments don't
 * have to manage a second secret.
 */
const STATE_SECRET = process.env['SESSION_SECRET'] ?? 'skytwin-dev-secret';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for the consent screen
const STATE_VERSION = 'v2';

/**
 * Rate limit for the public /google/authorize?newUser=true path. Anyone can
 * hit it (it's the front door for sign-in-with-Google), so without a cap an
 * attacker could mint authorize URLs in a loop and/or burn the project's
 * Google OAuth quota. Per-IP, sliding minute window.
 */
export const NEW_USER_RATE_LIMIT_MAX = 5;
export const NEW_USER_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/**
 * Limit for the pendingKey poll endpoint. The client polls every 2s for
 * up to 5 minutes (= 150 hits/flow); a legit user hitting it from one IP
 * can therefore burn ~30 requests/minute, plus a few from /authorize and
 * /status calls. The cap is loose to keep the poll loop alive while still
 * making brute force / DoS expensive — the UUIDv4 shape gate is the
 * real defence against enumeration, and the random 122 bits put brute
 * force well past line rate anyway.
 */
export const PENDING_POLL_RATE_LIMIT_MAX = 120;
export const PENDING_POLL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/**
 * Bucket cap. Without this the Map grows once per unique attacker IP and
 * never shrinks — a real source of slow memory growth in long-running
 * processes. When we hit the cap we sweep expired buckets first, then drop
 * the oldest insertion-order entry. The constant is loose: we never expect
 * thousands of legitimate IPs hitting `?newUser=true` per process.
 */
export const NEW_USER_RATE_LIMIT_MAX_BUCKETS = 5_000;
const newUserRateBuckets = new Map<string, { count: number; resetAt: number }>();
const pendingPollRateBuckets = new Map<string, { count: number; resetAt: number }>();

function evictExpiredBuckets(
  buckets: Map<string, { count: number; resetAt: number }>,
  now: number,
): void {
  for (const [ip, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(ip);
  }
}

function checkBucket(
  buckets: Map<string, { count: number; resetAt: number }>,
  ip: string,
  now: number,
  max: number,
  windowMs: number,
): { allowed: boolean; resetAt: number } {
  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    // Pre-emptively evict when at the cap so the Map can't grow without
    // bound across many distinct IPs (the leak class motivating this).
    if (buckets.size >= NEW_USER_RATE_LIMIT_MAX_BUCKETS) {
      evictExpiredBuckets(buckets, now);
      while (buckets.size >= NEW_USER_RATE_LIMIT_MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, bucket);
  }
  if (bucket.count >= max) {
    return { allowed: false, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return { allowed: true, resetAt: bucket.resetAt };
}

export function checkNewUserRateLimit(
  ip: string,
  now: number = Date.now(),
): { allowed: boolean; resetAt: number } {
  return checkBucket(
    newUserRateBuckets,
    ip,
    now,
    NEW_USER_RATE_LIMIT_MAX,
    NEW_USER_RATE_LIMIT_WINDOW_MS,
  );
}

/**
 * Separate bucket from /authorize so the pendingKey poll loop (30 hits
 * per minute, 5 minutes per flow) can't starve itself by sharing the
 * ?newUser=true bucket's tight 5/minute limit. A poll-friendly 120/min
 * leaves comfortable headroom for jitter and retries.
 */
export function checkPendingPollRateLimit(
  ip: string,
  now: number = Date.now(),
): { allowed: boolean; resetAt: number } {
  return checkBucket(
    pendingPollRateBuckets,
    ip,
    now,
    PENDING_POLL_RATE_LIMIT_MAX,
    PENDING_POLL_RATE_LIMIT_WINDOW_MS,
  );
}

/** Test helper — clears all rate-limit buckets between cases. */
export function _resetNewUserRateLimitForTests(): void {
  newUserRateBuckets.clear();
  pendingPollRateBuckets.clear();
}

/** Test/observability helper: current bucket count. */
export function _newUserRateLimitBucketCountForTests(): number {
  return newUserRateBuckets.size;
}

/**
 * Google's userinfo response. We don't depend on the Google SDK so this is
 * just the fields we read after a successful token exchange.
 */
interface GoogleUserInfo {
  id: string; // stable account id (sub)
  email: string;
  verified_email?: boolean;
  name?: string;
  picture?: string;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<GoogleUserInfo>;
}

/** Microsoft Graph `/me` identity — the fields we key the token row on. */
export interface MicrosoftUserInfo {
  id: string;
  email: string;
  name?: string;
}

/**
 * Resolve the connected Microsoft identity via Graph `/me`. Personal
 * (Outlook.com) accounts frequently have a `null` `mail`, so we fall back to
 * `userPrincipalName` — both are the account's verified Entra identity (there
 * is no separate "verified_email" step like Google's; the Entra account IS
 * the verified identity, so no impersonation check is needed here).
 */
export async function fetchMicrosoftUserInfo(accessToken: string): Promise<MicrosoftUserInfo> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph /me failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    id: string;
    mail?: string | null;
    userPrincipalName?: string;
    displayName?: string;
  };
  const email =
    typeof data.mail === 'string' && data.mail.length > 0
      ? data.mail
      : typeof data.userPrincipalName === 'string'
        ? data.userPrincipalName
        : '';
  return { id: data.id, email, name: data.displayName };
}

/**
 * State carries the caller's intent across the OAuth round-trip and is
 * HMAC-signed so the public /google/callback endpoint can't be spoofed.
 *
 * Wire format: `v2.<payload>.<expiresAtMs>.<hmacHex>` where the hmac
 * covers `<payload>.<expiresAtMs>`.
 *
 * Payload is the original pipe-delimited intent string:
 *   <userId>                       associate token with this existing user
 *   <userId>|desktop               same, OAuth opened from Electron
 *   <userId>|new                   adding another account to this user
 *   <userId>|next=connect-gmail    redirect to /#/connect-gmail post-callback
 *   new                            no user yet — auto-create from verified email
 *   new|desktop
 *   new|next=connect-gmail
 *
 * Without the signature, an attacker could mint their own Google
 * authorization code and call /google/callback with state=<victim-id>
 * to attach their account to someone else's user.
 *
 * The `next` tag is whitelisted server-side (see NEXT_HASH_ROUTES). It's
 * NOT a free-form URL — that would be an open-redirect waiting to happen.
 * Each entry maps to a fixed dashboard hash route. The onboarding wizard
 * uses this to deep-link straight into the Gmail walkthrough instead of
 * dropping the user on the dashboard CTA.
 */
interface ParsedState {
  userId: string | null; // null = auto-create user from email
  desktop: boolean;
  newAccount: boolean;
  /** Dashboard hash route to land on post-callback, or null for the default `#/`. */
  nextHash: string | null;
  /**
   * Client-generated pollable handoff key for desktop new-user flows.
   * `/callback` writes the resulting userId + scopes to
   * `oauth_pending_signin` keyed by this value so the desktop wizard
   * can poll `GET /api/oauth/google/pending/:key` and auto-advance.
   *
   * Format is validated up-front (UUID4) so an attacker can't smuggle a
   * shaped string that misroutes the polling endpoint. Null for any
   * non-desktop flow.
   */
  pendingKey: string | null;
}

/**
 * Whitelist of allowed `next=` values and the dashboard hash route each
 * maps to. Free-form redirect targets are NEVER accepted — that's an
 * open-redirect vulnerability.
 */
export const NEXT_HASH_ROUTES: Record<string, string> = {
  'connect-gmail': '#/connect-gmail',
};

/**
 * Conservative UUIDv4 shape check — 8-4-4-4-12 lowercase hex with the
 * version (4) + variant (8|9|a|b) nibbles pinned. We do NOT need
 * cryptographic-grade validation here; the goal is to reject strings
 * that contain SQL metacharacters, path traversal, or other shapes
 * before they hit the state payload. crypto.randomUUID() emits this
 * exact shape; anything else is bad input.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isValidPendingKey(value: string): boolean {
  return UUID_V4_RE.test(value);
}

function signStatePayload(payload: string, expiresAtMs: number): string {
  const mac = createHmac('sha256', STATE_SECRET)
    .update(`${payload}.${expiresAtMs}`)
    .digest('hex');
  return `${STATE_VERSION}.${payload}.${expiresAtMs}.${mac}`;
}

class InvalidStateError extends Error {
  constructor(reason: string) {
    super(`Invalid OAuth state: ${reason}`);
  }
}

function parseSignedState(state: string): ParsedState {
  const parts = state.split('.');
  if (parts.length !== 4 || parts[0] !== STATE_VERSION) {
    throw new InvalidStateError('unrecognised format');
  }
  const [, payload, expiresAtRaw, providedMac] = parts as [string, string, string, string];

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs)) {
    throw new InvalidStateError('expiry not a number');
  }

  const expectedMac = createHmac('sha256', STATE_SECRET)
    .update(`${payload}.${expiresAtMs}`)
    .digest('hex');

  // Constant-time compare so we don't leak the secret one byte at a time.
  const providedBuf = Buffer.from(providedMac, 'hex');
  const expectedBuf = Buffer.from(expectedMac, 'hex');
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new InvalidStateError('signature mismatch');
  }

  if (Date.now() > expiresAtMs) {
    throw new InvalidStateError('expired');
  }

  const head = payload.split('|')[0];
  const rawTags = payload.split('|').slice(1);
  const tags = new Set(rawTags);
  // Decode `next=<route>` tag. We re-validate against the whitelist on
  // read so a state token issued before a route was retired can't suddenly
  // redirect somewhere unexpected. hasOwnProperty.call() (not bracket
  // lookup) so a value like `constructor` or `__proto__` can't reach the
  // inherited Object property and slip past the truthy check.
  let nextHash: string | null = null;
  // Decode `key=<uuid>` tag — the pendingKey for the desktop newUser
  // poll handoff. UUID-shape re-validated on read so a tampered tag
  // can't write a non-UUID value into `oauth_pending_signin` (the
  // table column is TEXT for portability; the constraint lives in
  // application code).
  let pendingKey: string | null = null;
  for (const t of rawTags) {
    if (t.startsWith('next=')) {
      const candidate = t.slice('next='.length);
      if (Object.prototype.hasOwnProperty.call(NEXT_HASH_ROUTES, candidate)) {
        nextHash = NEXT_HASH_ROUTES[candidate] ?? null;
      }
    } else if (t.startsWith('key=')) {
      const candidate = t.slice('key='.length);
      if (isValidPendingKey(candidate)) {
        pendingKey = candidate;
      }
    }
  }
  return {
    userId: head === 'new' ? null : (head ?? null),
    desktop: tags.has('desktop'),
    newAccount: tags.has('new'),
    nextHash,
    pendingKey,
  };
}

/** Test-only exports for the signed-state helpers. Not used in the route handler. */
export const _signStatePayloadForTests = signStatePayload;
export const _parseSignedStateForTests = parseSignedState;
export const _stateTtlMsForTests = STATE_TTL_MS;

/**
 * `openid` + `email` are required for the userinfo endpoint to return the
 * verified email used as the per-account row key. `profile` gives us a
 * display name for auto-created users so they don't show up as raw UUIDs
 * in the dashboard.
 */
/**
 * Source of the Google OAuth config currently in use. Drives the
 * tier-gating below: only `userSupplied` configs can request the
 * restricted Gmail scopes, because the bundled client is intentionally
 * NOT submitted for Google's restricted-scope security assessment
 * (that's a $15k–$50k annual third-party CASA audit we don't want to
 * pay for at launch). The same OAuth code path serves both tiers.
 */
type GoogleConfigSource = 'user-supplied' | 'bundled' | 'unset';

interface ResolvedGoogleConfig extends GoogleOAuthConfig {
  source: GoogleConfigSource;
}

/**
 * Build the Google OAuth config. Three sources, in priority order:
 *   1. User-supplied credentials in the DB (Setup page) — wins. These
 *      come from a Google Cloud OAuth client the user created in their
 *      own GCP project. Google does NOT require app verification for
 *      a user's own OAuth client used only by themselves, so this is
 *      how we light up Gmail (restricted-scope) without a SkyTwin-side
 *      security assessment.
 *   2. Confidential-client env vars (`GOOGLE_CLIENT_ID`/`_SECRET`) —
 *      the self-hosted/ops path. Operator-owned clients also count as
 *      user-supplied for tier-gating purposes.
 *   3. PKCE-only default client_id baked into the desktop bundle
 *      (`SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID`). The SkyTwin team owns
 *      this client; it is verified by Google for identity + calendar
 *      scopes only, so the bundled flow CANNOT request Gmail.
 *
 * `clientSecret` is the literal empty string in PKCE mode — downstream
 * code keys on `secret === ''` to choose the PKCE token-exchange
 * variant. Don't normalise it to undefined; the empty string is
 * load-bearing.
 */
async function resolveGoogleConfig(): Promise<ResolvedGoogleConfig> {
  const config = loadConfig();

  // Layer 1: env vars (operator-supplied, self-hosted ops path).
  let clientId = config.googleClientId;
  let clientSecret = config.googleClientSecret;
  let redirectUri = config.googleRedirectUri;
  let source: GoogleConfigSource = clientId ? 'user-supplied' : 'unset';

  // Layer 2: DB-stored credentials from the Setup page take priority
  // over env vars and over the bundled default. Falls through silently
  // when the service_credentials table doesn't exist yet.
  try {
    const dbCreds = await serviceCredentialRepository.getAsMap('google');
    if (dbCreds['client_id']) {
      clientId = dbCreds['client_id'];
      source = 'user-supplied';
    }
    if (dbCreds['client_secret']) clientSecret = dbCreds['client_secret'];
    if (dbCreds['redirect_uri'] && redirectUri === 'http://localhost:3100/api/oauth/google/callback') {
      redirectUri = dbCreds['redirect_uri'];
    }
  } catch {
    // No service_credentials table yet — fall through.
  }

  // Layer 3: PKCE-only default (desktop bundle). Used iff neither env
  // vars nor DB supplied a clientId. Marked source: 'bundled' so the
  // /authorize handler can reject ?include=gmail requests until the
  // user wires their own OAuth client via Setup.
  if (!clientId) {
    const bundled = process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'] ?? '';
    if (bundled) {
      clientId = bundled;
      clientSecret = '';
      source = 'bundled';
    }
  }

  return { clientId, clientSecret, redirectUri, source };
}

// ── Microsoft (Entra) OAuth config ──────────────────────────────────────────
type MicrosoftConfigSource = 'user-supplied' | 'bundled' | 'unset';

interface ResolvedMicrosoftConfig extends MicrosoftOAuthConfig {
  source: MicrosoftConfigSource;
}

const DEFAULT_MICROSOFT_REDIRECT_URI = 'http://localhost:3100/api/oauth/microsoft/callback';

/**
 * Resolve the Microsoft OAuth config from ENV only (no DB) — the pure,
 * unit-testable core of `resolveMicrosoftConfig`. Mirrors the Google
 * resolver's env+bundled precedence: operator-supplied
 * `MICROSOFT_CLIENT_ID`/`_SECRET` win, else the PKCE-only bundled default
 * (`SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID`). `clientSecret: ''` is load-bearing
 * (selects the PKCE token-exchange variant). Default-on-launch is
 * user-supplied — SkyTwin ships no bundled Microsoft client unless the env
 * var is set, so connecting Outlook means bringing your own Entra app.
 */
export function resolveMicrosoftEnvConfig(env: NodeJS.ProcessEnv = process.env): ResolvedMicrosoftConfig {
  const tenant = env['MICROSOFT_TENANT'] && env['MICROSOFT_TENANT'].length > 0 ? env['MICROSOFT_TENANT'] : 'common';
  const redirectUri = env['MICROSOFT_REDIRECT_URI'] ?? DEFAULT_MICROSOFT_REDIRECT_URI;

  const envClientId = env['MICROSOFT_CLIENT_ID'] ?? '';
  if (envClientId) {
    return { clientId: envClientId, clientSecret: env['MICROSOFT_CLIENT_SECRET'] ?? '', redirectUri, tenant, source: 'user-supplied' };
  }
  const bundled = env['SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID'] ?? '';
  if (bundled) {
    return { clientId: bundled, clientSecret: '', redirectUri, tenant, source: 'bundled' };
  }
  return { clientId: '', clientSecret: '', redirectUri, tenant, source: 'unset' };
}

/**
 * Resolve the Microsoft OAuth config: ENV/bundled (above) overlaid with
 * DB-stored Setup credentials (`service_credentials` provider='microsoft'),
 * which take priority — same layering as Google.
 */
async function resolveMicrosoftConfig(): Promise<ResolvedMicrosoftConfig> {
  const cfg = resolveMicrosoftEnvConfig();
  try {
    const dbCreds = await serviceCredentialRepository.getAsMap('microsoft');
    if (dbCreds['client_id']) {
      cfg.clientId = dbCreds['client_id'];
      cfg.source = 'user-supplied';
    }
    if (dbCreds['client_secret']) cfg.clientSecret = dbCreds['client_secret'];
    if (dbCreds['redirect_uri']) cfg.redirectUri = dbCreds['redirect_uri'];
    if (dbCreds['tenant']) cfg.tenant = dbCreds['tenant'];
  } catch {
    // No service_credentials table yet — fall through to env/bundled.
  }
  return cfg;
}

/**
 * Scope tiers. The split exists for two reasons:
 *
 *   1. Google classifies Gmail's `readonly`/`modify` as **restricted**
 *      scopes — requesting them in a published OAuth client means
 *      passing the annual CASA Tier 2/3 security assessment ($15k–$50k,
 *      4–8 weeks). Calendar's `readonly`/`events` are **sensitive** but
 *      not restricted — just normal app review, no assessor fee.
 *
 *   2. Most users only need calendar + identity to get value from the
 *      twin (scheduling, meeting suggestions). Forcing the Gmail
 *      consent prompt on those users is unnecessary friction even when
 *      we *do* have the bundled client verified for Gmail.
 *
 * Stage 1 (now): the bundled SkyTwin-team client is verified for
 *   IDENTITY + CALENDAR. Users who want Gmail features paste their own
 *   OAuth credentials into Setup; their own GCP project + their own
 *   email as a test user → no app verification needed.
 *
 * Stage 2 (post-launch, when revenue funds the audit): submit the
 *   bundled client through CASA. The code below stays the same — the
 *   gate just turns into "always allow Gmail with bundled" once Google
 *   updates the verification status. Document the rollout in
 *   docs/google-verification.md.
 */
const IDENTITY_SCOPES_LIST = ['openid', 'email', 'profile'];

const GMAIL_SCOPES_LIST = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const CALENDAR_SCOPES_LIST = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * Compute the scope set for an authorize request given the config
 * source and the caller's opt-in flags. Returns the granted scope list
 * AND a list of skipped capabilities the caller should surface to the
 * UI (so the dashboard can show "Connect Gmail" as a follow-up CTA
 * rather than silently lying about coverage).
 */
export function resolveRequestedScopes(opts: {
  source: GoogleConfigSource;
  includeGmail: boolean;
}): { scopes: string[]; skipped: Array<{ capability: 'gmail'; reason: string }> } {
  const scopes = [...IDENTITY_SCOPES_LIST, ...CALENDAR_SCOPES_LIST];
  const skipped: Array<{ capability: 'gmail'; reason: string }> = [];

  if (opts.includeGmail) {
    if (opts.source === 'user-supplied') {
      scopes.push(...GMAIL_SCOPES_LIST);
    } else {
      skipped.push({
        capability: 'gmail',
        reason: 'bundled-client-not-verified-for-restricted-scopes',
      });
    }
  }

  return { scopes, skipped };
}

/**
 * Pending PKCE verifiers live in `oauth_pkce_pending` (migration 058).
 * DB-backed so a desktop restart between /authorize and /callback doesn't
 * drop the verifier and 400 the user mid-flow. The verifier never leaves
 * the server — that's the whole reason PKCE exists; storing it on the
 * same CRDB the rest of SkyTwin uses adds no new infrastructure and gives
 * the row a proper TTL.
 *
 * TTL matches STATE_TTL_MS. `remember()` is upsert (re-issued state wins)
 * and `consume()` is a single DELETE...RETURNING so a replayed callback
 * can't redeem the same code twice. We sweep expired rows on every
 * remember() to keep the table bounded even if callbacks never come back
 * (closed browser tab, etc.).
 *
 * Operator note: this requires migration 058 to have run before the API
 * starts serving traffic. Falling back to an in-memory Map would defeat
 * the cross-restart guarantee that's the whole point of the move; if the
 * table is missing, /authorize returns 500 like any other unbootstrapped
 * DB call — which is consistent with the rest of the system.
 */
const PKCE_TTL_MS = 10 * 60 * 1000;
/**
 * TTL for the pending-signin handoff row. The desktop wizard polls at
 * ~2s cadence with its own 5-minute deadline (see google-signin.js
 * pollUntilNewUserCompleted); five minutes here matches that and gives
 * the user time to actually click "Allow" on Google's consent screen.
 */
const PENDING_SIGNIN_TTL_MS = 5 * 60 * 1000;

async function rememberPkceVerifier(state: string, codeVerifier: string): Promise<void> {
  const now = new Date();
  // Best-effort sweep; never block the sign-in path if it fails.
  oauthPkcePendingRepository.sweepExpired(now).catch(() => undefined);
  const expiresAt = new Date(now.getTime() + PKCE_TTL_MS);
  await oauthPkcePendingRepository.remember(state, codeVerifier, expiresAt);
}

async function consumePkceVerifier(state: string): Promise<string | undefined> {
  return oauthPkcePendingRepository.consume(state);
}

/**
 * Create the OAuth router for connecting external accounts.
 */
export function createOAuthRouter(): Router {
  const router = Router();

  // All OAuth management endpoints require an authenticated user except:
  //   - /google/callback                  public (browser redirect from Google)
  //   - /google/authorize?newUser=true    public (sign-in-with-Google)
  //   - /google/pending/:key              public (desktop newUser poll)
  // For the new-user flow there's no session yet, so requiring sessionAuth
  // would 401 before the user could even start consenting. The pending-key
  // endpoint is gated by the unguessable random key — see the route's
  // comment block.
  const isPublicOAuthPath = (req: { path: string; query: Record<string, unknown> }): boolean => {
    if (req.path === '/google/callback') return true;
    if (req.path === '/google/authorize' && req.query['newUser'] === 'true') return true;
    if (req.path.startsWith('/google/pending/')) return true;
    // The Microsoft callback is a browser redirect from Microsoft with no
    // session. It's safe to be public: it acts only on the HMAC-signed state
    // (which binds the flow to the user who started the authenticated
    // /microsoft/authorize), exactly like /google/callback.
    if (req.path === '/microsoft/callback') return true;
    return false;
  };
  router.use((req, res, next) => {
    if (isPublicOAuthPath(req as { path: string; query: Record<string, unknown> })) {
      next();
      return;
    }
    void sessionAuth(req, res, next);
  });
  router.use((req, res, next) => {
    if (isPublicOAuthPath(req as { path: string; query: Record<string, unknown> })) {
      next();
      return;
    }
    void requireOwnership(req, res, next);
  });

  /**
   * GET /api/oauth/google/authorize
   *
   * Returns a Google OAuth authorization URL. Caller may pass:
   *   - userId=<id>           associate the resulting tokens with this user
   *   - newUser=true          no userId — auto-create a user from the
   *                           verified email reported by userinfo
   *   - newAccount=true       force a new account on the existing user (the
   *                           default behaviour, but explicit for clarity)
   *
   * The client redirects the user to the returned `url`.
   */
  router.get('/google/authorize', async (req, res, next) => {
    try {
      const newUser = req.query['newUser'] === 'true';

      // Rate-limit the public new-user variant by IP. The authenticated
      // path is already gated by sessionAuth so it's implicitly throttled
      // by login, but anyone can hit ?newUser=true.
      if (newUser) {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const { allowed, resetAt } = checkNewUserRateLimit(ip, Date.now());
        if (!allowed) {
          res.set('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
          res.status(429).json({
            error: 'Too many sign-in attempts. Try again in a minute.',
            resetAt: new Date(resetAt).toISOString(),
          });
          return;
        }
      }

      const googleConfig = await resolveGoogleConfig();
      // Without ANY configured client_id we can't build an auth URL —
      // Google would reject the user with an opaque "invalid_client". A
      // missing client_secret is OK now (PKCE handles installed-app
      // flows); a missing client_id is fatal. Surface a clean 503 so the
      // dashboard can tell the user to finish Setup or ship a desktop
      // build with SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID baked in.
      if (!googleConfig.clientId) {
        // Tag with a structured code so the dashboard can route to the
        // connect-gmail wizard (the same five-step setup that backs BYO
        // Gmail also works as the universal "supply your own OAuth client"
        // flow). Without the code, the frontend can only show a generic
        // 503 toast — which leaves the user staring at "something went
        // wrong" with no idea how to fix it.
        res.status(503).json({
          error:
            'Google sign-in is not configured. ' +
            "Open the Connect Gmail walkthrough — the same five-step flow sets up Google sign-in for this build, " +
            'or rebuild the desktop with SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID set.',
          code: 'NO_GOOGLE_CLIENT_CONFIGURED',
          help: '#/connect-gmail',
          docs: 'https://jayzalowitz.github.io/skytwin/connect-gmail.html',
        });
        return;
      }
      // ?include=gmail signals the caller wants Gmail scopes added.
      // The default is now identity + calendar only — see the
      // GMAIL_SCOPES_LIST comment for why. If the bundled client is in
      // use, Gmail is silently dropped and `skipped` reports it so the
      // dashboard can render a "Connect Gmail" CTA. The caller can
      // still get Gmail today by pasting their own OAuth credentials
      // into Setup; that's the `source === 'user-supplied'` path.
      const includeGmail = req.query['include'] === 'gmail'
        || req.query['scopes'] === 'gmail'
        || req.query['gmail'] === 'true';

      const { scopes, skipped } = resolveRequestedScopes({
        source: googleConfig.source,
        includeGmail,
      });

      // If the caller explicitly asked for Gmail but we couldn't grant
      // it (bundled client mode), surface a 412 so the dashboard can
      // route to the BYO setup walkthrough instead of silently
      // pretending the scope was granted. 412 (Precondition Failed) is
      // the right semantic: "your config preconditions for this scope
      // aren't met" — distinct from 503 (server-side config missing).
      if (includeGmail && skipped.some((s) => s.capability === 'gmail')) {
        res.status(412).json({
          error: 'Gmail setup needs to finish before SkyTwin can read your inbox.',
          code: 'GMAIL_REQUIRES_BYO_CLIENT',
          // In-app wizard route. The dashboard SPA renders it at
          // /#/connect-gmail (apps/web/public/js/pages/connect-gmail.js)
          // and handles the back-half of the flow (paste credentials,
          // re-trigger OAuth with ?include=gmail). The static external
          // doc at https://jayzalowitz.github.io/skytwin/connect-gmail.html
          // is the public-web mirror for users who hit this URL without
          // the desktop app installed.
          help: '#/connect-gmail',
          docs: 'https://jayzalowitz.github.io/skytwin/connect-gmail.html',
          skipped,
        });
        return;
      }

      const queryUserId =
        typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
      const newAccount = req.query['newAccount'] === 'true';
      const desktop = req.query['desktop'] === 'true';
      // Optional dashboard-deep-link target after the OAuth round-trip.
      // The query value is checked against the whitelist before the tag
      // ever lands in state — an unknown value is silently dropped so we
      // can't be coerced into redirecting to a route that doesn't exist
      // (or worse, an attacker-controlled external URL).
      const nextQuery = typeof req.query['next'] === 'string' ? req.query['next'] : undefined;
      const nextTagValue = nextQuery && Object.prototype.hasOwnProperty.call(NEXT_HASH_ROUTES, nextQuery)
        ? nextQuery
        : undefined;
      // Pollable handoff key for desktop new-user flows. Validated to
      // UUIDv4 shape up-front; anything else is dropped silently so a
      // malformed query param can't poison state.
      const pendingKeyQuery = typeof req.query['pendingKey'] === 'string' ? req.query['pendingKey'] : undefined;
      const pendingKey = pendingKeyQuery && isValidPendingKey(pendingKeyQuery)
        ? pendingKeyQuery
        : undefined;

      let stateHead: string;
      if (newUser) {
        stateHead = 'new';
      } else {
        const userId = queryUserId ?? req.authenticatedUserId;
        if (!userId) {
          res.status(400).json({ error: 'Missing userId. Pass ?userId=… or ?newUser=true.' });
          return;
        }
        stateHead = userId;
      }

      const tags: string[] = [];
      if (desktop) tags.push('desktop');
      if (newAccount) tags.push('new');
      if (nextTagValue) tags.push(`next=${nextTagValue}`);
      if (pendingKey) tags.push(`key=${pendingKey}`);

      const payload = [stateHead, ...tags].join('|');
      const state = signStatePayload(payload, Date.now() + STATE_TTL_MS);

      // PKCE mode when no client_secret. Generate verifier+challenge,
      // stash verifier server-side keyed on the signed state token, send
      // only the challenge to Google. /callback retrieves the verifier
      // by state.
      let codeChallenge: string | undefined;
      if (!googleConfig.clientSecret) {
        const pkce = generatePkcePair();
        await rememberPkceVerifier(state, pkce.codeVerifier);
        codeChallenge = pkce.codeChallenge;
      }

      const url = generateAuthUrl(googleConfig, scopes, state, codeChallenge);
      res.json({ url });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/oauth/google/callback
   *
   * Handles the OAuth callback. Exchanges code for tokens and persists them.
   */
  router.get('/google/callback', async (req, res, next) => {
    try {
      const code = req.query['code'] as string | undefined;
      const state = req.query['state'] as string | undefined;

      if (!code) {
        res.status(400).json({ error: 'Missing authorization code' });
        return;
      }

      if (!state) {
        res.status(400).json({ error: 'Missing state parameter' });
        return;
      }

      let parsed: ParsedState;
      try {
        parsed = parseSignedState(state);
      } catch (err) {
        res.status(400).json({
          error: err instanceof InvalidStateError ? err.message : 'Invalid state',
        });
        return;
      }

      const googleConfig = await resolveGoogleConfig();
      // Recover the PKCE verifier stashed at /authorize. Consume-on-read
      // so a replayed callback can't redeem the same code twice.
      const codeVerifier = await consumePkceVerifier(state);
      if (!googleConfig.clientSecret && !codeVerifier) {
        // In PKCE mode without a stored verifier we'd send an empty
        // code_verifier to Google and get a 400 "invalid_grant".
        // Surface a clear error pointing at the most likely cause: a
        // stale browser tab where /authorize ran against a different
        // process (Electron restart, etc.).
        res.status(400).json({
          error:
            'OAuth verifier expired or missing. Re-start the sign-in flow from the dashboard.',
        });
        return;
      }
      const tokenSet = await exchangeCode(googleConfig, code, codeVerifier);

      // Resolve the verified Google identity so we can key the token row on
      // the actual account email (rather than guessing from state) and
      // optionally materialize a user.
      const userInfo = await fetchGoogleUserInfo(tokenSet.accessToken);
      const accountEmail = typeof userInfo.email === 'string' ? userInfo.email.trim() : '';
      const accountProviderId = userInfo.id;

      if (!accountEmail) {
        res.status(502).json({
          error:
            'Google userinfo did not include an email. Ensure the authorize URL requests "openid email".',
        });
        return;
      }
      // Treat the email as identity only if Google says it's verified —
      // otherwise an attacker could create a Google account with someone
      // else's address and use this flow to attach to or impersonate them.
      if (userInfo.verified_email !== true) {
        res.status(401).json({ error: 'Google account email is not verified.' });
        return;
      }

      // Resolve target userId.
      //
      // Auto-created users start at 'observer' (read-only), matching the
      // interactive POST /api/users path. Users earn 'suggest' via approval
      // feedback through the trust-tier audit pipeline.
      const NEW_USER_TIER = 'observer';

      let userId = parsed.userId;
      if (!userId) {
        // Auto-create or attach to a user keyed on the verified Google email.
        const existing = await userRepository.findByEmail(accountEmail);
        if (existing) {
          userId = existing.id;
        } else {
          const created = await userRepository.create({
            email: accountEmail,
            name: userInfo.name ?? accountEmail,
            trustTier: NEW_USER_TIER,
          });
          userId = created.id;
        }
      } else {
        // Validate that the userId in state actually exists; if not, fall
        // back to auto-create so we don't leave an orphaned token row.
        const existing = await userRepository.findById(userId);
        if (!existing) {
          const byEmail = await userRepository.findByEmail(accountEmail);
          if (byEmail) {
            userId = byEmail.id;
          } else {
            const created = await userRepository.create({
              email: accountEmail,
              name: userInfo.name ?? accountEmail,
              trustTier: NEW_USER_TIER,
            });
            userId = created.id;
          }
        }
      }

      // Persist tokens keyed on (user, provider, account_email).
      await oauthRepository.saveTokenForAccount({
        userId,
        provider: 'google',
        accountEmail,
        accountProviderId,
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken,
        expiresAt: tokenSet.expiresAt,
        scopes: tokenSet.scopes,
      });

      // Profile sync (#486): capture the user's language (Google locale) and
      // timezone (primary calendar) so the briefing prose is in their language
      // and relative deadlines resolve against their clock. Best-effort — a
      // failed sync must never block sign-in, so we never throw out of here.
      // We never silently guess a timezone: when it falls back to UTC we log a
      // warning so the operator can see the gap.
      try {
        const profile = await fetchGoogleProfileSync(tokenSet.accessToken);
        // Only write the non-defaulted fields so a partial sync (e.g. calendar
        // scope not granted) doesn't overwrite a real value with a placeholder.
        const localeUpdate: { language?: string; timezone?: string } = {};
        if (!profile.languageDefaulted) localeUpdate.language = profile.language;
        if (!profile.timezoneDefaulted) localeUpdate.timezone = profile.timezone;
        if (localeUpdate.language !== undefined || localeUpdate.timezone !== undefined) {
          await userRepository.updateLocale(userId, localeUpdate);
        }
        if (profile.timezoneDefaulted) {
          log.warn('Google profile sync: no primary-calendar timezone; left unset (resolves to UTC)', {
            userId,
            accountEmail,
          });
        }
        if (profile.languageDefaulted) {
          log.warn('Google profile sync: no profile locale; left unset (resolves to en)', {
            userId,
            accountEmail,
          });
        }
      } catch (err) {
        log.warn('Google profile sync failed; language/timezone left unset', {
          userId,
          accountEmail,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // If the desktop client supplied a pendingKey (per-flow handoff
      // token), record the completion so the wizard can poll for it.
      // The system browser will show the static "close this tab" HTML
      // below; the Electron app, which has no other way to learn about
      // the user that /callback just created, polls
      // GET /api/oauth/google/pending/:key.
      if (parsed.pendingKey) {
        try {
          // remember() now fires a best-effort sweepExpired internally;
          // the explicit caller-side sweep that used to live here was
          // removed to avoid double-sweeping (was consuming two pool
          // connections per OAuth callback under burst).
          await oauthPendingSigninRepository.remember({
            pendingKey: parsed.pendingKey,
            userId,
            accountEmail,
            scopes: Array.isArray(tokenSet.scopes) ? tokenSet.scopes : [],
            nextHash: parsed.nextHash,
            expiresAt: new Date(Date.now() + PENDING_SIGNIN_TTL_MS),
          });
        } catch (err) {
          // Pending-signin is a best-effort UX bridge. If the write
          // fails (table missing on a half-migrated deploy, transient
          // CRDB hiccup, etc.) the user still has a fully-functional
          // token row from the saveTokenForAccount call above and a
          // newly-created user — but the wizard's 5-min poll will
          // time out with the confusing "we didn't see your Google
          // sign-in" message even though OAuth succeeded. Log so the
          // operator can correlate the wizard timeout with a real
          // DB failure rather than chasing a phantom Google issue.
          // Truncate the key — even though it's 5-min-lived, logs may
          // ship to long-term aggregators (Datadog/Loki) and we don't
          // want a 5-minute secret landing in a 30-day index. 8 hex
          // chars (32 bits) are enough to correlate the wizard timeout
          // with the failed write at-a-glance; not enough to redeem.
          log.warn('Failed to write oauth_pending_signin row', {
            userId,
            accountEmail,
            pendingKeyPrefix: `${parsed.pendingKey.slice(0, 8)}…`,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (parsed.desktop) {
        res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SkyTwin</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#09090b;color:#fafafa}
.card{text-align:center;padding:2rem}.check{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="check">&#10003;</div><h2>Google account connected</h2><p>${accountEmail} is now linked. You can close this tab and return to SkyTwin.</p></div></body></html>`);
        return;
      }

      // Redirect to the dashboard so the user lands on the "your twin is now
      // alive" celebration instead of a settings form. The dashboard parses
      // the top-level `?userId=` (user-switcher) and the hash query
      // `?connected=google&account=…` (for the celebration card).
      //
      // If the /authorize call requested a `next=` deep-link target, we
      // route there instead of the dashboard root. The route was already
      // whitelisted server-side (NEXT_HASH_ROUTES) and re-validated when
      // parsing state, so the value here is one of a fixed set of hash
      // routes we own — never a user-supplied URL.
      const webBase = process.env['WEB_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3200'}`;
      const topLevel = new URLSearchParams({ userId }).toString();
      const hashQuery = new URLSearchParams({
        connected: 'google',
        account: accountEmail,
      }).toString();
      const hashRoute = parsed.nextHash ?? '#/';
      // hashRoute always starts with '#/' so the URL shape is
      //   …?userId=…#/connect-gmail?connected=google&account=…
      // The dashboard hash router reads the bit before `?` as the route.
      res.redirect(`${webBase}/?${topLevel}${hashRoute}?${hashQuery}`);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/oauth/microsoft/authorize
   *
   * Returns a Microsoft (Entra) authorization URL for connecting Outlook mail
   * + calendar to the AUTHENTICATED user's account. Scoped intentionally
   * narrow vs the Google flow: no new-user-sign-in-with-Microsoft, no desktop
   * pending handoff — just "connect Outlook to my existing SkyTwin". Pass
   * `?userId=…` or rely on the session.
   */
  router.get('/microsoft/authorize', async (req, res, next) => {
    try {
      const config = await resolveMicrosoftConfig();
      if (!config.clientId) {
        res.status(503).json({
          error:
            'Microsoft (Outlook) connect is not configured. Add a Microsoft Entra app via Settings, ' +
            'or set MICROSOFT_CLIENT_ID (+ MICROSOFT_CLIENT_SECRET for a confidential client).',
          code: 'NO_MICROSOFT_CLIENT_CONFIGURED',
        });
        return;
      }

      const queryUserId = typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
      const userId = queryUserId ?? req.authenticatedUserId;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId. Pass ?userId=… or authenticate.' });
        return;
      }

      const scopes = [
        MICROSOFT_GRAPH_SCOPES.userRead,
        MICROSOFT_GRAPH_SCOPES.mailRead,
        MICROSOFT_GRAPH_SCOPES.calendarsRead,
      ];

      // State carries only the userId — connect-for-existing-user, no tags.
      // Reuses the same HMAC signing as the Google flow so /microsoft/callback
      // can't be spoofed into attaching an account to another user.
      const state = signStatePayload(userId, Date.now() + STATE_TTL_MS);

      let codeChallenge: string | undefined;
      if (!config.clientSecret) {
        const pkce = microsoftOAuth.generatePkcePair();
        await rememberPkceVerifier(state, pkce.codeVerifier);
        codeChallenge = pkce.codeChallenge;
      }

      const url = microsoftOAuth.generateAuthUrl(config, scopes, state, codeChallenge);
      res.json({ url });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/oauth/microsoft/callback
   *
   * Public (browser redirect from Microsoft). Validates the signed state,
   * exchanges the code, resolves the Graph identity, and persists tokens
   * keyed on (userId, 'microsoft', accountEmail). Connect-for-existing-user
   * only: the signed state MUST carry a userId (no auto-create).
   */
  router.get('/microsoft/callback', async (req, res, next) => {
    try {
      const code = req.query['code'] as string | undefined;
      const state = req.query['state'] as string | undefined;
      if (!code) {
        res.status(400).json({ error: 'Missing authorization code' });
        return;
      }
      if (!state) {
        res.status(400).json({ error: 'Missing state parameter' });
        return;
      }

      let parsed: ParsedState;
      try {
        parsed = parseSignedState(state);
      } catch (err) {
        res.status(400).json({ error: err instanceof InvalidStateError ? err.message : 'Invalid state' });
        return;
      }

      const userId = parsed.userId;
      if (!userId) {
        res.status(400).json({ error: 'Microsoft connect requires an existing user in the signed state.' });
        return;
      }

      const config = await resolveMicrosoftConfig();
      // Consume-on-read so a replayed callback can't redeem the same code.
      const codeVerifier = await consumePkceVerifier(state);
      if (!config.clientSecret && !codeVerifier) {
        res.status(400).json({
          error: 'OAuth verifier expired or missing. Re-start the connect flow from the dashboard.',
        });
        return;
      }

      const tokenSet = await microsoftOAuth.exchangeCode(config, code, codeVerifier);
      const userInfo = await fetchMicrosoftUserInfo(tokenSet.accessToken);
      const accountEmail = userInfo.email.trim();
      if (!accountEmail) {
        res.status(502).json({
          error: 'Microsoft Graph /me returned no mail or userPrincipalName — cannot key the account.',
        });
        return;
      }

      // Connect attaches to an EXISTING user; if the signed-state userId no
      // longer exists, fail rather than auto-creating an orphaned account.
      const existing = await userRepository.findById(userId);
      if (!existing) {
        res.status(404).json({ error: 'User not found for this connect flow.' });
        return;
      }

      await oauthRepository.saveTokenForAccount({
        userId,
        provider: 'microsoft',
        accountEmail,
        accountProviderId: userInfo.id,
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken,
        expiresAt: tokenSet.expiresAt,
        scopes: tokenSet.scopes,
      });

      const webBase = process.env['WEB_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3200'}`;
      const topLevel = new URLSearchParams({ userId }).toString();
      const hashQuery = new URLSearchParams({ connected: 'microsoft', account: accountEmail }).toString();
      res.redirect(`${webBase}/?${topLevel}#/?${hashQuery}`);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/oauth/google/pending/:key
   *
   * Pollable handoff endpoint for the desktop new-user flow. The
   * Electron wizard generates a UUIDv4 before opening the system
   * browser, passes it to /authorize as `?pendingKey=…`, and polls
   * here until /callback writes the resulting userId.
   *
   * **Security model.** Possession of the pendingKey IS the
   * authorization. The endpoint:
   *   1. Does NOT just return the userId — that would chain with the
   *      pre-existing `POST /api/sessions` (which accepts any userId
   *      from a localhost caller) to make a leaked key worth a 7-day
   *      session token. Instead, this endpoint mints the session
   *      itself, returning a fresh token. The wizard stashes the
   *      token; subsequent API calls flow through `Authorization:
   *      Bearer …` exactly like the QR-paired mobile flow.
   *   2. Is consume-on-read (DELETE...RETURNING + an explicit
   *      expires_at >= NOW() predicate). A leaked key can only be
   *      redeemed once; an expired key returns 404 deterministically.
   *   3. Is per-IP rate-limited (same bucket as `?newUser=true`) to
   *      keep brute-force / DoS attempts off the table.
   *
   * 404 covers four cases the client treats identically (keep polling
   * until the local timeout):
   *   - the row hasn't been written yet (consent still in progress)
   *   - the row has expired (user took >5 min)
   *   - the key was malformed (validated up-front; surfaced as 404 so
   *     this endpoint can't be used as a key-shape oracle)
   *   - the key was already consumed by a previous request
   *
   * Public — no sessionAuth, by design — the desktop client has no
   * session yet for a new user. The key's unguessability IS the
   * authorization.
   */
  router.get('/google/pending/:key', async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      // Use the dedicated pending-poll bucket — sharing the
      // ?newUser=true bucket's tight 5/minute cap would 429 the
      // legitimate poll loop after ~10 seconds (30 polls/min from
      // the client), re-introducing the very grandma-blocker this
      // endpoint exists to solve.
      const { allowed, resetAt } = checkPendingPollRateLimit(ip, Date.now());
      if (!allowed) {
        res.set('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
        res.status(429).json({
          error: 'Too many requests. Try again in a minute.',
          resetAt: new Date(resetAt).toISOString(),
        });
        return;
      }

      const { key } = req.params;
      if (!key || !isValidPendingKey(key)) {
        // Same 404 shape as not-yet / expired / already-consumed so
        // this endpoint isn't a key-shape oracle.
        res.status(404).json({ error: 'No pending sign-in.' });
        return;
      }

      // Atomically consume the pending row AND mint the session in
      // one transaction. Without this, a session.create() failure
      // after consume() would leave the user stranded — no session,
      // no recoverable pending row. The transaction rolls back the
      // DELETE on any downstream error so the user can retry.
      const rawToken = `${randomUUID()}-${randomUUID()}`;
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const handoff = await withTransaction(async (client) => {
        const now = new Date();
        // Same shape as oauthPendingSigninRepository.consume — duplicated
        // here so it can share the transaction client.
        const consumeResult = await client.query<{
          user_id: string;
          account_email: string;
          scopes: unknown;
          next_hash: string | null;
          expires_at: Date;
        }>(
          `DELETE FROM oauth_pending_signin
            WHERE pending_key = $1
              AND expires_at >= $2
           RETURNING user_id, account_email, scopes, next_hash, expires_at`,
          [key, now],
        );
        const row = consumeResult.rows[0];
        if (!row) return null;

        // Same shape as sessionRepository.create — duplicated here for
        // the same reason. If this INSERT throws, the transaction rolls
        // back and the pending row stays put for a retry.
        await client.query(
          `INSERT INTO sessions (user_id, token_hash, device_name, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [row.user_id, tokenHash, 'Desktop', expiresAt],
        );

        return {
          userId: row.user_id,
          accountEmail: row.account_email,
          scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
          nextHash: row.next_hash,
        };
      });

      if (!handoff) {
        res.status(404).json({ error: 'No pending sign-in.' });
        return;
      }

      res.json({
        connected: true,
        sessionToken: rawToken,
        sessionExpiresAt: expiresAt.toISOString(),
        userId: handoff.userId,
        accountEmail: handoff.accountEmail,
        scopes: handoff.scopes,
        nextHash: handoff.nextHash,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/oauth/:provider/status
   *
   * Check if a provider is connected for a user.
   */
  router.get('/:provider/status', async (req, res, next) => {
    try {
      const { provider } = req.params;
      const userId =
        (typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined) ??
        req.authenticatedUserId;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      const token = await oauthRepository.getToken(userId, provider);

      res.json({
        connected: token !== null,
        provider,
        userId,
        expiresAt: token?.expires_at?.toISOString() ?? null,
        scopes: token?.scopes ?? [],
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/oauth/:provider/accounts/:userId
   *
   * List every account this user has connected for the given provider.
   * Used by the Settings UI to show one row per inbox/calendar.
   */
  router.get('/:provider/accounts/:userId', async (req, res, next) => {
    try {
      const { provider, userId } = req.params;
      if (!provider || !userId) {
        res.status(400).json({ error: 'Missing provider or userId' });
        return;
      }
      const rows = await oauthRepository.listAccountsForUser(userId, provider);
      res.json({
        accounts: rows.map((row) => ({
          accountEmail: row.account_email,
          accountProviderId: row.account_provider_id,
          provider: row.provider,
          scopes: row.scopes,
          expiresAt: row.expires_at?.toISOString() ?? null,
          updatedAt: row.updated_at?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/oauth/:provider/:userId/:accountEmail
   *
   * Revoke and remove a single account. Lets the user disconnect one inbox
   * without nuking every other account they have connected.
   */
  router.delete('/:provider/:userId/:accountEmail', async (req, res, next) => {
    try {
      const { provider, userId, accountEmail } = req.params;
      if (!provider || !userId || !accountEmail) {
        res.status(400).json({ error: 'Missing provider, userId, or accountEmail' });
        return;
      }

      const decodedEmail = decodeURIComponent(accountEmail);
      const token = await oauthRepository.getTokenByAccount(userId, provider, decodedEmail);
      if (!token) {
        res.status(404).json({ error: 'Account not connected.' });
        return;
      }

      // Google docs: revoking the refresh_token invalidates the entire
      // grant; revoking only the access_token still leaves the long-lived
      // grant active. Prefer refresh, fall back to access if missing.
      // Either may be null after credential-vault migration (#183 follow-up).
      const tokenToRevoke = token.refresh_token ?? token.access_token;
      if (tokenToRevoke) {
        try {
          await revokeToken(tokenToRevoke);
        } catch {
          // Already revoked / expired — proceed with local cleanup.
        }
      }
      const removed = await oauthRepository.deleteAccount(userId, provider, decodedEmail);
      res.json({ status: removed ? 'disconnected' : 'not_found', provider, accountEmail: decodedEmail });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/oauth/:provider/disconnect
   *
   * Revoke tokens and disconnect every account on a provider for the user.
   * Kept for backwards compatibility with the Settings page's "disconnect
   * Google" button.
   */
  router.delete('/:provider/disconnect', async (req, res, next) => {
    try {
      const { provider } = req.params;
      const userId =
        (typeof req.body?.['userId'] === 'string' ? req.body['userId'] : undefined) ??
        req.authenticatedUserId;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      if (provider !== 'google' && provider !== 'microsoft') {
        res.status(400).json({ error: `Unsupported provider: ${provider}` });
        return;
      }

      const accounts = await oauthRepository.listAccountsForUser(userId, provider);
      // Google supports server-side token revocation; Microsoft Entra has no
      // equivalent token-revoke endpoint, so for Microsoft we just drop the
      // stored rows (deleting the token is the disconnect).
      if (provider === 'google') {
        // Revoke each connected account in turn, then drop all rows. Prefer
        // refresh_token (invalidates the full grant); access_token alone
        // leaves the grant active per Google's revocation semantics.
        for (const acct of accounts) {
          const tokenToRevoke = acct.refresh_token ?? acct.access_token;
          if (!tokenToRevoke) continue;
          try {
            await revokeToken(tokenToRevoke);
          } catch {
            // Revocation can fail if a token is already expired — continue.
          }
        }
      }
      await oauthRepository.deleteAllForProvider(userId, provider);

      res.json({
        status: 'disconnected',
        provider,
        // Microsoft has no revoke endpoint, so for it `revoked` is always 0;
        // `deleted` reflects the rows dropped for either provider.
        revoked: provider === 'google' ? accounts.length : 0,
        deleted: accounts.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
