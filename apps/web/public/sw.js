/**
 * SkyTwin service worker (#403) — offline app shell + queued writes.
 *
 * Registered as a module worker (`type: 'module'`) so it can share the
 * pure routing/queue policy in `js/pwa/sw-policy.js` with the page and the
 * test suite. The worker owns the side-effecting half: Cache Storage,
 * IndexedDB, and the network.
 *
 * Behaviour:
 *   - install   → precache the app shell, then take over ASAP.
 *   - activate  → drop caches from older versions, claim open clients.
 *   - fetch     → route via classifyRequest():
 *       navigation       network-first, fall back to cached shell
 *       shell            cache-first (the offline promise)
 *       runtime          network-first, fall back to cache
 *       queueable-write  try network; on failure queue for replay + 503
 *       passthrough      don't intercept
 *   - sync / online / page message → replay the write queue.
 *
 * Safety note (CLAUDE.md invariant #8): the queue replays the user's OWN
 * writes verbatim with their OWN session token. It never synthesizes,
 * mutates, or re-targets a request, and it skips OAuth / pairing / stream
 * endpoints. It is not a new action source — it is a deferred send of an
 * action the user already took while the connection was down.
 */

import {
  SHELL_CACHE,
  RUNTIME_CACHE,
  PRECACHE_URLS,
  classifyRequest,
  serializeWrite,
  decideReplayOutcome,
} from '/js/pwa/sw-policy.js';

const QUEUE_DB = 'skytwin-write-queue';
const QUEUE_STORE = 'writes';
const SYNC_TAG = 'skytwin-replay-writes';

// ── Install: precache the shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic-ish: if any single asset 404s the whole install
      // fails. We add individually + tolerate misses so one renamed file
      // doesn't wedge the whole worker on deploy.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res.clone());
          } catch { /* asset optional — runtime cache will pick it up */ }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

// ── Activate: prune old caches, claim clients ───────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('skytwin-') && !keep.has(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// ── Fetch routing ───────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const route = classifyRequest(
    { method: request.method, url: request.url, mode: request.mode, headers: { accept: request.headers.get('accept') || '' } },
    self.location.origin,
  );

  if (route === 'passthrough') return; // let the browser handle it

  if (route === 'navigation') {
    event.respondWith(handleNavigation(request));
  } else if (route === 'shell') {
    event.respondWith(cacheFirst(request));
  } else if (route === 'runtime') {
    event.respondWith(networkFirst(request));
  } else if (route === 'queueable-write') {
    event.respondWith(handleWrite(request));
  }
});

async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    // Keep the shell cache warm with the freshest index for next offline.
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached =
      (await caches.match('/index.html')) || (await caches.match('/'));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset=utf-8><title>Offline</title><body style="font-family:system-ui;padding:2rem">SkyTwin is offline and no cached shell is available yet.</body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', details: 'No cached copy available.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

/**
 * Try the write against the network. On a network failure (the WiFi-blip
 * case this issue is about) serialize it into the IndexedDB queue, ask the
 * platform for a Background Sync, and answer the page with a 202-shaped
 * body so the UI can show "queued — will send when you're back online".
 */
async function handleWrite(request) {
  try {
    return await fetch(request.clone());
  } catch {
    try {
      const bodyText = await request.clone().text().catch(() => null);
      const write = serializeWrite({
        url: request.url,
        method: request.method,
        headersEntries: [...request.headers.entries()],
        bodyText,
      });
      await queuePut(write);
      await requestSync();
      await broadcast({ type: 'write-queued', count: await queueCount() });
      return new Response(
        JSON.stringify({ queued: true, queuedId: write.id, offline: true }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      );
    } catch {
      return new Response(
        JSON.stringify({ error: 'offline', queued: false }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }
}

// ── Background Sync + manual triggers ───────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(replayQueue());
});

// Page tells us it just came back online (covers browsers without
// Background Sync) or asks for the current queue depth.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'replay-now') event.waitUntil(replayQueue());
  if (data.type === 'queue-count') {
    event.waitUntil(
      (async () => {
        const count = await queueCount();
        broadcast({ type: 'queue-count', count });
      })(),
    );
  }
});

async function requestSync() {
  try {
    if ('sync' in self.registration) {
      await self.registration.sync.register(SYNC_TAG);
    }
  } catch { /* Background Sync unavailable — page online-listener covers it */ }
}

/**
 * Replay queued writes oldest-first. Each outcome is decided by the pure
 * `decideReplayOutcome` so the retry/drop branching is unit-tested. We
 * stop on the first 'retry' verdict for a transient failure so we don't
 * burn the whole queue against a flaky network in one pass — the next
 * sync / online event resumes.
 */
async function replayQueue() {
  const writes = await queueAll();
  writes.sort((a, b) => a.queuedAt - b.queuedAt);

  for (const write of writes) {
    let result;
    try {
      const res = await fetch(write.url, {
        method: write.method,
        headers: write.headers,
        body: write.body,
      });
      result = { ok: res.ok, status: res.status };
    } catch {
      result = { networkError: true };
    }

    const verdict = decideReplayOutcome(write, result);
    if (verdict === 'remove') {
      await queueDelete(write.id);
    } else if (verdict === 'drop') {
      await queueDelete(write.id);
      await broadcast({ type: 'write-dropped', id: write.id, url: write.url });
    } else {
      // retry: bump attempts, leave queued, and stop this pass if the
      // failure was a network error (we're still offline).
      write.attempts += 1;
      await queuePut(write);
      if (result.networkError) break;
    }
  }
  await broadcast({ type: 'queue-count', count: await queueCount() });
}

// ── IndexedDB queue store ───────────────────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore(db, mode) {
  return db.transaction(QUEUE_STORE, mode).objectStore(QUEUE_STORE);
}

async function queuePut(write) {
  const db = await openDb();
  await promisifyReq(txStore(db, 'readwrite').put(write));
  db.close();
}

async function queueDelete(id) {
  const db = await openDb();
  await promisifyReq(txStore(db, 'readwrite').delete(id));
  db.close();
}

async function queueAll() {
  const db = await openDb();
  const all = await promisifyReq(txStore(db, 'readonly').getAll());
  db.close();
  return all || [];
}

async function queueCount() {
  const db = await openDb();
  const count = await promisifyReq(txStore(db, 'readonly').count());
  db.close();
  return count || 0;
}

function promisifyReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function broadcast(message) {
  const all = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of all) client.postMessage(message);
}
