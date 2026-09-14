import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_LEGACY_SAMPLE_DISABLED,
  KEY_ONBOARDED,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
  assistantPendingRequestKey,
} from './storage-keys.js';

export const SAMPLE_USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SAMPLE_TOKEN_PREFIX = 'skytwin-demo-v1.';

const SAMPLE_KEYS = [
  KEY_SESSION_TOKEN,
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_TOUR_MODE,
  KEY_USER_ID,
  KEY_ONBOARDED,
  assistantPendingRequestKey(SAMPLE_USER_ID),
];

/** Read the tab-local sample state without treating it as real auth. */
export function readSampleSession() {
  try {
    return {
      token: sessionStorage.getItem(KEY_SESSION_TOKEN),
      expiresAt: sessionStorage.getItem(KEY_DEMO_SESSION_EXPIRES_AT),
      tourMode: sessionStorage.getItem(KEY_TOUR_MODE),
      userId: sessionStorage.getItem(KEY_USER_ID),
    };
  } catch {
    return { token: null, expiresAt: null, tourMode: null, userId: null };
  }
}

function isSampleToken(token) {
  return typeof token === 'string' && token.startsWith(SAMPLE_TOKEN_PREFIX);
}

export function hasRealAuthentication() {
  try {
    const token = localStorage.getItem(KEY_SESSION_TOKEN);
    return Boolean(token && !isSampleToken(token));
  } catch {
    return false;
  }
}

/**
 * A real credential always wins over disposable sample state in this tab.
 * sessionStorage is isolated per tab, so sample writes cannot race with a
 * login in another tab.
 */
export function isSampleMode() {
  try {
    if (hasRealAuthentication()) return false;
  } catch {
    return false;
  }
  const state = readSampleSession();
  return (
    state.tourMode === '1' &&
    state.userId === SAMPLE_USER_ID &&
    typeof state.token === 'string' &&
    state.token.length > 0
  );
}

export function getSampleToken() {
  return isSampleMode() ? readSampleSession().token : null;
}

export function getEffectiveAuthToken() {
  try {
    const token = localStorage.getItem(KEY_SESSION_TOKEN);
    return (token && !isSampleToken(token) ? token : null) || getSampleToken() || '';
  } catch {
    return getSampleToken() || '';
  }
}

export function getEffectiveUserId() {
  try {
    const realToken = localStorage.getItem(KEY_SESSION_TOKEN);
    const realUserId = localStorage.getItem(KEY_USER_ID);
    if (realToken && !isSampleToken(realToken)) return realUserId || '';
    if (isSampleMode()) return SAMPLE_USER_ID;
    if (isSampleToken(realToken) && realUserId === SAMPLE_USER_ID) return '';
    return realUserId || '';
  } catch {
    return isSampleMode() ? SAMPLE_USER_ID : '';
  }
}

export function hasCompletedOnboarding() {
  try {
    const marker = localStorage.getItem(KEY_ONBOARDED);
    return hasRealAuthentication() ? Boolean(marker) : Boolean(marker && marker !== 'sample');
  } catch {
    return false;
  }
}

/** Store a complete disposable session in this tab or fail without partial state. */
export function storeSampleSession(session) {
  clearSampleSession();
  try {
    sessionStorage.setItem(KEY_SESSION_TOKEN, session.token);
    sessionStorage.setItem(KEY_DEMO_SESSION_EXPIRES_AT, session.expiresAt);
    sessionStorage.setItem(KEY_USER_ID, SAMPLE_USER_ID);
    sessionStorage.setItem(KEY_TOUR_MODE, '1');
    sessionStorage.setItem(KEY_ONBOARDED, 'sample');
    if (!isSampleMode()) throw new Error('Sample session storage is unavailable.');
  } catch (error) {
    clearSampleSession();
    throw error;
  }
}

export function clearSampleSession() {
  try {
    for (const key of SAMPLE_KEYS) sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in hardened browser contexts. There is no
    // shared real credential to remove, so failing closed is safe.
  }
}

/**
 * Safely retire the pre-tab-isolation storage shape. We copy the exact
 * sample-shaped credential into this tab and atomically mark the shared legacy
 * shape disabled. We intentionally do not delete shared keys: another tab may
 * be writing real auth, and localStorage has no compare-and-delete primitive.
 */
export function migrateLegacySampleSession() {
  try {
    if (localStorage.getItem(KEY_LEGACY_SAMPLE_DISABLED) === '1') return false;
    const token = localStorage.getItem(KEY_SESSION_TOKEN);
    const userId = localStorage.getItem(KEY_USER_ID);
    const tourMode = localStorage.getItem(KEY_TOUR_MODE);
    const expiresAt = localStorage.getItem(KEY_DEMO_SESSION_EXPIRES_AT);
    if (
      !isSampleToken(token) ||
      userId !== SAMPLE_USER_ID ||
      tourMode !== '1' ||
      typeof expiresAt !== 'string'
    ) return false;
    storeSampleSession({ token, expiresAt });
    localStorage.setItem(KEY_LEGACY_SAMPLE_DISABLED, '1');
    return true;
  } catch {
    return false;
  }
}
