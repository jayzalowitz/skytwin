/**
 * Classify a permanent Google OAuth refresh failure from status metadata only.
 * Provider response bodies are deliberately unavailable at this boundary.
 */
export type OAuthRefreshFailureCode = 'invalid_grant' | 'unauthorized_client';

export function extractErrorCode(statusCode: number): OAuthRefreshFailureCode | null {
  if (statusCode === 401) return 'unauthorized_client';
  if (statusCode === 400 || statusCode === 403) return 'invalid_grant';
  return null;
}
