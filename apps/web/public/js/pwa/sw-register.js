/**
 * Service-worker registration + offline UX wiring for the dashboard (#403).
 *
 * Loaded early from index.html (a tiny module, no app deps) so the worker
 * installs and the offline indicator works even on pages that haven't
 * mounted the full SPA yet. Responsibilities:
 *
 *   1. Register `/sw.js` (module worker, root scope).
 *   2. Drive a clear, persistent "Offline" badge off the browser's
 *      online/offline events — independent of the API-reachability banner
 *      app.js already shows, because losing the network is a distinct
 *      state ("you're offline; we cached the last view") from "the API is
 *      down but you're online".
 *   3. On reconnect, tell the worker to replay any queued writes and show
 *      the user how many are pending / synced.
 *
 * No inline event handlers (CLAUDE.md) — everything is addEventListener.
 * Degrades gracefully: if `serviceWorker` is unavailable the offline
 * badge still works (it only needs `navigator.onLine` + the online/offline
 * events), there's just no write-queue replay.
 */

const OFFLINE_BADGE_ID = 'skytwin-offline-badge';

let _registration = null;

export function initPwa() {
  // Idempotent — safe if a test or hot-reload calls it twice.
  if (window.__skytwinPwaInit) return;
  window.__skytwinPwaInit = true;

  wireOfflineIndicator();
  wireServiceWorkerMessages();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Register after load so the SW install fetch doesn't compete with the
  // first paint's critical requests.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { type: 'module', scope: '/' })
      .then((reg) => {
        _registration = reg;
      })
      .catch(() => {
        // Registration can fail on http: (non-localhost) or in private
        // mode. The app still works online; we just lose offline caching.
      });
  });
}

/**
 * Show/hide a fixed "Offline" badge and reflect online/offline in a body
 * class other CSS / app.js can key off. Renders once on init to capture
 * the state at load (the user may open the tab already offline).
 */
function wireOfflineIndicator() {
  const render = () => setOfflineState(!navigator.onLine);
  window.addEventListener('online', () => {
    setOfflineState(false);
    triggerReplay();
  });
  window.addEventListener('offline', () => setOfflineState(true));
  render();
}

function setOfflineState(isOffline) {
  document.body?.classList.toggle('is-offline', isOffline);
  if (isOffline) {
    ensureBadge().hidden = false;
  } else {
    const badge = document.getElementById(OFFLINE_BADGE_ID);
    if (badge) badge.hidden = true;
  }
}

function ensureBadge() {
  let badge = document.getElementById(OFFLINE_BADGE_ID);
  if (badge) return badge;
  badge = document.createElement('div');
  badge.id = OFFLINE_BADGE_ID;
  badge.className = 'offline-badge';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  // Static markup (no user data) — built with textContent-safe children
  // so nothing untrusted ever reaches innerHTML.
  const dot = document.createElement('span');
  dot.className = 'offline-badge-dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'offline-badge-text';
  text.textContent = "Offline — showing your last-loaded view. Changes you make will sync when you're back.";
  badge.append(dot, text);
  document.body.appendChild(badge);
  return badge;
}

/** Ask the active worker to flush the write queue now. */
function triggerReplay() {
  const sw = navigator.serviceWorker;
  if (!sw || !sw.controller) return;
  sw.controller.postMessage({ type: 'replay-now' });
}

/**
 * Surface queue activity to the user via the global toast. Imported
 * lazily so this module stays dependency-light and registration isn't
 * blocked on the toast module loading.
 */
function wireServiceWorkerMessages() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const data = event.data || {};
    let toast;
    try {
      ({ showToast: toast } = await import('../toast.js'));
    } catch {
      return; // toast unavailable — message is informational only
    }
    if (data.type === 'write-queued') {
      toast(
        `You're offline — your change is queued and will send when you reconnect (${data.count} pending).`,
        { kind: 'warning' },
      );
    } else if (data.type === 'write-dropped') {
      toast(
        "Couldn't sync one of your offline changes after several tries. Please try that action again.",
        { kind: 'danger' },
      );
    } else if (data.type === 'queue-count' && data.count === 0) {
      // Fired after a successful replay pass empties the queue.
      toast('Back online — your queued changes have been sent.', { kind: 'success' });
    }
  });
}
