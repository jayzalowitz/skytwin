// Shared Google OAuth sign-in entry. Routes through the system browser
// when running inside the Electron desktop app so Google's passkey /
// WebAuthn flow (and Google's "secure browser" anti-WebView check) works.
// The `desktop` flag is sent to the authorize endpoint at sign time so
// the server can include it in the HMAC-signed state — mutating the
// signed state on the client breaks signature verification on the
// callback.

import { getGoogleAuthUrl, fetchOAuthStatus, fetchPendingSignin } from './api-client.js';

export function isDesktopApp() {
  return !!(typeof window !== 'undefined'
    && window.skytwinDesktop?.isDesktop
    && window.skytwinDesktop.openExternal);
}

/**
 * Generate a UUIDv4 for the desktop new-user pendingKey handoff.
 * Uses crypto.randomUUID() when available (every recent browser +
 * Electron); falls back to a getRandomValues construction for the
 * vanishingly rare case where it isn't.
 */
function generatePendingKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Polyfill: 16 random bytes, set the version (4) + variant nibbles
  // per RFC 4122 §4.4, format as 8-4-4-4-12 hex.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Start a Google sign-in flow.
 *
 * The new-user flow must be requested explicitly via `newUser: true` —
 * it is NOT inferred from a falsy `userId`. An existing-user entry point
 * that passes a missing `userId` gets an error, not a silent fallthrough
 * into a brand-new-user signup.
 *
 * @param {object} opts
 * @param {string|null} [opts.userId]   The existing user to connect. Required unless `newUser` is true.
 * @param {boolean} [opts.newUser]      Start the new-user (auto-create from verified email) flow.
 * @param {string|null} [opts.next]     Dashboard deep-link to land on post-callback (e.g. 'connect-gmail'). Server whitelists the value.
 * @param {(result: { connected: boolean, sessionToken?: string|null, userId?: string, accountEmail?: string, scopes?: string[], nextHash?: string|null }) => void} [opts.onComplete]
 *     Desktop only — called when polling resolves (existing-user or
 *     newUser flow). `{ connected: false }` on timeout. For the newUser
 *     pendingKey flow, `sessionToken` is the 7-day session minted by
 *     `/api/oauth/google/pending/:key` — callers must store it under
 *     `KEY_SESSION_TOKEN` so subsequent API calls authenticate. The
 *     existing-user `pollUntilConnected` path doesn't set it (the
 *     caller is already signed in via QR pairing or web redirect).
 * @returns {Promise<{ status: 'redirecting' | 'polling' | 'error', error?: string, code?: string, help?: string }>}
 */
export async function startGoogleSignIn({ userId = null, newUser = false, next = null, onComplete } = {}) {
  const desktop = isDesktopApp();
  if (!newUser && !userId) {
    return {
      status: 'error',
      error: 'No signed-in user. Sign in first, then connect Google.',
    };
  }
  // Desktop newUser flows need a pollable pendingKey so the wizard can
  // learn the just-created userId from /callback. Generated client-side
  // (crypto.randomUUID), validated to UUIDv4 shape server-side. Web
  // flows don't need this — the post-callback redirect carries the
  // userId in the URL.
  const pendingKey = desktop && newUser ? generatePendingKey() : null;
  let data;
  try {
    // Both branches go through getGoogleAuthUrl -> fetchJSON so error
    // handling (ApiError, friendlyMessage, offline detection) stays
    // consistent with the rest of the codebase.
    data = newUser
      ? await getGoogleAuthUrl(null, { desktop, newUser: true, next, pendingKey })
      : await getGoogleAuthUrl(userId, { desktop, next });
  } catch (err) {
    // Surface the structured server code (e.g. NO_GOOGLE_CLIENT_CONFIGURED)
    // so callers can route to the right setup card instead of just
    // showing a generic error message.
    return {
      status: 'error',
      error: err?.friendlyMessage || err?.message || 'Could not start Google sign-in.',
      code: err?.code || '',
      help: err?.help || '',
    };
  }
  if (!data?.url) {
    return { status: 'error', error: 'No authorize URL returned.' };
  }

  if (desktop) {
    await window.skytwinDesktop.openExternal(data.url);
    if (typeof onComplete === 'function') {
      if (pendingKey) {
        // newUser desktop flow — poll the pending-signin handoff.
        pollUntilPendingResolved(pendingKey, onComplete);
      } else if (!newUser && userId) {
        // Existing-user desktop flow — poll status by userId (unchanged).
        pollUntilConnected(userId, (connected) => onComplete({ connected }));
      }
    }
    return { status: 'polling' };
  }

  window.location.href = data.url;
  return { status: 'redirecting' };
}

// Single in-flight poll handle. A second startGoogleSignIn() call (retry,
// or a different entry point) cancels the previous poller instead of
// stacking a second interval that runs for the full 5-minute window.
let _activePollHandle = null;

function pollUntilConnected(userId, onComplete) {
  if (_activePollHandle !== null) {
    clearInterval(_activePollHandle);
    _activePollHandle = null;
  }
  let pollCount = 0;
  const maxPolls = 150; // 5 minutes at 2s intervals
  // Capture this poll's own handle. `stop` must clear the handle it was
  // started with — not whatever `_activePollHandle` happens to point at
  // when an async tick resumes, which a newer startGoogleSignIn() may
  // have already replaced.
  let handle;
  const stop = () => {
    clearInterval(handle);
    if (_activePollHandle === handle) _activePollHandle = null;
  };
  handle = setInterval(async () => {
    pollCount++;
    if (pollCount >= maxPolls) {
      stop();
      onComplete(false);
      return;
    }
    try {
      const status = await fetchOAuthStatus(userId, 'google');
      if (status.connected) {
        stop();
        onComplete(true);
      }
    } catch {
      // transient — keep polling
    }
  }, 2000);
  _activePollHandle = handle;
}

function pollUntilPendingResolved(pendingKey, onComplete) {
  if (_activePollHandle !== null) {
    clearInterval(_activePollHandle);
    _activePollHandle = null;
  }
  let pollCount = 0;
  const maxPolls = 150; // 5 minutes at 2s intervals
  let handle;
  const stop = () => {
    clearInterval(handle);
    if (_activePollHandle === handle) _activePollHandle = null;
  };
  handle = setInterval(async () => {
    pollCount++;
    if (pollCount >= maxPolls) {
      stop();
      onComplete({ connected: false });
      return;
    }
    try {
      const result = await fetchPendingSignin(pendingKey);
      if (result && result.connected) {
        stop();
        // The pending endpoint mints a session in-process and returns
        // the token — the wizard becomes that user without ever having
        // to call the unauthenticated `POST /api/sessions` shim. The
        // pendingKey IS the credential; consume-on-read makes it
        // one-shot.
        onComplete({
          connected: true,
          sessionToken: typeof result.sessionToken === 'string' ? result.sessionToken : null,
          userId: result.userId,
          accountEmail: result.accountEmail,
          scopes: Array.isArray(result.scopes) ? result.scopes : [],
          nextHash: result.nextHash ?? null,
        });
      }
    } catch {
      // transient — keep polling. 404 is the common case
      // (callback hasn't fired yet); ApiError(kind:'not-found')
      // lands here and we just keep going.
    }
  }, 2000);
  _activePollHandle = handle;
}
