import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { loadConfig } from '@skytwin/config';
import { oauthRepository, serviceCredentialRepository, userRepository } from '@skytwin/db';
import {
  generateAuthUrl,
  generatePkcePair,
  exchangeCode,
  revokeToken,
} from '@skytwin/connectors';
import type { GoogleOAuthConfig } from '@skytwin/connectors';
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
 * Bucket cap. Without this the Map grows once per unique attacker IP and
 * never shrinks — a real source of slow memory growth in long-running
 * processes. When we hit the cap we sweep expired buckets first, then drop
 * the oldest insertion-order entry. The constant is loose: we never expect
 * thousands of legitimate IPs hitting `?newUser=true` per process.
 */
export const NEW_USER_RATE_LIMIT_MAX_BUCKETS = 5_000;
const newUserRateBuckets = new Map<string, { count: number; resetAt: number }>();

function evictExpiredBuckets(now: number): void {
  for (const [ip, bucket] of newUserRateBuckets) {
    if (bucket.resetAt <= now) newUserRateBuckets.delete(ip);
  }
}

export function checkNewUserRateLimit(
  ip: string,
  now: number = Date.now(),
): { allowed: boolean; resetAt: number } {
  let bucket = newUserRateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    // Pre-emptively evict when at the cap so the Map can't grow without
    // bound across many distinct IPs (the leak class motivating this).
    if (newUserRateBuckets.size >= NEW_USER_RATE_LIMIT_MAX_BUCKETS) {
      evictExpiredBuckets(now);
      while (newUserRateBuckets.size >= NEW_USER_RATE_LIMIT_MAX_BUCKETS) {
        const oldest = newUserRateBuckets.keys().next().value;
        if (oldest === undefined) break;
        newUserRateBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + NEW_USER_RATE_LIMIT_WINDOW_MS };
    newUserRateBuckets.set(ip, bucket);
  }
  if (bucket.count >= NEW_USER_RATE_LIMIT_MAX) {
    return { allowed: false, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return { allowed: true, resetAt: bucket.resetAt };
}

/** Test helper — clears all rate-limit buckets between cases. */
export function _resetNewUserRateLimitForTests(): void {
  newUserRateBuckets.clear();
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

/**
 * State carries the caller's intent across the OAuth round-trip and is
 * HMAC-signed so the public /google/callback endpoint can't be spoofed.
 *
 * Wire format: `v2.<payload>.<expiresAtMs>.<hmacHex>` where the hmac
 * covers `<payload>.<expiresAtMs>`.
 *
 * Payload is the original pipe-delimited intent string:
 *   <userId>            associate token with this existing user
 *   <userId>|desktop    same, OAuth opened from Electron
 *   <userId>|new        adding another account to this user
 *   new                 no user yet — auto-create from verified email
 *   new|desktop
 *
 * Without the signature, an attacker could mint their own Google
 * authorization code and call /google/callback with state=<victim-id>
 * to attach their account to someone else's user.
 */
interface ParsedState {
  userId: string | null; // null = auto-create user from email
  desktop: boolean;
  newAccount: boolean;
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
  const tags = new Set(payload.split('|').slice(1));
  return {
    userId: head === 'new' ? null : (head ?? null),
    desktop: tags.has('desktop'),
    newAccount: tags.has('new'),
  };
}

/**
 * `openid` + `email` are required for the userinfo endpoint to return the
 * verified email used as the per-account row key. `profile` gives us a
 * display name for auto-created users so they don't show up as raw UUIDs
 * in the dashboard.
 */
const IDENTITY_SCOPES = ['openid', 'email', 'profile'];

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * Build the Google OAuth config. Three sources, in priority order:
 *   1. User-supplied credentials in the DB (Setup page) — wins.
 *   2. Confidential-client env vars (`GOOGLE_CLIENT_ID`/`_SECRET`) —
 *      the old "operator wires it up at deploy" path.
 *   3. PKCE-only default client_id baked into the build via
 *      `SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID`. The desktop bundle ships
 *      this so end-users don't have to create their own Google Cloud
 *      OAuth app. Public client IDs are designed to be revealed; PKCE
 *      binds each auth code to a per-flow verifier so a stolen
 *      client_id alone redeems nothing.
 *
 * The returned `clientSecret` is the literal empty string in PKCE mode —
 * downstream code keys on `secret === ''` to choose the PKCE token-
 * exchange variant. Don't normalise it to undefined; the empty string is
 * load-bearing.
 */
async function resolveGoogleConfig(): Promise<GoogleOAuthConfig> {
  const config = loadConfig();

  // Layer 1: env vars (typical for self-hosted ops).
  let clientId = config.googleClientId;
  let clientSecret = config.googleClientSecret;
  let redirectUri = config.googleRedirectUri;

  // Layer 2: DB-stored credentials from the Setup page take priority over
  // env vars and over the bundled default. Falls through silently when
  // the service_credentials table doesn't exist yet.
  try {
    const dbCreds = await serviceCredentialRepository.getAsMap('google');
    if (dbCreds['client_id']) clientId = dbCreds['client_id'];
    if (dbCreds['client_secret']) clientSecret = dbCreds['client_secret'];
    if (dbCreds['redirect_uri'] && redirectUri === 'http://localhost:3100/api/oauth/google/callback') {
      redirectUri = dbCreds['redirect_uri'];
    }
  } catch {
    // No service_credentials table yet — fall through.
  }

  // Layer 3: PKCE-only default (desktop bundle). Used iff neither env vars
  // nor DB supplied a clientId. We intentionally leave clientSecret as
  // empty string so the rest of the flow auto-routes to PKCE.
  if (!clientId) {
    const bundled = process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'] ?? '';
    if (bundled) {
      clientId = bundled;
      clientSecret = '';
    }
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Server-local store of pending PKCE verifiers, keyed by the signed
 * state token. The verifier MUST NOT travel through Google or the user's
 * browser — that's the whole reason PKCE exists. Server-side memory is
 * adequate for the OAuth-redirect timescale (~minutes); a process
 * restart mid-flow just makes the user retry.
 *
 * TTL matches STATE_TTL_MS. We sweep on every set to keep the map size
 * bounded even if callbacks never come back (closed browser tab, etc.).
 */
const PKCE_TTL_MS = 10 * 60 * 1000;
const PKCE_MAX_ENTRIES = 1024;
const pkceStore = new Map<string, { codeVerifier: string; expiresAt: number }>();

function sweepPkceStore(now: number): void {
  for (const [k, v] of pkceStore) {
    if (v.expiresAt <= now) pkceStore.delete(k);
  }
}

function rememberPkceVerifier(state: string, codeVerifier: string): void {
  const now = Date.now();
  sweepPkceStore(now);
  if (pkceStore.size >= PKCE_MAX_ENTRIES) {
    // Drop oldest entry (Map preserves insertion order).
    const oldest = pkceStore.keys().next().value;
    if (oldest !== undefined) pkceStore.delete(oldest);
  }
  pkceStore.set(state, { codeVerifier, expiresAt: now + PKCE_TTL_MS });
}

function consumePkceVerifier(state: string): string | undefined {
  const entry = pkceStore.get(state);
  if (!entry) return undefined;
  pkceStore.delete(state);
  if (entry.expiresAt < Date.now()) return undefined;
  return entry.codeVerifier;
}

/**
 * Create the OAuth router for connecting external accounts.
 */
export function createOAuthRouter(): Router {
  const router = Router();

  // All OAuth management endpoints require an authenticated user except:
  //   - /google/callback        public (browser redirect from Google)
  //   - /google/authorize?newUser=true   public (sign-in-with-Google)
  // For the new-user flow there's no session yet, so requiring sessionAuth
  // would 401 before the user could even start consenting.
  router.use((req, res, next) => {
    if (req.path === '/google/callback') {
      next();
      return;
    }
    if (req.path === '/google/authorize' && req.query['newUser'] === 'true') {
      next();
      return;
    }

    void sessionAuth(req, res, next);
  });
  router.use((req, res, next) => {
    if (req.path === '/google/callback') {
      next();
      return;
    }
    if (req.path === '/google/authorize' && req.query['newUser'] === 'true') {
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
        res.status(503).json({
          error:
            'Google sign-in is not configured. ' +
            'Open Setup and paste your OAuth client_id (and client_secret if you have one), ' +
            'or rebuild the desktop with SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID set.',
        });
        return;
      }
      const scopes = [...IDENTITY_SCOPES, ...GMAIL_SCOPES, ...CALENDAR_SCOPES];

      const queryUserId =
        typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
      const newAccount = req.query['newAccount'] === 'true';
      const desktop = req.query['desktop'] === 'true';

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

      const payload = [stateHead, ...tags].join('|');
      const state = signStatePayload(payload, Date.now() + STATE_TTL_MS);

      // PKCE mode when no client_secret. Generate verifier+challenge,
      // stash verifier server-side keyed on the signed state token, send
      // only the challenge to Google. /callback retrieves the verifier
      // by state.
      let codeChallenge: string | undefined;
      if (!googleConfig.clientSecret) {
        const pkce = generatePkcePair();
        rememberPkceVerifier(state, pkce.codeVerifier);
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
      const codeVerifier = consumePkceVerifier(state);
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
      // Auto-created users start at 'observer' (read-only). The interactive
      // POST /api/users path uses 'suggest' — there a real human is filling
      // out a form — but a passive sign-in-with-Google grant shouldn't
      // unlock action suggestions on day one. The user earns 'suggest' via
      // approval feedback through the trust-tier audit pipeline.
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
      const webBase = process.env['WEB_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3200'}`;
      const topLevel = new URLSearchParams({ userId }).toString();
      const hashQuery = new URLSearchParams({
        connected: 'google',
        account: accountEmail,
      }).toString();
      res.redirect(`${webBase}/?${topLevel}#/?${hashQuery}`);
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

      if (provider !== 'google') {
        res.status(400).json({ error: `Unsupported provider: ${provider}` });
        return;
      }

      // Revoke each connected account in turn, then drop all rows.
      // Prefer refresh_token (invalidates the full grant); access_token
      // alone leaves the grant active per Google's revocation semantics.
      const accounts = await oauthRepository.listAccountsForUser(userId, provider);
      for (const acct of accounts) {
        const tokenToRevoke = acct.refresh_token ?? acct.access_token;
        if (!tokenToRevoke) continue;
        try {
          await revokeToken(tokenToRevoke);
        } catch {
          // Revocation can fail if a token is already expired — continue.
        }
      }
      await oauthRepository.deleteAllForProvider(userId, provider);

      res.json({
        status: 'disconnected',
        provider,
        revoked: accounts.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
