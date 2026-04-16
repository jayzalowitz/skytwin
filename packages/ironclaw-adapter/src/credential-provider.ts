import { loadConfig } from '@skytwin/config';
import { oauthRepository, serviceCredentialRepository } from '@skytwin/db';

export interface CredentialProvider {
  getAccessToken(userId: string, provider: string): Promise<string>;
}

export class DbCredentialProvider implements CredentialProvider {
  // Per-user+provider lock to prevent concurrent refresh races
  private readonly refreshLocks = new Map<string, Promise<string>>();

  async getAccessToken(userId: string, provider: string): Promise<string> {
    const token = await oauthRepository.getToken(userId, provider);
    if (!token) {
      throw new Error(`No OAuth token found for ${provider}. Connect the account first.`);
    }

    if (token.expires_at.getTime() > Date.now() + 60_000) {
      return token.access_token;
    }

    if (provider !== 'google') {
      throw new Error(`OAuth refresh is not implemented for ${provider}. Reconnect the account.`);
    }

    if (!token.refresh_token) {
      throw new Error('Google OAuth token is expired and has no refresh token. Reconnect Google.');
    }

    // Serialize concurrent refresh requests for the same user+provider
    const lockKey = `${userId}:${provider}`;
    const existing = this.refreshLocks.get(lockKey);
    if (existing) return existing;

    const scopes = Array.isArray(token.scopes) ? token.scopes : token.scopes ? [token.scopes] : [];
    const refreshPromise = this.doGoogleRefresh(userId, provider, token.refresh_token, scopes)
      .finally(() => this.refreshLocks.delete(lockKey));
    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  private async doGoogleRefresh(
    userId: string,
    provider: string,
    refreshToken: string,
    scopes: string[],
  ): Promise<string> {
    const googleConfig = await this.getGoogleOAuthConfig();
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleConfig.clientId,
        client_secret: googleConfig.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Google OAuth refresh failed: HTTP ${response.status} ${body}`);
    }

    const payload = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!payload.access_token) {
      throw new Error('Google OAuth refresh response did not include an access token.');
    }

    const expiresAt = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000);
    const saved = await oauthRepository.saveToken(
      userId,
      provider,
      payload.access_token,
      payload.refresh_token ?? refreshToken,
      expiresAt,
      scopes,
    );

    return saved.access_token;
  }

  private async getGoogleOAuthConfig(): Promise<{ clientId: string; clientSecret: string }> {
    const config = loadConfig();
    let clientId = config.googleClientId;
    let clientSecret = config.googleClientSecret;

    if (!clientId || !clientSecret) {
      const dbCreds = await serviceCredentialRepository.getAsMap('google');
      clientId = clientId || dbCreds['client_id'] || '';
      clientSecret = clientSecret || dbCreds['client_secret'] || '';
    }

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth client credentials are not configured.');
    }

    return { clientId, clientSecret };
  }
}

export class NoopCredentialProvider implements CredentialProvider {
  async getAccessToken(_userId: string, provider: string): Promise<string> {
    throw new Error(`No credential provider configured for ${provider}.`);
  }
}
