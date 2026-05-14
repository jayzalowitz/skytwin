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
    if (userId) {
      data = await getGoogleAuthUrl(userId, { desktop });
    } else {
      const params = new URLSearchParams({ newUser: 'true' });
      if (desktop) params.set('desktop', 'true');
      const res = await fetch(`/api/oauth/google/authorize?${params.toString()}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      data = await res.json();
    }
  } catch (err) {
    return { status: 'error', error: err?.message || 'Could not start Google sign-in.' };
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

function pollUntilConnected(userId, onComplete) {
  let pollCount = 0;
  const maxPolls = 150; // 5 minutes at 2s intervals
  const handle = setInterval(async () => {
    pollCount++;
    if (pollCount >= maxPolls) {
      clearInterval(handle);
      onComplete(false);
      return;
    }
    try {
      const status = await fetchOAuthStatus(userId, 'google');
      if (status.connected) {
        clearInterval(handle);
        onComplete(true);
      }
    } catch {
      // transient — keep polling
    }
  }, 2000);
}
