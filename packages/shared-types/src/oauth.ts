/**
 * OAuth token set returned by providers and stored for API access.
 */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  provider: 'google' | 'microsoft';
}

/**
 * Configuration for a connected signal connector.
 */
export interface ConnectorConfig {
  id: string;
  userId: string;
  provider: string;
  connectorType: 'gmail' | 'google_calendar';
  enabled: boolean;
  lastSyncAt: Date | null;
  syncCursor: string | null;
  createdAt: Date;
  updatedAt: Date;
}
