import { createHmac, timingSafeEqual } from 'crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { sessionRepository, userRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import {
  DEMO_USER_ID,
  inspectDemoSession,
  isDemoSessionActive,
  isDemoSessionTokenCandidate,
  isDemoReadRequest,
  isLocalDemoRequest,
  matchesDemoFixtureIncarnation,
  revokeDemoSessionByKey,
} from '../auth/demo-session.js';
import type { VerifiedDemoSession } from '../auth/demo-session.js';
import type { SourceKeyBrokerSessionAuthority } from '@skytwin/shared-types';
import { apiSourceKeyBrokerClient } from '../source-key-broker.js';

const log = createLogger('api:auth');

// Extend Express Request to carry authenticated identity
declare global {
  namespace Express {
    interface Request {
      /** The userId from the validated session. Undefined when dev bypass is active. */
      authenticatedUserId?: string;
      /** The sessionId from the validated session. */
      authenticatedSessionId?: string;
      /**
       * True only when `sessionAuth` admitted this localhost request through
       * the explicit development bypass. Sensitive handlers use this marker
       * to distinguish that narrow mode from missing authentication middleware.
       */
      developmentAuthBypassed?: boolean;
      /** Opaque Electron grant available only to this revalidated real session. */
      sourceKeySessionAuthority?: SourceKeyBrokerSessionAuthority;
      /**
       * True when the request authenticated as the local SkyTwin service
       * (the worker or the idle-miner) via `SKYTWIN_SERVICE_TOKEN` from a
       * loopback address. Never set for a human session.
       */
      serviceAuthenticated?: boolean;
      /** True only for a signed, read-only session bound to the sample profile. */
      demoAuthenticated?: boolean;
    }
  }
}

const SESSION_SECRET = process.env['SESSION_SECRET'] ?? 'skytwin-dev-secret';

/**
 * Whether the dev auth bypass is active.
 *
 * Controlled by SKYTWIN_DEV_AUTH_BYPASS env var.
 * Defaults to true in development, false otherwise.
 */
const DEV_AUTH_BYPASS =
  (process.env['SKYTWIN_DEV_AUTH_BYPASS'] ??
    (process.env['NODE_ENV'] === 'development' ? 'true' : 'false')) === 'true';

let bypassWarned = false;

const MAX_BUFFERED_DEMO_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_DEMO_RESPONSE_ENTRIES = 1_024;
const MAX_BUFFERED_DEMO_RESPONSE_CALLBACKS = 256;

type ResponseCallback = (error?: Error | null) => void;

interface ParsedBodyCall {
  bytes: number;
  callback: ResponseCallback | null;
}

function parseBufferedBodyCall(
  args: unknown[],
  allowEmpty: boolean,
): ParsedBodyCall | null {
  if (args.length === 0) return allowEmpty ? { bytes: 0, callback: null } : null;
  if (args.length > 3) return null;

  const [chunk, second, third] = args;
  if (typeof chunk === 'function') {
    return allowEmpty && args.length === 1
      ? { bytes: 0, callback: chunk as ResponseCallback }
      : null;
  }
  if ((chunk === undefined || chunk === null) && allowEmpty) {
    if (args.length === 1) return { bytes: 0, callback: null };
    if (args.length === 2 && typeof second === 'function') {
      return { bytes: 0, callback: second as ResponseCallback };
    }
    return null;
  }
  if (
    typeof chunk !== 'string' &&
    !Buffer.isBuffer(chunk) &&
    !(chunk instanceof Uint8Array)
  ) {
    return null;
  }

  let encoding: BufferEncoding = 'utf8';
  let callback: ResponseCallback | null = null;
  if (typeof second === 'string') {
    if (!Buffer.isEncoding(second)) return null;
    encoding = second;
    if (third !== undefined) {
      if (typeof third !== 'function') return null;
      callback = third as ResponseCallback;
    }
  } else if (second !== undefined) {
    if (typeof second !== 'function' || third !== undefined) return null;
    callback = second as ResponseCallback;
  }

  return {
    bytes:
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk, encoding)
        : chunk.byteLength,
    callback,
  };
}

function isBufferedWriteHeadCall(args: unknown[]): boolean {
  if (args.length < 1 || args.length > 3) return false;
  const [statusCode, second, third] = args;
  if (
    typeof statusCode !== 'number' ||
    !Number.isInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 999
  ) {
    return false;
  }
  if (args.length === 1) return true;
  if (typeof second === 'string') {
    if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(second)) return false;
    return args.length === 2 || (args.length === 3 && isHeaderShape(third));
  }
  return args.length === 2 && isHeaderShape(second);
}

function isHeaderShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (Array.isArray(value)) {
      if (value.length % 2 !== 0) return false;
      for (let index = 0; index < value.length; index += 2) {
        const name = value[index];
        const headerValue = value[index + 1];
        if (typeof name !== 'string' || typeof headerValue !== 'string') {
          return false;
        }
        validateHeaderName(name);
        validateHeaderValue(name, headerValue);
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const [name, headerValue] of Object.entries(value)) {
      validateHeaderName(name);
      if (Array.isArray(headerValue)) {
        if (!headerValue.every((item) => typeof item === 'string')) return false;
        for (const item of headerValue) validateHeaderValue(name, item);
      } else if (
        typeof headerValue === 'string' ||
        typeof headerValue === 'number'
      ) {
        validateHeaderValue(name, String(headerValue));
      } else {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold the exact demo authority through the complete downstream operation.
 *
 * Express does not await downstream middleware after `next()`, so checking only
 * before `next()` leaves every asynchronous repository route able to return
 * after this credential or its database fixture is revoked. Buffer the Node
 * response primitives until `end()`, then revalidate both the process-local
 * generation and database row incarnation before committing any bytes. The
 * buffer is bounded and long-lived streams are deliberately not allowlisted.
 */
function fenceDemoResponse(
  res: Response,
  session: VerifiedDemoSession,
): void {
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  let boundary: 'pending' | 'verifying' | 'allowed' | 'denied' = 'pending';
  let bufferedBytes = 0;
  let bufferedEntries = 0;
  let bufferedHead: unknown[] | null = null;
  const bufferedWrites: unknown[][] = [];
  let bufferedEnd: unknown[] | null = null;
  const bufferedCallbacks: ResponseCallback[] = [];

  const rejectResponseCallback = (
    callback: ResponseCallback,
    error: Error,
  ): void => {
    queueMicrotask(() => {
      try {
        callback(error);
      } catch (callbackError) {
        log.warn('Sample response callback failed after denial', {
          error:
            callbackError instanceof Error
              ? callbackError.message
              : String(callbackError),
        });
      }
    });
  };

  const rejectBufferedCallbacks = (error: Error): void => {
    const callbacks = bufferedCallbacks.splice(0);
    for (const callback of callbacks) rejectResponseCallback(callback, error);
  };

  const deny = (reason = 'Sample response authority was revoked.'): void => {
    if (boundary === 'denied' || boundary === 'allowed') return;
    boundary = 'denied';
    rejectBufferedCallbacks(new Error(reason));
    const body = JSON.stringify({
      error: 'Sample session unavailable',
      message: 'Restart the sample tour to continue.',
    });
    for (const name of res.getHeaderNames()) res.removeHeader(name);
    res.statusCode = 401;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    Reflect.apply(originalWriteHead, res, [401]);
    Reflect.apply(originalEnd, res, [body]);
  };

  const flush = (): void => {
    if (boundary !== 'verifying' || !bufferedEnd) return;
    boundary = 'allowed';
    bufferedCallbacks.length = 0;
    if (bufferedHead) Reflect.apply(originalWriteHead, res, bufferedHead);
    for (const args of bufferedWrites) Reflect.apply(originalWrite, res, args);
    Reflect.apply(originalEnd, res, bufferedEnd);
  };

  const verifyAndFlush = async (): Promise<void> => {
    try {
      if (!isDemoSessionActive(session)) {
        deny();
        return;
      }
      const currentDemoUser = await userRepository.findDemoById(DEMO_USER_ID);
      const authorityMatches = matchesDemoFixtureIncarnation(
        currentDemoUser,
        session.fixtureIncarnation,
      );
      if (!authorityMatches || !isDemoSessionActive(session)) {
        if (!authorityMatches) {
          revokeDemoSessionByKey(session.sessionKey, session.expiresAtMs);
        }
        deny();
        return;
      }
      flush();
    } catch (error) {
      log.warn('Failed to revalidate sample authority before response', {
        error: error instanceof Error ? error.message : String(error),
      });
      deny();
    }
  };

  const appendEntry = (parsed: ParsedBodyCall): boolean => {
    const nextEntries = bufferedEntries + 1;
    const nextBytes = bufferedBytes + parsed.bytes;
    const nextCallbacks = bufferedCallbacks.length + (parsed.callback ? 1 : 0);
    if (
      nextEntries > MAX_BUFFERED_DEMO_RESPONSE_ENTRIES ||
      nextBytes > MAX_BUFFERED_DEMO_RESPONSE_BYTES ||
      nextCallbacks > MAX_BUFFERED_DEMO_RESPONSE_CALLBACKS
    ) {
      const error = new Error('Sample response exceeded its bounded buffer.');
      deny(error.message);
      if (parsed.callback) rejectResponseCallback(parsed.callback, error);
      return false;
    }
    bufferedEntries = nextEntries;
    bufferedBytes = nextBytes;
    if (parsed.callback) bufferedCallbacks.push(parsed.callback);
    return true;
  };

  res.writeHead = function guardedDemoWriteHead(
    ...args: unknown[]
  ): Response {
    if (boundary === 'allowed') {
      return Reflect.apply(originalWriteHead, res, args) as Response;
    }
    if (
      boundary !== 'pending' ||
      bufferedHead ||
      !isBufferedWriteHeadCall(args) ||
      !appendEntry({ bytes: 0, callback: null })
    ) {
      if (boundary === 'pending') deny('Sample response used an unsupported header shape.');
      return res;
    }
    bufferedHead = args;
    return res;
  } as Response['writeHead'];

  res.write = function guardedDemoWrite(...args: unknown[]): boolean {
    if (boundary === 'allowed') {
      return Reflect.apply(originalWrite, res, args) as boolean;
    }
    if (boundary !== 'pending') {
      const callback = parseBufferedBodyCall(args, false)?.callback;
      if (callback) {
        rejectResponseCallback(
          callback,
          new Error('Sample response is no longer writable.'),
        );
      }
      return false;
    }
    const parsed = parseBufferedBodyCall(args, false);
    if (!parsed) {
      deny('Sample response used an unsupported write shape.');
      return false;
    }
    if (!appendEntry(parsed)) return false;
    bufferedWrites.push(args);
    return true;
  } as Response['write'];

  res.end = function guardedDemoEnd(...args: unknown[]): Response {
    if (boundary === 'allowed') {
      return Reflect.apply(originalEnd, res, args) as Response;
    }
    if (boundary !== 'pending') {
      const callback = parseBufferedBodyCall(args, true)?.callback;
      if (callback) {
        rejectResponseCallback(
          callback,
          new Error('Sample response is no longer writable.'),
        );
      }
      return res;
    }
    const parsed = parseBufferedBodyCall(args, true);
    if (!parsed) {
      deny('Sample response used an unsupported end shape.');
      return res;
    }
    if (!appendEntry(parsed)) return res;
    bufferedEnd = args;
    boundary = 'verifying';
    void verifyAndFlush();
    return res;
  } as Response['end'];
}

/**
 * Hash a raw token with HMAC-SHA256 so we never store the raw token server-side.
 */
export function hashToken(token: string): string {
  return createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

/**
 * Constant-time comparison of a presented bearer token against the
 * per-install loopback service token (`SKYTWIN_SERVICE_TOKEN`).
 *
 * The desktop `ServiceManager` mints this value once per installation and
 * hands the same value to the API, the worker, and the idle-miner. It exists
 * because those daemons run under `NODE_ENV=production` in a packaged build,
 * where the dev auth bypass is off and they hold no human session — without a
 * credential every `/api/events/ingest` POST 401s and the product ingests
 * nothing.
 *
 * Read from `process.env` per request (not captured at module load) so a test
 * — or an operator restarting the API with a rotated token — sees the current
 * value. Returns false when the env var is unset or empty: no token
 * configured means no service auth, never "allow everything".
 */
function matchesServiceToken(presented: string): boolean {
  const expected = process.env['SKYTWIN_SERVICE_TOKEN'];
  if (typeof expected !== 'string' || expected.length === 0) return false;

  const presentedBuf = Buffer.from(presented, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` THROWS on a length mismatch, so the length guard has to
  // come first. Leaking the token length is not a meaningful oracle: it is a
  // fixed-width 64-char hex string minted by `randomBytes(32)`.
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/**
 * The ONLY routes the loopback service credential may reach.
 *
 * The worker and idle-miner exist to push signals in; they have no reason to
 * read or mutate a user's settings, policies, or approvals. `requireOwnership`
 * skips its check for a service-authenticated request (these daemons act for
 * every user on the install, so there is no single owning identity to match),
 * and `requireOwnership` guards ~33 routers — so without this allowlist the
 * credential would be a cross-user read/write capability for any local process
 * that can read the token file, not a narrow ingest key.
 */
const SERVICE_ROUTE_ALLOWLIST: readonly string[] = ['/api/events/ingest'];

function isServiceRouteAllowed(req: Request): boolean {
  // originalUrl, because this middleware is mounted per-router and `req.path`
  // is relative to the mount point.
  const path = (req.originalUrl ?? '').split('?')[0]?.replace(/\/+$/, '') || '';
  return SERVICE_ROUTE_ALLOWLIST.includes(path);
}

/**
 * Loopback check for the SERVICE credential specifically.
 *
 * Deliberately reads the raw socket address rather than `req.ip`. `req.ip`
 * honours `trust proxy` (the API sets it from TRUST_PROXY_HOPS), so a
 * spoofed `X-Forwarded-For: 127.0.0.1` could otherwise satisfy it. The
 * session path keeps using `isLocalhost` since it is additionally gated on a
 * real session token.
 */
function isSocketLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Check if a request originates from localhost.
 */
function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Session auth middleware.
 *
 * - When DEV_AUTH_BYPASS is true AND request is from localhost, auth is skipped.
 * - Otherwise, `Authorization: Bearer <token>` is required.
 * - A bearer token that matches `SKYTWIN_SERVICE_TOKEN` AND arrives from a
 *   loopback address authenticates the local worker / idle-miner. This is a
 *   DISTINCT path from the dev bypass and is available in production.
 * - SSE clients may pass `?token=<token>` because EventSource cannot set headers.
 * - On success, attaches `req.authenticatedUserId` and `req.authenticatedSessionId`.
 * - Auto-refreshes sessions within 1 day of expiry.
 */
export async function sessionAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Express may re-enter middleware on nested routers. Never let a stale
  // request-scoped grant survive into demo, dev-bypass, service, or failure.
  delete req.sourceKeySessionAuthority;
  const authHeader = req.headers['authorization'];
  const query = req.query ?? {};
  const queryToken = typeof query['token'] === 'string' ? query['token'] : undefined;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const token = bearerToken ?? queryToken;

  // Account-free packaged tour. This principal is always bound to the one
  // reserved synthetic identity and only reaches an explicit GET/HEAD
  // allowlist. It never enters the normal session table and cannot mutate the
  // fixture or select another user.
  const demoSession = token ? inspectDemoSession(token) : null;
  if (demoSession) {
    if (!isLocalDemoRequest(req.ip, req.socket.remoteAddress)) {
      res.status(403).json({
        error: 'The packaged sample is available from this device only.',
      });
      return;
    }
    if (!isDemoReadRequest(req.method, req.originalUrl ?? req.url)) {
      res.status(403).json({
        error: 'Sample mode is read-only',
        message: 'Start your own twin to make changes.',
      });
      return;
    }
    // The database row incarnation is the revocation boundary for this signed
    // credential. Re-check it for every read so clearing `is_demo`, deleting
    // the fixture, or replacing the reserved row invalidates prior issuance.
    const demoUser = await userRepository.findDemoById(DEMO_USER_ID);
    if (!demoUser) {
      revokeDemoSessionByKey(
        demoSession.sessionKey,
        demoSession.expiresAtMs,
      );
      res.status(401).json({
        error: 'Sample session unavailable',
        message: 'Restart the sample tour to continue.',
      });
      return;
    }
    if (!matchesDemoFixtureIncarnation(demoUser, demoSession.fixtureIncarnation)) {
      revokeDemoSessionByKey(demoSession.sessionKey, demoSession.expiresAtMs);
      res.status(401).json({
        error: 'Sample session unavailable',
        message: 'Restart the sample tour to continue.',
      });
      return;
    }
    // The marker lookup is asynchronous. Replacement, discard, or expiry may
    // win while it is pending, so never hand stale authority to a downstream
    // repository route.
    if (!isDemoSessionActive(demoSession)) {
      res.status(401).json({
        error: 'Sample session unavailable',
        message: 'Restart the sample tour to continue.',
      });
      return;
    }
    req.authenticatedUserId = DEMO_USER_ID;
    req.demoAuthenticated = true;
    fenceDemoResponse(res, demoSession);
    next();
    return;
  }

  // A credential that claims the reserved sample format stays on this narrow
  // path even when it is expired, malformed, replaced, or revoked. Letting it
  // fall through would turn it into broad unauthenticated traffic whenever the
  // localhost development bypass is enabled.
  if (token && isDemoSessionTokenCandidate(token)) {
    res.status(401).json({
      error: 'Invalid sample session',
      message: 'Restart the sample to continue.',
    });
    return;
  }

  // Dev-only localhost bypass (must be explicitly enabled or NODE_ENV=development).
  // Check the reserved sample credential path first: presenting that narrow
  // principal must never inherit the broader development bypass merely because
  // the request is loopback.
  if (DEV_AUTH_BYPASS && isLocalhost(req) && !token) {
    if (!bypassWarned) {
      log.warn(
        'Localhost auth bypass is ACTIVE. Set SKYTWIN_DEV_AUTH_BYPASS=false or NODE_ENV=production to require real auth.',
      );
      bypassWarned = true;
    }
    // No authenticatedUserId is available in this explicit localhost-only
    // mode. Mark it so a sensitive handler cannot mistake an accidentally
    // unprotected router mount for the configured development bypass.
    req.developmentAuthBypassed = true;
    next();
    return;
  }

  // Loopback service credential (worker / idle-miner). Deliberately narrower
  // than the human session path: header-only (never `?token=`), and only from
  // 127.0.0.1 / ::1. Both conditions plus a configured, matching secret are
  // required — none of them alone grants anything.
  // Read from a DEDICATED header, not `Authorization`. `apps/web` proxies
  // dashboard traffic to the API and forwards the `Authorization` header
  // verbatim from a new localhost connection — so if the service credential
  // rode on `Authorization`, a remote caller hitting the dashboard port could
  // launder a token through the proxy and arrive looking like loopback. The
  // proxy does not forward this header, which closes that path.
  const serviceToken = req.headers['x-skytwin-service-token'];
  if (
    typeof serviceToken === 'string' &&
    serviceToken.length > 0 &&
    isSocketLoopback(req) &&
    isServiceRouteAllowed(req) &&
    matchesServiceToken(serviceToken)
  ) {
    // These daemons forward signals for EVERY user on the install, so there
    // is no single owning identity to bind. We leave `authenticatedUserId`
    // unset and raise an explicit flag instead; `requireOwnership` keys off
    // that flag rather than off the absence of an identity, so the service
    // path stays intentional rather than accidentally inheriting the dev
    // bypass's "no identity means skip the check" behaviour.
    req.serviceAuthenticated = true;
    next();
    return;
  }

  if (!token) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'Scan the QR code from your desktop to connect.',
    });
    return;
  }
  const tokenHash = hashToken(token);

  const authentication = await sessionRepository.authenticateAndMaintain(tokenHash);
  if (authentication.status === 'unavailable') {
    res.status(503).json({
      error: 'Session store unavailable',
      message: 'Try again shortly.',
    });
    return;
  }
  if (authentication.status === 'inactive') {
    res.status(401).json({
      error: 'Invalid session',
      message: 'Scan the QR code again from your desktop.',
    });
    return;
  }
  const session = authentication.session;

  // Attach identity to request
  req.authenticatedUserId = session.user_id;
  req.authenticatedSessionId = session.id;

  // Authentication and lease maintenance are one Cockroach statement, so
  // concurrent requests all receive the canonical persisted expiry.
  const authorityExpiresAtMs = new Date(session.expires_at).getTime();

  // This is the sole production grant path. Revalidate the immutable session
  // identity, owner, token hash, revocation state, and exact current expiry
  // after the touch/refresh race before asking Electron for authority. Broker
  // unavailability does not break ordinary plaintext-era routes; it merely
  // leaves the request unable to perform source-key operations.
  try {
    const authorityInput = {
      sessionId: session.id,
      ownerId: session.user_id,
      tokenHash,
      expiresAtMs: authorityExpiresAtMs,
    };
    if (
      (await sessionRepository.revalidateSourceKeyAuthority(authorityInput)).status === 'active'
    ) {
      const grant = await apiSourceKeyBrokerClient.grantSession(authorityInput);
      if (grant.success) req.sourceKeySessionAuthority = grant.authority;
    }
  } catch {
    // Fail closed for source-key authority while preserving existing routes.
  }

  next();
}
