import { query } from '../connection.js';
import type { OAuthTokenRow } from '../types.js';

/**
 * Repository for OAuth token CRUD operations.
 */
export const oauthRepository = {
  async getToken(userId: string, provider: string): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
    return result.rows[0] ?? null;
  },

  async saveToken(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
    scopes: string[],
  ): Promise<OAuthTokenRow> {
    const result = await query<OAuthTokenRow>(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = now()
       RETURNING *`,
      [userId, provider, accessToken, refreshToken, expiresAt, scopes],
    );
    return result.rows[0]!;
  },

  async deleteToken(userId: string, provider: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async getUsersWithActiveTokens(): Promise<OAuthTokenRow[]> {
    const result = await query<OAuthTokenRow>(
      'SELECT * FROM oauth_tokens WHERE refresh_token IS NOT NULL',
    );
    return result.rows;
  },

  async updateAccessToken(
    userId: string,
    provider: string,
    accessToken: string,
    expiresAt: Date,
  ): Promise<OAuthTokenRow | null> {
    const result = await query<OAuthTokenRow>(
      `UPDATE oauth_tokens
       SET access_token = $1, expires_at = $2, updated_at = now()
       WHERE user_id = $3 AND provider = $4
       RETURNING *`,
      [accessToken, expiresAt, userId, provider],
    );
    return result.rows[0] ?? null;
  },
};
