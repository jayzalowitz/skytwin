/**
 * Desktop-side user preferences (#382 P2.2 + future).
 *
 * Backed by electron-store so the values survive a relaunch and live
 * in the OS-conventional userData directory (not in the renderer's
 * localStorage — main process needs to read them before the renderer
 * even loads, and we want the kill-switch / idle-pause state to
 * persist across reinstalls of the bundled web app).
 *
 * Today:
 *  - "pause when idle" toggle (#382, default ON).
 *  - "send anonymous crash reports" toggle (#399, default OFF — opt-in,
 *    to honor the privacy promise; nothing leaves the machine unless the
 *    user explicitly turns this on).
 *
 * New desktop-only prefs land here as the platform grows.
 */

import Store from 'electron-store';

interface DesktopPrefsShape {
  idlePauseEnabled: boolean;
  crashReportsEnabled: boolean;
}

// Mirrors the type-narrowing pattern in window-state.ts — Conf's ESM
// inheritance chain doesn't survive `module: commonjs`, so we name
// the structural surface explicitly.
type PrefsStore = {
  get<K extends keyof DesktopPrefsShape>(key: K): DesktopPrefsShape[K];
  set<K extends keyof DesktopPrefsShape>(key: K, value: DesktopPrefsShape[K]): void;
};

const store = new Store<DesktopPrefsShape>({
  name: 'skytwin-desktop-prefs',
  defaults: {
    idlePauseEnabled: true,
    // Default OFF — opt-in only. See crash-reporter.ts.
    crashReportsEnabled: false,
  },
}) as unknown as PrefsStore;

export function getIdlePauseEnabled(): boolean {
  return store.get('idlePauseEnabled');
}

export function setIdlePauseEnabled(value: boolean): void {
  store.set('idlePauseEnabled', value === true);
}

/**
 * Whether the user has opted in to anonymous crash reporting (#399).
 * Default OFF. The crash reporter checks this before sending anything.
 */
export function getCrashReportsEnabled(): boolean {
  return store.get('crashReportsEnabled');
}

export function setCrashReportsEnabled(value: boolean): void {
  store.set('crashReportsEnabled', value === true);
}
