// Shared Google OAuth sign-in entry. Routes through the system browser
// when running inside the Electron desktop app so Google's passkey /
// WebAuthn flow (and Google's "secure browser" anti-WebView check) works.
// The `desktop` flag is sent to the authorize endpoint at sign time so
// the server can include it in the HMAC-signed state — mutating the
// signed state on the client breaks signature verification on the
// callback.

import { getGoogleAuthUrl, fetchOAuthStatus } from './api-client.js';

export function isDesktopApp() {
  return !!(typeof window !== 'undefined'
    && window.skytwinDesktop?.isDesktop
    && window.skytwinDesktop.openExternal);
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
 * @param {(connected: boolean) => void} [opts.onComplete]  Desktop + existing-user only — called when polling sees the account land, or when polling times out (with `false`).
 * @returns {Promise<{ status: 'redirecting' | 'polling' | 'error', error?: string }>}
 */
export async function startGoogleSignIn({ userId = null, newUser = false, next = null, onComplete } = {}) {
  const desktop = isDesktopApp();
  if (!newUser && !userId) {
    return {
      status: 'error',
      error: 'No signed-in user. Sign in first, then connect Google.',
    };
  }
  let data;
  try {
    // Both branches go through getGoogleAuthUrl -> fetchJSON so error
    // handling (ApiError, friendlyMessage, offline detection) stays
    // consistent with the rest of the codebase.
    data = newUser
      ? await getGoogleAuthUrl(null, { desktop, newUser: true, next })
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
    // Polling is keyed on userId — only the existing-user flow can poll.
    if (!newUser && userId && typeof onComplete === 'function') {
      pollUntilConnected(userId, onComplete);
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
