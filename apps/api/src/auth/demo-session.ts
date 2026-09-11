import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { UUID_REGEX } from '../middleware/validate-uuid.js';

/** Reserved synthetic identity used by the packaged sample experience. */
export const DEMO_USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const DEMO_TOKEN_PREFIX = 'skytwin-demo-v1';
const DEMO_SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
const UUID_PATH_SEGMENT = UUID_REGEX.source.replace(/^\^|\$$/g, '');

export interface IssuedDemoSession {
  token: string;
  expiresAt: Date;
}

export interface VerifiedDemoSession {
  /** One-way key suitable for session-local, disposable server state. */
  sessionKey: string;
  expiresAtMs: number;
}

function sessionSecret(): string {
  return process.env['SESSION_SECRET'] ?? 'skytwin-dev-secret';
}

function signature(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

/**
 * Mint a short-lived, stateless credential for the reserved sample profile.
 * It is deliberately separate from normal user sessions: callers cannot use
 * it to select an identity, and sessionAuth applies a strict read allowlist.
 */
export function issueDemoSession(nowMs = Date.now()): IssuedDemoSession {
  const expiresAt = new Date(nowMs + DEMO_SESSION_DURATION_MS);
  const nonce = randomBytes(18).toString('base64url');
  const payload = `${DEMO_TOKEN_PREFIX}.${expiresAt.getTime()}.${nonce}`;
  return {
    token: `${payload}.${signature(payload)}`,
    expiresAt,
  };
}

/** Verify authenticity and expiry without consulting the session database. */
export function inspectDemoSession(
  token: string,
  nowMs = Date.now(),
): VerifiedDemoSession | null {
  const signed = inspectSignedDemoSession(token);
  if (!signed || signed.expiresAtMs <= nowMs) return null;
  return signed;
}

/** Authenticate an expired credential only for deleting its disposable state. */
export function inspectDemoSessionForDiscard(
  token: string,
): VerifiedDemoSession | null {
  return inspectSignedDemoSession(token);
}

function inspectSignedDemoSession(token: string): VerifiedDemoSession | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== DEMO_TOKEN_PREFIX) return null;

  const [, expiresRaw, nonce, presentedSignature] = parts;
  if (!expiresRaw || !/^\d{13}$/.test(expiresRaw)) return null;
  if (!nonce || !/^[A-Za-z0-9_-]{24}$/.test(nonce)) return null;
  if (!presentedSignature || !/^[a-f0-9]{64}$/.test(presentedSignature))
    return null;

  const expiresAtMs = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtMs)) return null;

  const payload = `${DEMO_TOKEN_PREFIX}.${expiresRaw}.${nonce}`;
  if (!constantTimeEqual(presentedSignature, signature(payload))) return null;
  return {
    sessionKey: createHash('sha256').update(token).digest('hex'),
    expiresAtMs,
  };
}

export function verifyDemoSession(token: string, nowMs = Date.now()): boolean {
  return inspectDemoSession(token, nowMs) !== null;
}

/**
 * The packaged sample is served through the dashboard's loopback API proxy.
 * Keeping token issuance and simulation commands loopback-only prevents the
 * disposable surface from becoming a remotely mintable public principal.
 */
export function isLocalDemoAddress(address: string | undefined): boolean {
  const normalized = address?.split('%')[0]?.toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === '::ffff:7f00:1' ||
    normalized === '0:0:0:0:0:ffff:7f00:1'
  );
}

/**
 * Require both Express's resolved client address and the untrusted-header-free
 * socket peer to be loopback. The second check prevents X-Forwarded-For from
 * turning a remote request into a local sample request when trust proxy is on.
 */
export function isLocalDemoRequest(
  clientAddress: string | undefined,
  socketAddress: string | undefined,
): boolean {
  return isLocalDemoAddress(clientAddress) && isLocalDemoAddress(socketAddress);
}

function pathIs(path: string, expected: string): boolean {
  return path === expected || path === `${expected}/`;
}

function queryHasDemoUser(url: URL): boolean {
  return url.searchParams.get('userId') === DEMO_USER_ID;
}

/**
 * The complete authority attached to a demo credential.
 *
 * GET is not assumed to be harmless: only explicitly enumerated, read-style
 * routes are accepted. Normal ownership middleware and repository request
 * context still bind every downstream read to DEMO_USER_ID.
 */
export function isDemoReadRequest(
  method: string,
  originalUrl: string,
): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;

  let url: URL;
  try {
    url = new URL(originalUrl, 'http://localhost');
  } catch {
    return false;
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const exactUserPaths = [
    `/api/users/${DEMO_USER_ID}`,
    `/api/users/${DEMO_USER_ID}/autonomy-state`,
    `/api/activity/${DEMO_USER_ID}`,
    `/api/approvals/${DEMO_USER_ID}/pending`,
    `/api/approvals/${DEMO_USER_ID}/history`,
    `/api/twin/${DEMO_USER_ID}`,
    `/api/twin/${DEMO_USER_ID}/progress`,
    `/api/twin/${DEMO_USER_ID}/learned`,
    `/api/twin/export/${DEMO_USER_ID}`,
    `/api/evals/${DEMO_USER_ID}/accuracy`,
    `/api/evals/${DEMO_USER_ID}/learning`,
    `/api/evals/${DEMO_USER_ID}/confidence`,
    `/api/v1/briefings/${DEMO_USER_ID}`,
    `/api/v1/skill-gaps/${DEMO_USER_ID}`,
    `/api/audit/${DEMO_USER_ID}`,
    `/api/policies/${DEMO_USER_ID}`,
    `/api/routines/${DEMO_USER_ID}`,
    `/api/watches/${DEMO_USER_ID}`,
    `/api/lifebooks/${DEMO_USER_ID}`,
    `/api/lifebooks/${DEMO_USER_ID}/all`,
    `/api/connectors/${DEMO_USER_ID}/status`,
    `/api/promotion-offers/${DEMO_USER_ID}`,
  ];
  if (exactUserPaths.some((candidate) => pathIs(path, candidate))) return true;

  if (pathIs(path, `/api/decisions/${DEMO_USER_ID}`)) return true;
  if (
    new RegExp(`^/api/decisions/${UUID_PATH_SEGMENT}/explanation$`).test(path)
  )
    return true;
  if (
    new RegExp(`^/api/watches/${DEMO_USER_ID}/${UUID_PATH_SEGMENT}/runs$`).test(
      path,
    )
  )
    return true;
  // Lifebook detail is keyed by a domain name, not a UUID. Exactly one
  // additional segment is readable; the two-segment `/:domain/layout`
  // inference route remains outside this allowlist.
  if (new RegExp(`^/api/lifebooks/${DEMO_USER_ID}/[^/]+$`).test(path))
    return true;

  // These routers carry the identity in the query string rather than the path.
  if (queryHasDemoUser(url)) {
    if (pathIs(path, '/api/capabilities')) return true;
    if (pathIs(path, '/api/capabilities/suggestions')) return true;
    if (pathIs(path, '/api/capabilities/dependency-graph')) return true;
    if (pathIs(path, '/api/capabilities/provenance-graph')) return true;
    if (pathIs(path, '/api/risk-profile')) return true;
    if (pathIs(path, '/api/twin-briefings')) return true;
    if (pathIs(path, '/api/twin-briefings/latest')) return true;
    if (/^\/api\/twin-briefings\/lifebook\/[^/]+\/latest$/.test(path))
      return true;
    if (/^\/api\/oauth\/[^/]+\/status$/.test(path)) return true;
    if (
      new RegExp(
        `^/api/capabilities/${UUID_PATH_SEGMENT}/(provenance|metrics|changelog)$`,
      ).test(path)
    )
      return true;
  }

  // Public catalog data used by the capability page; no user state involved.
  return pathIs(path, '/api/capabilities/registry');
}
