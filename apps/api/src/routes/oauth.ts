import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { loadConfig } from '@skytwin/config';
import { oauthRepository, serviceCredentialRepository, userRepository } from '@skytwin/db';
import {
  generateAuthUrl,
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
const newUserRateBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkNewUserRateLimit(
  ip: string,
  now: number = Date.now(),
): { allowed: boolean; resetAt: number } {
  let bucket = newUserRateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
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
 * Build the Google OAuth config, preferring DB-stored credentials from
 * the Setup page over environment variables.
 */
async function resolveGoogleConfig(): Promise<GoogleOAuthConfig> {
  const config = loadConfig();

  // Start with env-var values
  let clientId = config.googleClientId;
  let clientSecret = config.googleClientSecret;
  let redirectUri = config.googleRedirectUri;

  // If env vars are empty, check the DB (credentials set via Setup page)
  if (!clientId || !clientSecret) {
    try {
      const dbCreds = await serviceCredentialRepository.getAsMap('google');
      if (dbCreds['client_id'] && !clientId) clientId = dbCreds['client_id'];
      if (dbCreds['client_secret'] && !clientSecret) clientSecret = dbCreds['client_secret'];
      if (dbCreds['redirect_uri'] && redirectUri === 'http://localhost:3100/api/oauth/google/callback') {
        redirectUri = dbCreds['redirect_uri'];
      }
    } catch {
      // DB may not have the table yet — fall through to env-var values
    }
  }

  return { clientId, clientSecret, redirectUri };
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
      // Without configured Google credentials we'd happily build an auth URL
      // with an empty client_id and Google would reject the user with an
      // opaque "invalid_client" — surface a clean 503 so the dashboard can
      // tell the user to finish Setup first.
      if (!googleConfig.clientId || !googleConfig.clientSecret) {
        res.status(503).json({
          error: 'Google credentials are not configured. Open Setup and add your OAuth client_id and client_secret.',
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
      const url = generateAuthUrl(googleConfig, scopes, state);
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
      const tokenSet = await exchangeCode(googleConfig, code);

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

      // Redirect back to the web dashboard. The dashboard parses both the
      // top-level query string (for the user-switcher's `?userId=` handler)
      // and the hash route's query (`#/settings?connected=…`), so include
      // userId at the top level so the active user syncs on auto-create,
      // and include `connected/account` in the hash for the Settings page's
      // banner.
      const webBase = process.env['WEB_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3200'}`;
      const topLevel = new URLSearchParams({ userId }).toString();
      const hashQuery = new URLSearchParams({
        connected: 'google',
        account: accountEmail,
      }).toString();
      res.redirect(`${webBase}/?${topLevel}#/settings?${hashQuery}`);
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
      try {
        await revokeToken(token.refresh_token || token.access_token);
      } catch {
        // Already revoked / expired — proceed with local cleanup.
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
        try {
          await revokeToken(acct.refresh_token || acct.access_token);
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
