import { Router } from 'express';
import { loadConfig } from '@skytwin/config';
import { oauthRepository } from '@skytwin/db';
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
 * Create the OAuth router for connecting external accounts.
 */
export function createOAuthRouter(): Router {
  const router = Router();
  const config = loadConfig();

  const googleConfig: GoogleOAuthConfig = {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  };

  /**
   * GET /api/oauth/google/authorize
   *
   * Returns a Google OAuth authorization URL. The client redirects the user here.
   */
  router.get('/google/authorize', (req, res) => {
    const scopes = [...GMAIL_SCOPES, ...CALENDAR_SCOPES];
    const state = req.query['userId'] as string | undefined;
    const url = generateAuthUrl(googleConfig, scopes, state);
    res.json({ url });
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

      const userId = state ?? 'default-user';
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

      // Redirect back to the dashboard with success
      res.redirect('/#/settings?connected=google');
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
