/**
 * Headers for the worker's POSTs to the API's `/api/events/ingest`.
 *
 * `/api/events` sits behind `sessionAuth`. In dev the localhost bypass lets an
 * unauthenticated POST through, but a packaged desktop build runs every child
 * process under `NODE_ENV=production` with `SKYTWIN_DEV_AUTH_BYPASS=false` —
 * there an unauthenticated POST 401s, `withRetry` does not retry 401, and the
 * throw trips the per-user circuit breaker, so the install ingests nothing.
 *
 * `SKYTWIN_SERVICE_TOKEN` is the per-install loopback credential the desktop
 * `ServiceManager` mints and hands to the API (verifier) and to the worker and
 * the idle-miner (presenters).
 */

/**
 * Build the ingest request headers, adding the service credential when one is
 * configured.
 *
 * Read from `process.env` per call rather than captured at module load so a
 * token rotation between polls is picked up. A missing / blank token yields
 * plain JSON headers — the dev-bypass behaviour, unchanged.
 */
export function buildIngestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const serviceToken = env['SKYTWIN_SERVICE_TOKEN'];
  if (typeof serviceToken === 'string' && serviceToken.trim().length > 0) {
    headers['Authorization'] = `Bearer ${serviceToken.trim()}`;
  }
  return headers;
}
