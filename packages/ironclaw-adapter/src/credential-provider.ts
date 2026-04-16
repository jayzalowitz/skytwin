import { loadConfig } from '@skytwin/config';
import { oauthRepository, serviceCredentialRepository } from '@skytwin/db';

export interface CredentialResult {
  success: true;
  accessToken: string;
}

export interface CredentialError {
  success: false;
  error: string;
}

export type CredentialOutcome = CredentialResult | CredentialError;

export interface CredentialProvider {
  getAccessToken(userId: string, provider: string): Promise<CredentialOutcome>;
}

export class DbCredentialProvider implements CredentialProvider {
  // Per-user+provider lock to prevent concurrent refresh races
  private readonly refreshLocks = new Map<string, Promise<CredentialOutcome>>();

  async getAccessToken(userId: string, provider: string): Promise<CredentialOutcome> {
    const token = await oauthRepository.getToken(userId, provider);
    if (!token) {
      return { success: false, error: `No OAuth token found for ${provider}. Connect the account first.` };
    }

    if (token.expires_at.getTime() > Date.now() + 60_000) {
      return { success: true, accessToken: token.access_token };
    }

    if (provider !== 'google') {
      return { success: false, error: `OAuth refresh is not implemented for ${provider}. Reconnect the account.` };
    }

    if (!token.refresh_token) {
      return { success: false, error: 'Google OAuth token is expired and has no refresh token. Reconnect Google.' };
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
  ): Promise<CredentialOutcome> {
    const googleConfig = await this.getGoogleOAuthConfig();
    if (!googleConfig.success) return googleConfig;

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
      return { success: false, error: `Google OAuth refresh failed: HTTP ${response.status} ${body}` };
    }

    const payload = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!payload.access_token) {
      return { success: false, error: 'Google OAuth refresh response did not include an access token.' };
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

    return { success: true, accessToken: saved.access_token };
  }

  private async getGoogleOAuthConfig(): Promise<{ success: true; clientId: string; clientSecret: string } | CredentialError> {
    const config = loadConfig();
    let clientId = config.googleClientId;
    let clientSecret = config.googleClientSecret;

    if (!clientId || !clientSecret) {
      const dbCreds = await serviceCredentialRepository.getAsMap('google');
      clientId = clientId || dbCreds['client_id'] || '';
      clientSecret = clientSecret || dbCreds['client_secret'] || '';
    }

    if (!clientId || !clientSecret) {
      return { success: false, error: 'Google OAuth client credentials are not configured.' };
    }

    return { success: true, clientId, clientSecret };
  }
}

export class NoopCredentialProvider implements CredentialProvider {
  async getAccessToken(_userId: string, provider: string): Promise<CredentialOutcome> {
    return { success: false, error: `No credential provider configured for ${provider}.` };
  }
}
