import { Router } from 'express';
import { loadConfig } from '@skytwin/config';
import { oauthRepository, serviceCredentialRepository } from '@skytwin/db';
import {
  generateAuthUrl,
  exchangeCode,
  revokeToken,
} from '@skytwin/connectors';
import type { GoogleOAuthConfig } from '@skytwin/connectors';
import { sessionAuth } from '../middleware/session-auth.js';
import { requireOwnership } from '../middleware/require-ownership.js';

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
   * Returns a Google OAuth authorization URL. The client redirects the user here.
   */
  router.get('/google/authorize', async (req, res, next) => {
    try {
      const googleConfig = await resolveGoogleConfig();
      const scopes = [...GMAIL_SCOPES, ...CALENDAR_SCOPES];
      const state =
        (typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined) ??
        req.authenticatedUserId;
      if (!state) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }
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

      // State may contain "|desktop" suffix when OAuth was opened from the Electron app
      const isDesktop = state?.endsWith('|desktop') ?? false;
      const userId = isDesktop ? state.replace(/\|desktop$/, '') : state;
      const googleConfig = await resolveGoogleConfig();
      const tokenSet = await exchangeCode(googleConfig, code);

      // Persist tokens to the database
      await oauthRepository.saveToken(
        userId,
        'google',
        tokenSet.accessToken,
        tokenSet.refreshToken,
        tokenSet.expiresAt,
        tokenSet.scopes,
      );

      if (isDesktop) {
        // OAuth was opened in the system browser from the Electron app.
        // Render a simple page instead of redirecting to localhost.
        res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SkyTwin</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#09090b;color:#fafafa}
.card{text-align:center;padding:2rem}.check{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="check">&#10003;</div><h2>Google account connected</h2><p>You can close this tab and return to SkyTwin.</p></div></body></html>`);
        return;
      }

      // Redirect back to the web dashboard with success.
      const webBase = process.env['WEB_BASE_URL'] ?? `http://localhost:${process.env['WEB_PORT'] ?? '3200'}`;
      res.redirect(`${webBase}/#/settings?connected=google`);
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
   * DELETE /api/oauth/:provider/disconnect
   *
   * Revoke tokens and disconnect from a provider.
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

      // Look up token and revoke
      const token = await oauthRepository.getToken(userId, provider);
      if (token) {
        try {
          await revokeToken(token.access_token);
        } catch {
          // Revocation can fail if token is already expired — continue with cleanup
        }
        await oauthRepository.deleteToken(userId, provider);
      }

      res.json({
        status: 'disconnected',
        provider,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
