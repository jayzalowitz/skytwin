/**
 * Desktop auto-update banner — the user-facing half of the auto-updater
 * (`apps/desktop/src/auto-update.ts`, #370 follow-up).
 *
 * The desktop main process downloads updates in the background and pushes
 * lifecycle status to the renderer over the `skytwinDesktop.onUpdateStatus`
 * bridge: available → downloading(%) → ready-to-install (or error). This
 * module turns that stream into a single, persistent bottom-center banner that
 * updates IN PLACE (one element, re-rendered) rather than a stack of toasts.
 *
 * Why a bottom banner, not a top one: the top edge is already owned by the
 * autonomy (pause) banner and the connector re-auth banner, which reflow the
 * page via `body.has-autonomy-banner` padding. An update prompt is awareness-
 * with-action, not a panic state, so it floats at the bottom (like toasts) and
 * never fights that layout. DESIGN.md: the "Restart to update" CTA is the only
 * accent element here — it's the "needs you / act" action; everything else is
 * neutral.
 *
 * Design split for testability (the web app's test env is Node, no jsdom):
 *   - `computeUpdateBannerState(status, prev)` — PURE view-model decision.
 *     Encodes when the banner shows, the copy, and the error-suppression rule.
 *   - `renderUpdateBannerHtml(state)` — PURE HTML-string builder.
 *   - `wireDesktopUpdateBanner({ desktop, doc })` — thin DOM glue: subscribes,
 *     mounts, and routes the install/dismiss clicks via a delegated listener
 *     (no inline onclick — CLAUDE.md frontend rule).
 *
 * Copy is plain-language, no AI/internal jargon (a human reading "Update ready
 * to install" knows exactly what to do).
 */

import { escapeHtml } from '../api-client.js';

const BANNER_ID = 'skytwin-update-banner';

/**
 * Pure view-model: given the latest update status (and the previously-computed
 * banner state, for the error-suppression rule), decide what the banner shows.
 *
 * @param {{ status: string, version?: string, downloadPercent?: number, error?: string }} status
 * @param {ReturnType<typeof computeUpdateBannerState>|null} [prev]
 * @returns {{
 *   visible: boolean,
 *   phase: 'available'|'downloading'|'ready'|'error'|'idle',
 *   title: string,
 *   detail: string,
 *   percent: number|null,
 *   action: null | { action: 'install-update', label: string },
 *   dismissible: boolean,
 * }}
 */
export function computeUpdateBannerState(status, prev = null) {
  const idle = {
    visible: false,
    phase: 'idle',
    title: '',
    detail: '',
    percent: null,
    action: null,
    dismissible: false,
  };
  const version = status && typeof status.version === 'string' ? status.version : null;
  const versioned = (label) => (version ? `${label} ${version}` : label);

  switch (status?.status) {
    case 'available':
      // Auto-download is on, so "available" immediately becomes "downloading".
      // Show a quiet heads-up; no action yet, not dismissible (it's transient).
      return {
        visible: true,
        phase: 'available',
        title: 'Downloading an update…',
        detail: versioned('Getting version'),
        percent: null,
        action: null,
        dismissible: false,
      };
    case 'downloading': {
      const pct =
        typeof status.downloadPercent === 'number'
          ? Math.max(0, Math.min(100, Math.round(status.downloadPercent)))
          : null;
      return {
        visible: true,
        phase: 'downloading',
        title: 'Downloading an update…',
        detail: pct === null ? versioned('Getting version') : `${versioned('Version')} · ${pct}%`,
        percent: pct,
        action: null,
        dismissible: false,
      };
    }
    case 'ready-to-install':
      // The actionable state: a payload is downloaded and waiting. This is the
      // one "needs you / act" moment — accent CTA + dismissible ("Later").
      return {
        visible: true,
        phase: 'ready',
        title: 'Update ready to install',
        detail: version
          ? `Version ${version} is downloaded. Restart to finish updating.`
          : 'A new version is downloaded. Restart to finish updating.',
        percent: null,
        action: { action: 'install-update', label: 'Restart to update' },
        dismissible: true,
      };
    case 'error':
      // Only surface an error when an update was actually in flight (a download
      // started or a payload was ready). A routine background poll that can't
      // reach GitHub must NOT nag the user every 6 hours.
      if (!prev || !prev.visible) return idle;
      return {
        visible: true,
        phase: 'error',
        title: "Update couldn't finish",
        detail: status.error
          ? `${status.error}. It'll retry automatically.`
          : "Something went wrong downloading the update. It'll retry automatically.",
        percent: null,
        action: null,
        dismissible: true,
      };
    case 'no-update':
    default:
      return idle;
  }
}

/**
 * Pure HTML-string builder for a visible banner state. Returns '' when the
 * state is not visible. All interpolated values are escaped; the install action
 * uses `data-action` (delegated listener), never inline onclick.
 */
export function renderUpdateBannerHtml(state) {
  if (!state || !state.visible) return '';
  const progress =
    state.percent !== null
      ? `<div class="update-banner-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${state.percent}">
           <div class="update-banner-progress-fill" style="width:${state.percent}%"></div>
         </div>`
      : '';
  const action = state.action
    ? `<button class="btn btn-primary btn-sm" type="button" data-action="${escapeHtml(state.action.action)}">${escapeHtml(state.action.label)}</button>`
    : '';
  const dismiss = state.dismissible
    ? `<button class="update-banner-dismiss" type="button" data-action="dismiss-update-banner" aria-label="Dismiss update notice">×</button>`
    : '';
  return `
    <div class="update-banner-body">
      <div class="update-banner-text">
        <span class="update-banner-title">${escapeHtml(state.title)}</span>
        <span class="update-banner-detail">${escapeHtml(state.detail)}</span>
      </div>
      ${progress}
    </div>
    <div class="update-banner-actions">
      ${action}
      ${dismiss}
    </div>
  `;
}

/**
 * Thin DOM glue. Subscribes to the desktop update stream, mounts a single
 * banner element into `<body>`, and re-renders it in place on each status. The
 * install + dismiss buttons are routed through ONE delegated click listener on
 * the banner (wired once), per the CLAUDE.md "no inline onclick" rule.
 *
 * No-ops gracefully when not running inside the desktop app (the bridge is
 * absent in the browser/PWA).
 *
 * @param {{ desktop?: typeof window.skytwinDesktop, doc?: Document }} [opts]
 * @returns {(() => void)|undefined} unsubscribe, or undefined if not wired
 */
export function wireDesktopUpdateBanner(opts = {}) {
  const desktop = opts.desktop ?? (typeof window !== 'undefined' ? window.skytwinDesktop : undefined);
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!desktop || typeof desktop.onUpdateStatus !== 'function' || !doc) return undefined;

  let bannerEl = null;
  let lastState = null;
  // The user can dismiss the "ready" / "error" states; honor that until a NEW
  // phase arrives (a fresh download, or the app relaunches). Keyed by phase so
  // dismissing "ready" doesn't also suppress a later genuinely-new "ready".
  let dismissedPhase = null;

  function ensureBanner() {
    if (bannerEl && bannerEl.isConnected) return bannerEl;
    bannerEl = doc.getElementById(BANNER_ID);
    if (!bannerEl) {
      bannerEl = doc.createElement('div');
      bannerEl.id = BANNER_ID;
      bannerEl.className = 'update-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.setAttribute('aria-live', 'polite');
      bannerEl.hidden = true;
      doc.body.appendChild(bannerEl);
      // Delegated click listener, wired exactly once on the banner element.
      bannerEl.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('[data-action]') : null;
        if (!target) return;
        const action = target.getAttribute('data-action');
        if (action === 'install-update') {
          // installUpdate() resolves false on a dev/unsigned build that can't
          // install — surface that instead of pretending a restart is coming.
          Promise.resolve(desktop.installUpdate?.()).then((ok) => {
            if (ok === false) {
              const detail = bannerEl?.querySelector('.update-banner-detail');
              if (detail) detail.textContent = 'This build can’t self-update. Download the latest from the website.';
            }
          });
        } else if (action === 'dismiss-update-banner') {
          dismissedPhase = lastState?.phase ?? null;
          hide();
        }
      });
    }
    return bannerEl;
  }

  function hide() {
    if (bannerEl) {
      bannerEl.hidden = true;
      bannerEl.innerHTML = '';
      bannerEl.removeAttribute('data-phase');
    }
  }

  function apply(status) {
    const state = computeUpdateBannerState(status, lastState);
    lastState = state;
    // Respect a dismissal until the phase changes to something new.
    if (state.visible && state.dismissible && state.phase === dismissedPhase) return;
    if (!state.visible) {
      hide();
      return;
    }
    dismissedPhase = null;
    const el = ensureBanner();
    el.innerHTML = renderUpdateBannerHtml(state);
    el.setAttribute('data-phase', state.phase);
    el.hidden = false;
  }

  // Catch a status that fired before this wiring ran (page load races the
  // 6h-poll / initial check), then subscribe to the live stream.
  if (typeof desktop.getUpdateStatus === 'function') {
    Promise.resolve(desktop.getUpdateStatus())
      .then((s) => apply(s))
      .catch(() => {
        /* bridge unavailable mid-call — the live subscription still covers us */
      });
  }
  return desktop.onUpdateStatus(apply);
}
