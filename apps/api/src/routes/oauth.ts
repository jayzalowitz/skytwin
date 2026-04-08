import { Router } from 'express';
import { loadConfig } from '@skytwin/config';
import { oauthRepository, serviceCredentialRepository } from '@skytwin/db';
import {
  generateAuthUrl,
  exchangeCode,
  revokeToken,
} from '@skytwin/connectors';
import type { GoogleOAuthConfig } from '@skytwin/connectors';

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

  /**
   * GET /api/oauth/google/authorize
   *
   * Returns a Google OAuth authorization URL. The client redirects the user here.
   */
  router.get('/google/authorize', async (req, res, next) => {
    try {
      const googleConfig = await resolveGoogleConfig();
      const scopes = [...GMAIL_SCOPES, ...CALENDAR_SCOPES];
      const state = req.query['userId'] as string | undefined;
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
        console.error('[oauth] WARNING: state param is missing — userId will not be associated with token');
      }

      const userId = state ?? 'default-user';
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
      const userId = req.query['userId'] as string ?? 'default-user';

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
      const userId = req.body?.['userId'] as string ?? 'default-user';

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
