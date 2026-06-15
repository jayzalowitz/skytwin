/**
 * Pure routing + queueing policy for the SkyTwin service worker (#403).
 *
 * This module holds the *decisions* the service worker makes — which
 * fetches to serve from cache, which to pass through, and which writes to
 * queue for replay when the connection returns. It deliberately touches
 * NONE of the worker-only globals (`self`, `caches`, `indexedDB`,
 * `clients`) so it can be imported and exercised under vitest's plain
 * node environment. `sw.js` wires these decisions to the real Cache /
 * IndexedDB / fetch APIs.
 *
 * Why split it out: the two failure modes that matter for an offline PWA
 * — "served the wrong thing from cache" and "dropped / double-replayed a
 * queued write" — are exactly the kind of logic that compiles and passes
 * a smoke test while being subtly wrong. Pulling them into pure functions
 * lets the tests pin the behaviour down (see `__tests__/sw-policy.test.js`).
 */

/** Bump this whenever the precache list or shell strategy changes — old
 * caches are pruned on `activate` by name prefix. */
export const CACHE_VERSION = 'v1';
export const SHELL_CACHE = `skytwin-shell-${CACHE_VERSION}`;
export const RUNTIME_CACHE = `skytwin-runtime-${CACHE_VERSION}`;

/**
 * The minimal set of same-origin assets that make the SPA boot offline.
 * `index.html` is the navigation fallback; the rest are the JS/CSS the
 * shell needs before it can render *anything*. Page-level data still
 * comes from the network (and shows the last-loaded state when it can't).
 *
 * Kept intentionally small: precaching every page module would bloat the
 * install step and stale-pin modules across deploys. Non-listed same-
 * origin GETs are cached lazily by `classifyRequest` → 'runtime'.
 */
export const PRECACHE_URLS = Object.freeze([
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html',
  '/css/styles.css',
  '/css/themes.css',
  '/css/assistant.css',
  '/js/app.js',
  '/js/api-client.js',
  '/js/storage-keys.js',
  '/js/toast.js',
  '/js/format.js',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
]);

/** HTTP methods that mutate server state — the ones we queue when offline. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Methods/paths the queue must NEVER replay, because replaying them is
 * either meaningless or actively harmful after the fact:
 *   - SSE / streaming endpoints (assistant message stream) — a replayed
 *     stream POST would produce a duplicate assistant turn.
 *   - auth/session exchange — a stale pairing token is single-use and
 *     replaying it produces a confusing "already used" error.
 * Matched as path prefixes (after the leading /api).
 */
const NON_REPLAYABLE_PREFIXES = Object.freeze([
  '/api/assistant/messages', // streamed; replay would duplicate a turn
  '/api/sessions/pair',      // single-use pairing tokens
  '/api/oauth',              // OAuth handshakes are time-sensitive
]);

/**
 * Decide how the worker should handle a request.
 *
 * Returns one of:
 *   - 'navigation' — top-level document load. Network-first, fall back to
 *     the cached shell so a WiFi blip shows the last app shell rather
 *     than the browser's dino.
 *   - 'shell'      — a precached static asset. Cache-first (fast, and the
 *     thing we promise works offline).
 *   - 'runtime'    — other same-origin GETs (page data, icons we didn't
 *     precache). Network-first with a cache fallback.
 *   - 'queueable-write' — a same-origin mutating API call. The caller
 *     attempts the network; on failure it enqueues for replay.
 *   - 'passthrough' — everything else (cross-origin, non-GET reads we
 *     don't model, etc.). The worker does not intercept.
 *
 * @param {{ method: string, url: string }} req
 * @param {string} origin  e.g. 'https://localhost:3200'
 */
export function classifyRequest(req, origin) {
  const method = (req?.method || 'GET').toUpperCase();
  let parsed;
  try {
    parsed = new URL(req.url, origin);
  } catch {
    return 'passthrough';
  }

  // Only ever intercept our own origin. Fonts/CDNs handle their own caching.
  if (parsed.origin !== origin) return 'passthrough';

  if (method === 'GET') {
    // Treat HTML document loads as navigations. The SW spec exposes
    // `request.mode === 'navigate'`; we also accept an Accept: text/html
    // hint so the pure function is testable without a Request object.
    if (req.mode === 'navigate' || isHtmlAccept(req)) return 'navigation';
    if (isPrecached(parsed.pathname)) return 'shell';
    return 'runtime';
  }

  if (WRITE_METHODS.has(method) && parsed.pathname.startsWith('/api/')) {
    return isReplayable(parsed.pathname) ? 'queueable-write' : 'passthrough';
  }

  return 'passthrough';
}

function isHtmlAccept(req) {
  const accept = req?.headers?.accept || req?.accept || '';
  return typeof accept === 'string' && accept.includes('text/html');
}

/** True when `pathname` is in the precache list (query/hash already stripped). */
export function isPrecached(pathname) {
  return PRECACHE_URLS.includes(pathname);
}

/** True when a mutating API path is safe to queue + replay later. */
export function isReplayable(pathname) {
  return !NON_REPLAYABLE_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Serialize a fetch Request-like object into a plain, structured-clone-
 * safe record we can stash in IndexedDB and replay later. Body is read by
 * the caller (async) and passed in as text.
 *
 * @param {{ url: string, method: string, headersEntries?: Array<[string,string]>, bodyText?: string|null }} input
 * @param {() => string} [idFactory]  testable id generator
 * @returns {QueuedWrite}
 */
export function serializeWrite(input, idFactory) {
  const genId = idFactory || defaultId;
  return {
    id: genId(),
    url: input.url,
    method: (input.method || 'POST').toUpperCase(),
    headers: sanitizeHeaders(input.headersEntries || []),
    body: input.bodyText ?? null,
    queuedAt: Date.now(),
    attempts: 0,
  };
}

/**
 * Strip hop-by-hop / unsafe headers from a replayed write. We keep
 * Content-Type and Authorization (the user's own session token) but drop
 * anything the browser must set itself (Content-Length, Host) or that
 * would be stale on replay.
 */
function sanitizeHeaders(entries) {
  const out = {};
  const drop = new Set(['content-length', 'host', 'connection', 'cookie']);
  for (const [k, v] of entries) {
    const key = String(k).toLowerCase();
    if (drop.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function defaultId() {
  // crypto.randomUUID is available in SW + node 20+. Guarded so the pure
  // module never throws if a caller runs it in an exotic environment.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Max replay attempts before we give up on a queued write and drop it. */
export const MAX_REPLAY_ATTEMPTS = 5;

/**
 * Given a queued write and the outcome of a replay attempt, decide what to
 * do with it. Pure so the replay loop's branching is unit-tested.
 *
 *   - 'remove'  — replay succeeded (2xx/3xx) OR the server rejected it with
 *     a 4xx that won't change on retry (replaying it again is pointless).
 *   - 'retry'   — transient failure (network error / 5xx) and we're under
 *     the attempt cap. Caller bumps `attempts` and leaves it queued.
 *   - 'drop'    — exhausted the attempt cap. Caller removes it and surfaces
 *     a "couldn't sync" notice.
 *
 * @param {QueuedWrite} write
 * @param {{ ok: boolean, status?: number, networkError?: boolean }} result
 */
export function decideReplayOutcome(write, result) {
  if (result.networkError) {
    return write.attempts + 1 >= MAX_REPLAY_ATTEMPTS ? 'drop' : 'retry';
  }
  if (result.ok) return 'remove';
  const status = result.status ?? 0;
  // 4xx (except 408 Request Timeout / 429 Too Many Requests) won't fix
  // themselves — drop so we don't loop forever on a bad request.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'remove';
  }
  // 5xx / 408 / 429 — transient. Retry until the cap.
  return write.attempts + 1 >= MAX_REPLAY_ATTEMPTS ? 'drop' : 'retry';
}

/**
 * @typedef {Object} QueuedWrite
 * @property {string} id
 * @property {string} url
 * @property {string} method
 * @property {Record<string,string>} headers
 * @property {string|null} body
 * @property {number} queuedAt
 * @property {number} attempts
 */
