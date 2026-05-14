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
 * @param {object} opts
 * @param {string|null} [opts.userId]   Existing user, or null for new-user.
 * @param {(connected: boolean) => void} [opts.onComplete]  Desktop only — called when polling sees the account land, or when polling times out (with `false`).
 * @returns {Promise<{ status: 'redirecting' | 'polling' | 'error', error?: string }>}
 */
export async function startGoogleSignIn({ userId = null, onComplete } = {}) {
  const desktop = isDesktopApp();
  let data;
  try {
    // Both branches go through getGoogleAuthUrl -> fetchJSON so error
    // handling (ApiError, friendlyMessage, offline detection) stays
    // consistent with the rest of the codebase.
    data = userId
      ? await getGoogleAuthUrl(userId, { desktop })
      : await getGoogleAuthUrl(null, { desktop, newUser: true });
  } catch (err) {
    return {
      status: 'error',
      error: err?.friendlyMessage || err?.message || 'Could not start Google sign-in.',
    };
  }
  if (!data?.url) {
    return { status: 'error', error: 'No authorize URL returned.' };
  }

  if (desktop) {
    await window.skytwinDesktop.openExternal(data.url);
    if (userId && typeof onComplete === 'function') {
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
  const stop = () => {
    clearInterval(_activePollHandle);
    _activePollHandle = null;
  };
  _activePollHandle = setInterval(async () => {
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
}
