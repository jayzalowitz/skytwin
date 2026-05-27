/**
 * First-close-toast state machine (#381 P2.1).
 *
 * On macOS clicking the close button hides the window rather than
 * quitting — the app keeps running in the tray so it can act on
 * signals. Users who don't read tutorial copy reach for ⌘W, see
 * the window vanish, and assume the app is dead. Meanwhile we're
 * still polling Gmail and burning battery.
 *
 * Fix: the first time the user closes the window in a given
 * session, push a toast through the desktop→renderer bridge:
 *
 *     "SkyTwin keeps running so it can act on signals.
 *      Quit fully from the menu bar icon."
 *
 * Subsequent closes in the same session don't re-trigger — the
 * user got the message; nagging is rude. Across sessions we DO
 * show it again, because the spec scopes the suppression to one
 * session (it's a hint, not a one-time onboarding step).
 *
 * The helper is intentionally pure — no Electron API, no IPC, no
 * side effects. The Electron wiring in main.ts owns the IPC send;
 * this module just answers "should I send?" and tracks the flip.
 */

export interface FirstCloseToastState {
  /** True once the toast has fired in this session. */
  shown: boolean;
}

/** Fresh state at process start. */
export function createFirstCloseToastState(): FirstCloseToastState {
  return { shown: false };
}

/**
 * Returns true exactly once per session — the first call flips
 * `shown` to true, every subsequent call returns false.
 *
 * Mutates `state` in place so the caller's reference stays the
 * authority on session-level "have we shown it" status. The
 * mutation is the entire point of the helper — callers that want
 * a non-mutating check can read `state.shown` directly.
 */
export function shouldShowFirstCloseToast(state: FirstCloseToastState): boolean {
  if (state.shown) return false;
  state.shown = true;
  return true;
}
