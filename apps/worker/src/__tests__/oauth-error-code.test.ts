import { describe, it, expect } from 'vitest';
import { extractErrorCode } from '../oauth-error-code.js';

describe('extractErrorCode', () => {
  it('extracts the error code from a real OAuthRefreshError message', () => {
    // Format produced by packages/connectors/src/oauth/google-oauth.ts:
    //   `Google OAuth token refresh failed (permanent): 400 {body}`
    // where {body} is the raw Google token-endpoint response.
    const msg = `Google OAuth token refresh failed (permanent): 400 {"error":"invalid_grant","error_description":"Token has been expired or revoked."}`;
    expect(extractErrorCode(msg)).toBe('invalid_grant');
  });

  it('handles unauthorized_client (client misconfig path)', () => {
    const msg = `Google OAuth token refresh failed (permanent): 401 {"error":"unauthorized_client","error_description":"The OAuth client was not found."}`;
    expect(extractErrorCode(msg)).toBe('unauthorized_client');
  });

  it('tolerates whitespace around the JSON field separator', () => {
    const msg = `Google OAuth token refresh failed (permanent): 400 { "error" : "invalid_grant" }`;
    expect(extractErrorCode(msg)).toBe('invalid_grant');
  });

  it('returns null when no recognisable code is present', () => {
    expect(extractErrorCode('Network error: ECONNRESET')).toBeNull();
    expect(extractErrorCode('')).toBeNull();
    // Confirms the OLD regex (matched against `refresh failed: <code>`)
    // would have returned null on the actual message format too — the
    // fallback path is well-exercised.
    expect(extractErrorCode('refresh failed: nope')).toBeNull();
  });

  it('returns null on messages without a JSON body', () => {
    const msg = `Google OAuth token refresh failed (transient): 503 Service Unavailable`;
    expect(extractErrorCode(msg)).toBeNull();
  });
});
