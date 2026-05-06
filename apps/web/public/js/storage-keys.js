/**
 * Centralized localStorage key registry for the SkyTwin dashboard.
 *
 * Why this exists: storage keys were being constructed inline as
 * `skytwin_first_decision_seen_${userId}` across many files — easy to typo,
 * impossible to audit centrally, and makes "remove all keys for user X" hard.
 *
 * Conventions:
 * - Constants for keys with no per-user component.
 * - Builder functions for keys that include a userId or other suffix.
 * - The PREFIX is exported for sweep operations (tour exit, dev reset).
 */

/** All SkyTwin keys begin with this prefix. */
export const STORAGE_KEY_PREFIX = 'skytwin_';

// ── Identity / onboarding ─────────────────────────────────────────────

export const KEY_USER_ID = 'skytwin_userId';
export const KEY_ONBOARDED = 'skytwin_onboarded';
export const KEY_SESSION_TOKEN = 'skytwin_session_token';

// ── Tour / demo ────────────────────────────────────────────────────────

export const KEY_TOUR_MODE = 'skytwin_tour_mode';

// ── Notification opt-in ───────────────────────────────────────────────

/** Set to '1' once we've asked permission, so we don't re-prompt. */
export const KEY_NOTIF_ASKED = 'skytwin_notif_asked';
/** Set to '1' when the user dismissed the in-app opt-in card. */
export const KEY_NOTIF_DISMISSED = 'skytwin_notif_dismissed';

// ── Theme ──────────────────────────────────────────────────────────────

export const KEY_THEME_VARIANT = 'skytwin_theme_variant';
export const KEY_THEME_MODE = 'skytwin_theme_mode';

// ── Per-user keys (require a userId suffix) ───────────────────────────

/** Tracks the last time the user visited the dashboard, for "while you were away". */
export function lastVisitKey(userId) {
  return `skytwin_last_visit_${userId}`;
}

/** One-time toast flag for the user's first-ever decision. */
export function firstDecisionSeenKey(userId) {
  return `skytwin_first_decision_seen_${userId}`;
}

/** One-time tutorial card flag for the user's first-ever pending approval. */
export function firstApprovalIntroSeenKey(userId) {
  return `skytwin_first_approval_intro_seen_${userId}`;
}

/** One-time celebration toast for crossing into the next trust tier. */
export function tierCelebratedKey(userId, tier) {
  return `skytwin_tier_celebrated_${userId}_${tier}`;
}

/** Composer draft per assistant thread. Stored in sessionStorage so it
 * survives navigation within the tab but doesn't leak across sessions.
 * 'new' is the bucket for un-created threads (brand-new conversations). */
export function assistantDraftKey(threadId) {
  return `skytwin_assistant_draft_${threadId || 'new'}`;
}

// ── Sweep helpers ──────────────────────────────────────────────────────

/**
 * Remove every SkyTwin key from localStorage. Used when exiting tour mode
 * or for dev reset. Iterates in reverse so removal during enumeration is safe.
 */
export function clearAllSkyTwinKeys() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_KEY_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* private mode etc. */ }
}

/**
 * Remove every SkyTwin key whose name *contains* the given segment
 * (typically a userId). Used by tour exit to sweep state across all
 * per-user key shapes:
 *   - `skytwin_last_visit_<uid>`         (suffix: uid)
 *   - `skytwin_first_decision_seen_<uid>` (suffix: uid)
 *   - `skytwin_first_approval_intro_seen_<uid>` (suffix: uid)
 *   - `skytwin_tier_celebrated_<uid>_<tier>` (uid is in the middle!)
 *
 * Originally checked `endsWith(suffix)` which missed the tier-celebration
 * keys. We now match on either prefix-anchored boundaries (`_<uid>` or
 * `_<uid>_`) so tour state really does start from a clean slate.
 *
 * `alsoRemove` is the list of fixed-name (no per-user suffix) keys to
 * drop as well — KEY_TOUR_MODE, KEY_USER_ID, KEY_ONBOARDED, etc.
 */
export function clearKeysForSuffix(segment, alsoRemove = []) {
  try {
    for (const k of alsoRemove) localStorage.removeItem(k);
    if (!segment) return;
    const ending = `_${segment}`;
    const middle = `_${segment}_`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STORAGE_KEY_PREFIX)) continue;
      if (k.endsWith(ending) || k.includes(middle)) {
        localStorage.removeItem(k);
      }
    }
  } catch { /* noop */ }
}
