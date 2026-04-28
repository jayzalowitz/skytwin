import { Router } from 'express';
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
 * State carries the caller's intent across the OAuth round-trip. Encoded as
 * a pipe-delimited string for easy debugging in browser history/logs:
 *
 *   <userId>            associate token with this existing user
 *   <userId>|desktop    same, but the OAuth flow was opened from Electron
 *   <userId>|new        adding another account to this user (same as default)
 *   new                 no user yet — auto-create one keyed on the verified
 *                       Google email returned by userinfo
 *   new|desktop         same, desktop flow
 */
interface ParsedState {
  userId: string | null; // null = auto-create user from email
  desktop: boolean;
  newAccount: boolean;
}

function parseState(state: string): ParsedState {
  const parts = state.split('|');
  const head = parts[0];
  const tags = new Set(parts.slice(1));
  return {
    userId: head === 'new' ? null : (head ?? null),
    desktop: tags.has('desktop'),
    newAccount: tags.has('new'),
  };
}

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

  // All OAuth management endpoints require an authenticated user except the
  // provider callback itself, which must remain public for the browser redirect.
  router.use((req, res, next) => {
    if (req.path === '/google/callback') {
      next();
      return;
    }

    void sessionAuth(req, res, next);
  });
  router.use(requireOwnership);

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
      const googleConfig = await resolveGoogleConfig();
      const scopes = [...GMAIL_SCOPES, ...CALENDAR_SCOPES];

      const queryUserId =
        typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
      const newUser = req.query['newUser'] === 'true';
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

      const state = [stateHead, ...tags].join('|');
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

      const parsed = parseState(state);
      const googleConfig = await resolveGoogleConfig();
      const tokenSet = await exchangeCode(googleConfig, code);

      // Resolve the verified Google identity so we can key the token row on
      // the actual account email (rather than guessing from state) and
      // optionally materialize a user.
      const userInfo = await fetchGoogleUserInfo(tokenSet.accessToken);
      const accountEmail = userInfo.email;
      const accountProviderId = userInfo.id;

      // Resolve target userId.
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
            // New users start at 'suggest'. Trust must be earned via feedback.
            trustTier: 'suggest',
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
              trustTier: 'suggest',
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

      // Redirect back to the web dashboard. ?userId is included so the
      // dashboard can sync the active user (especially after auto-create);
      // ?account is informational so the UI can highlight the new row.
      const webBase = process.env['WEB_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3200'}`;
      const params = new URLSearchParams({
        connected: 'google',
        userId,
        account: accountEmail,
      });
      res.redirect(`${webBase}/?${params.toString()}#/settings`);
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

      try {
        await revokeToken(token.access_token);
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
      const accounts = await oauthRepository.listAccountsForUser(userId, provider);
      for (const acct of accounts) {
        try {
          await revokeToken(acct.access_token);
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
