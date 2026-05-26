/**
 * Pluck the Google `error` field out of an OAuthRefreshError message
 * (e.g. `"invalid_grant"`, `"unauthorized_client"`) so the dashboard
 * banner can render conditional copy ("revoked" vs "client misconfig").
 * Returns null when the message has no recognisable code so the
 * caller can default to a safe fallback.
 *
 * The OAuthRefreshError message format (see
 * `packages/connectors/src/oauth/google-oauth.ts`) is:
 *   `Google OAuth token refresh failed (permanent|transient): <status> <body>`
 * where `<body>` is the raw response text from Google's token endpoint —
 * usually JSON like `{"error":"invalid_grant","error_description":"..."}`.
 * We parse the `"error":"<code>"` JSON field out of that body.
 */
export function extractErrorCode(message: string): string | null {
  const match = message.match(/"error"\s*:\s*"([a-z_]+)"/i);
  return match?.[1] ?? null;
}
