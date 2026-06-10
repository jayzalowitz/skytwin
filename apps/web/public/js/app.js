import { renderDashboard, initDashboardGlobals, invalidateDashboardCache } from './pages/dashboard.js';
import { renderApprovals } from './pages/approvals.js';
import { renderDecisions } from './pages/decisions.js';
import { renderActivity } from './pages/activity.js';
import { renderTwin } from './pages/twin.js';
import { renderSettings } from './pages/settings.js';
import { renderAudit } from './pages/audit.js';
import { renderSetup } from './pages/setup.js';
import { renderConnectGmail } from './pages/connect-gmail.js';
import { renderAssistant } from './pages/assistant.js';
import { renderOnboarding } from './pages/onboarding.js';
import { renderCapabilities } from './pages/capabilities.js';
import { renderCapabilityDetail } from './pages/capability-detail.js';
import { renderCapabilitiesAudit } from './pages/capabilities-audit.js';
import { renderAboutMe } from './pages/about-me.js';
import { renderCredentialVault } from './pages/credential-vault.js';
import { renderTwinBriefing } from './pages/twin-briefing.js';
import { renderTwinServerTokens } from './pages/twin-server-tokens.js';
import { renderDxtImports } from './pages/dxt-imports.js';
import { renderProvenanceGraph } from './pages/provenance-graph.js';
import { renderMemorySettings } from './pages/memory-settings.js';
import { renderLifebook } from './pages/lifebook.js';
import { renderGlobalPauseButton } from './components/global-pause-button.js';
import { fetchPendingApprovals, fetchHealth, fetchUser, listUsers, escapeHtml, isApiKnownOffline, fetchJSON } from './api-client.js';
import { initTheme } from './theme-switcher.js';
import { initA11y } from './a11y.js';
import { connectSSE, disconnectSSE, isConnected } from './sse-client.js';
import { showToast } from './toast.js';
import { KEY_USER_ID, KEY_ONBOARDED, KEY_SESSION_TOKEN, clearAllSkyTwinKeys } from './storage-keys.js';

let currentUserId = localStorage.getItem(KEY_USER_ID) || '';

const routes = {
  '/': { title: 'Home', render: renderDashboard },
  '/assistant': { title: 'Chat', render: renderAssistant },
  '/approvals': { title: 'Needs your OK', render: renderApprovals },
  '/decisions': { title: 'What happened', render: renderDecisions },
  '/activity': { title: "What's been happening", render: renderActivity },
  // UX review #13 — sidebar + page header speak the same voice now.
  '/twin': { title: "What I've learned", render: renderTwin },
  '/settings': { title: 'Settings', render: renderSettings },
  '/audit': { title: 'Audit Trail', render: renderAudit },
  '/setup': { title: 'Connect', render: renderSetup },
  '/connect-gmail': { title: 'Connect Gmail', render: renderConnectGmail },
  '/capabilities': { title: 'Capabilities', render: renderCapabilities },
  '/capabilities/audit': { title: 'Capability Audit Trail', render: renderCapabilitiesAudit },
  '/about-me': { title: 'About me', render: renderAboutMe },
  '/briefing': { title: 'Briefing', render: renderTwinBriefing },
  '/twin-server-tokens': { title: 'MCP Agent Tokens', render: renderTwinServerTokens },
  '/provenance': { title: 'Provenance Graph', render: renderProvenanceGraph },
  '/credential-vault': { title: 'Credential Vault', render: renderCredentialVault },
  '/dxt/imports': { title: 'DXT Imports', render: renderDxtImports },
  '/memory-settings': { title: 'Memory backend', render: renderMemorySettings },
};

/**
 * Check if onboarding is needed.
 *
 * KEY_ONBOARDED state machine (see #362):
 *   null / absent  → never onboarded; show modal
 *   'true'         → completed full wizard
 *   'skipped'      → dismissed via Esc / X / Skip link
 *   'sample'       → entered via "Try with a sample profile"
 * Any non-null value means "no modal" — the user has made a choice.
 */
function needsOnboarding() {
  return !localStorage.getItem(KEY_ONBOARDED);
}

/**
 * Hide the onboarding overlay and tear down its Esc handler.
 *
 * Exposed at module scope so the dismiss paths (Esc / X / Skip) and the
 * completion paths inside the wizard share one teardown. Callers that
 * want to record a particular dismiss reason should write KEY_ONBOARDED
 * BEFORE calling this — hideOnboarding does not touch localStorage.
 */
function hideOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.style.display = 'none';
  if (_onboardingEscHandler) {
    document.removeEventListener('keydown', _onboardingEscHandler);
    _onboardingEscHandler = null;
  }
  updateConnectionStatus();
}

let _onboardingEscHandler = null;

/**
 * Dismiss the modal as "skipped" — user pressed Esc, the X button, or
 * the "Skip for now" link. Records the dismiss reason in localStorage so
 * the modal does not re-mount on reload, then re-renders the chrome.
 */
function dismissOnboardingAsSkipped() {
  localStorage.setItem(KEY_ONBOARDED, 'skipped');
  hideOnboarding();
  navigate();
}

window.skyTwinDismissOnboarding = dismissOnboardingAsSkipped;

/**
 * Tear down the modal's Esc listener WITHOUT touching localStorage or
 * mounting any other side-effects. Used by the wizard's internal
 * `hideWizard()` (onboarding.js) so completion paths that don't go
 * through the dismiss UX (OAuth callback, "Continue to dashboard"
 * button) still drop the document-level keydown listener.
 */
window.skyTwinTeardownOnboardingEsc = () => {
  if (_onboardingEscHandler) {
    document.removeEventListener('keydown', _onboardingEscHandler);
    _onboardingEscHandler = null;
  }
};

/**
 * Show the onboarding overlay.
 */
function showOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  overlay.style.display = 'flex';

  // Esc-to-dismiss. Wired once per show, torn down by hideOnboarding so
  // the listener doesn't leak across modal lifecycles. Singleton-guarded
  // via the module-level handle.
  if (!_onboardingEscHandler) {
    _onboardingEscHandler = (e) => {
      if (e.key !== 'Escape') return;
      if (overlay.style.display === 'none') return;
      e.preventDefault();
      dismissOnboardingAsSkipped();
    };
    document.addEventListener('keydown', _onboardingEscHandler);
  }

  renderOnboarding(
    document.getElementById('onboarding-content'),
    (userId) => {
      currentUserId = userId;
      localStorage.setItem(KEY_USER_ID, userId);
      // Don't overwrite a 'sample' marker the tour-mode click handler
      // wrote — the chrome banner work (P2 follow-up) keys off it.
      const existing = localStorage.getItem(KEY_ONBOARDED);
      if (existing !== 'sample') {
        localStorage.setItem(KEY_ONBOARDED, 'true');
      }
      hideOnboarding();
      navigate();
    },
  );
}

/**
 * Render the user-switcher in the header. Clicking the badge opens a dropdown
 * listing all users; click one to switch. Surfaces the data the dashboard
 * already has — there's no auth ceremony in dev — and unblocks the case
 * where localStorage holds a userId that has no signals/approvals.
 */
/**
 * Render the user badge in the header.
 *
 * UX review #2 (P0): pre-fix, when the API was down (or the user
 * record couldn't be loaded), the badge fell back to the raw UUID
 * `11111111-2222-…`. A non-technical user reads that and reasonably
 * wonders "what is that hex code, did something break?" Now: when no
 * name/email is available we render a friendly "You" label with the
 * first 4 chars of the userId in a tooltip for devs who need it.
 */
function userBadgeFallback(uid) {
  // 'You' is friendlier than a UUID. The tooltip keeps the first 4
  // chars visible-on-hover so the dev "switch user" workflow still has
  // a hint of which account is active.
  return uid ? `You (${uid.slice(0, 4)}…)` : 'You';
}
function renderUserBadge() {
  const badge = document.getElementById('user-badge');
  if (!badge) return;

  // Optimistic friendly fallback while the API call resolves — shows
  // "You" instead of a flash of the raw UUID under slow networks.
  badge.textContent = userBadgeFallback(currentUserId);

  // Friendly current label from the user record when available.
  fetchUser(currentUserId).then((data) => {
    const u = data?.user ?? data;
    badge.textContent = u?.name || u?.email || userBadgeFallback(currentUserId);
  }).catch(() => {
    badge.textContent = userBadgeFallback(currentUserId);
  });

  if (badge.dataset.switcherWired === 'true') return;
  badge.dataset.switcherWired = 'true';
  badge.style.cursor = 'pointer';
  badge.title = 'Switch user';

  badge.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.getElementById('user-switcher-menu')?.remove();

    let users = [];
    try {
      users = await listUsers();
    } catch {
      users = [];
    }

    const menu = document.createElement('div');
    menu.id = 'user-switcher-menu';
    menu.style.cssText = `position: absolute; right: 1rem; top: 3.5rem; z-index: 1000; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: 0 6px 24px rgba(0,0,0,0.25); min-width: 240px; padding: 0.4rem 0;`;

    if (users.length === 0) {
      menu.innerHTML = `<div style="padding: 0.6rem 0.9rem; color: var(--text-muted); font-size: 0.85rem;">No users found.</div>`;
    } else {
      menu.innerHTML = users.map((u) => {
        const label = escapeHtml(u.name || u.email || u.id);
        const sub = escapeHtml(u.email || '');
        const isCurrent = u.id === currentUserId;
        return `
          <button data-user-id="${escapeHtml(u.id)}" style="display: block; width: 100%; text-align: left; padding: 0.5rem 0.9rem; background: ${isCurrent ? 'var(--bg-hover)' : 'transparent'}; border: 0; cursor: pointer; color: var(--text); font-size: 0.85rem;">
            <div style="font-weight: 500;">${label}${isCurrent ? ' <span style="color: var(--text-muted); font-weight: normal;">(current)</span>' : ''}</div>
            ${sub && sub !== label ? `<div style="color: var(--text-muted); font-size: 0.75rem;">${sub}</div>` : ''}
          </button>
        `;
      }).join('');
    }

    document.body.appendChild(menu);

    menu.querySelectorAll('button[data-user-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-user-id');
        if (id && id !== currentUserId) setUserId(id);
        menu.remove();
      });
    });

    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  });
}

// Default tab title — captured once so we can restore it after the
// pending-count prefix gets prepended/cleared.
const DEFAULT_DOC_TITLE = document.title;

// Repaint the SVG favicon based on whether anything is waiting on the
// user. Switches from the default blue mark to a warning-yellow mark
// when there's at least one pending approval, so the tab strip catches
// the eye even when the title is truncated. Guarded so we don't trigger
// a browser repaint on every 30s poll when nothing has changed.
let _lastFaviconPending = null;
function setFaviconForPending(hasPending) {
  if (_lastFaviconPending === hasPending) return;
  _lastFaviconPending = hasPending;
  const link = document.getElementById('favicon');
  if (!link) return;
  const color = hasPending ? '%23e6a700' : '%231976d2';
  link.href = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${color}"/><text x="16" y="22" font-family="-apple-system,system-ui,sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="white">S</text></svg>`;
}

// Same guard for document.title so we don't churn the title bar every 30s.
let _lastTitlePendingCount = null;

/**
 * Update the approval count badge in the sidebar — and the browser tab
 * title, so a user with the tab in the background sees there's something
 * waiting on them without having to switch.
 */
/**
 * Kill-switch / auto-execution-paused banner (#379).
 *
 * Polls `/api/users/:userId/autonomy-state` and renders a sticky
 * red banner across every page when EITHER the operator
 * `SKYTWIN_AUTO_EXECUTE_DISABLED` env var OR the per-user
 * `autonomy_settings.paused` flag is set. Two independent lines so
 * both pause sources can show simultaneously; the Resume button only
 * appears for the per-user line (the operator pause can only be
 * cleared by unsetting the env var on the API process).
 *
 * Best-effort: if the endpoint 401s / 404s / errors, the banner stays
 * hidden — failing closed here would force a banner on every
 * unauthenticated page, which is itself confusing UX. The endpoint is
 * cheap enough to poll on every navigate() + every 30s.
 */
async function updateAutonomyBanner() {
  const banner = document.getElementById('autonomy-banner');
  const opLine = document.getElementById('autonomy-banner-operator');
  const userLine = document.getElementById('autonomy-banner-user');
  const resumeBtn = document.getElementById('autonomy-banner-resume');
  if (!banner || !opLine || !userLine || !resumeBtn) return;

  if (!currentUserId) {
    banner.hidden = true;
    document.body.classList.remove('has-autonomy-banner');
    return;
  }

  let state;
  try {
    state = await fetchJSON(`/api/users/${encodeURIComponent(currentUserId)}/autonomy-state`);
  } catch {
    // Don't surface a banner on a failed fetch — that would create a
    // false "we're paused" signal for unauthenticated visits and
    // confuse users who land mid-session-expiry.
    banner.hidden = true;
    document.body.classList.remove('has-autonomy-banner');
    return;
  }

  const showOp = Boolean(state?.globalPause);
  const showUser = Boolean(state?.userPause);
  const anyActive = showOp || showUser;

  opLine.hidden = !showOp;
  opLine.textContent = showOp
    ? 'Auto-execution paused by operator. Actions require manual approval until the operator restores normal mode.'
    : '';

  userLine.hidden = !showUser;
  userLine.textContent = showUser
    ? 'Auto-execution paused. Your twin will not act on signals until you resume.'
    : '';

  // Resume only clears the per-user lever — the operator env var
  // requires a process restart and can't be flipped from the web UI.
  resumeBtn.hidden = !showUser;

  banner.hidden = !anyActive;
  document.body.classList.toggle('has-autonomy-banner', anyActive);
}

// Singleton click delegator for the banner Resume button. Gated on
// data-action so it can't fire on unrelated clicks, and confirms
// before flipping the state so a misclick doesn't silently re-arm
// auto-execution.
document.addEventListener('click', async (e) => {
  const target = e.target instanceof Element ? e.target.closest('[data-action="autonomy-resume"]') : null;
  if (!target) return;
  e.preventDefault();
  if (!currentUserId) return;
  const confirmed = window.confirm(
    'Your twin will start acting on signals again. Continue?',
  );
  if (!confirmed) return;
  try {
    await fetchJSON(`/api/users/${encodeURIComponent(currentUserId)}/autonomy-pause`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    });
    showToast('Auto-execution resumed. Your twin is acting on signals again.', { kind: 'success' });
  } catch (err) {
    showToast(
      `Couldn't resume: ${err instanceof Error ? err.message : 'unknown error'}`,
      { kind: 'error' },
    );
  } finally {
    updateAutonomyBanner();
  }
});

/**
 * Connector re-auth banner (#377). Surfaces a "Reconnect" banner when
 * any connector's health row says `needs_reauth` — typically because
 * the user revoked SkyTwin's access at the provider (Google Account →
 * Security → Third-party apps → Remove SkyTwin) or the refresh token
 * aged out. Pre-fix the dashboard rendered as if everything was fine
 * even when the worker had stopped processing signals for days. This
 * banner is the user-facing signal the worker's circuit-breaker
 * already had internally.
 *
 * Polls `/api/connectors/:userId/status` on every `navigate()` + every
 * 60s. Single CTA — clicking jumps to the connect-gmail wizard (the
 * only connector this PR wires up); future connectors can branch the
 * CTA based on which row is needs_reauth. Banner can't be dismissed:
 * the worker has stopped doing work for this user and they need to
 * fix it.
 */
async function updateConnectorsBanner() {
  const banner = document.getElementById('connectors-banner');
  const textEl = document.getElementById('connectors-banner-text');
  if (!banner || !textEl) return;

  if (!currentUserId) {
    banner.hidden = true;
    document.body.classList.remove('has-connectors-banner');
    return;
  }

  let state;
  try {
    state = await fetchJSON(`/api/connectors/${encodeURIComponent(currentUserId)}/status`);
  } catch {
    // Same posture as the autonomy banner — a failed fetch is not a
    // signal to scare the user. Stay silent.
    banner.hidden = true;
    document.body.classList.remove('has-connectors-banner');
    return;
  }

  if (!state?.anyNeedsReauth) {
    banner.hidden = true;
    document.body.classList.remove('has-connectors-banner');
    return;
  }

  // First needs_reauth connector wins the CTA. Multi-connector failure
  // would surface as one banner at a time; reconnecting one and
  // refreshing reveals the next.
  const broken = Object.entries(state.connectors ?? {})
    .find(([, c]) => c?.status === 'needs_reauth');
  const name = broken?.[0] ?? 'a connector';
  const code = broken?.[1]?.errorCode;
  const codeNote = code === 'invalid_grant'
    ? ' (access was revoked or expired)'
    : code
      ? ` (${code})`
      : '';
  textEl.textContent =
    `${name.charAt(0).toUpperCase()}${name.slice(1)} disconnected${codeNote}. Your twin has stopped processing ${name} signals. Reconnect to resume.`;
  banner.hidden = false;
  document.body.classList.add('has-connectors-banner');
}

// Singleton click handler for the Reconnect button. Hard-wired to the
// connect-gmail wizard (only connector this PR covers). Future
// connectors should read the broken connector name off the banner
// dataset and branch to the appropriate route.
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target.closest('[data-action="connectors-reconnect"]') : null;
  if (!target) return;
  e.preventDefault();
  window.location.hash = '#/connect-gmail';
});

async function updateApprovalBadge() {
  if (!currentUserId) return;
  try {
    const data = await fetchPendingApprovals(currentUserId);
    const count = data.approvals?.length ?? 0;
    const badge = document.getElementById('approval-count');
    if (badge) {
      badge.textContent = String(count);
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    const mobileBadge = document.getElementById('mobile-approval-count');
    if (mobileBadge) {
      mobileBadge.textContent = String(count);
      mobileBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    // Tab title + favicon both act like the second sidebar — when the
    // user has SkyTwin open in a background tab and an approval lands,
    // the count prefix and the warning-yellow favicon both catch the
    // eye even without focus. Guarded so we don't repaint on every 30s
    // poll when the count hasn't moved.
    if (count !== _lastTitlePendingCount) {
      _lastTitlePendingCount = count;
      document.title = count > 0
        ? `(${count}) ${DEFAULT_DOC_TITLE.replace(/^\(\d+\)\s*/, '')}`
        : DEFAULT_DOC_TITLE.replace(/^\(\d+\)\s*/, '');
    }
    setFaviconForPending(count > 0);
  } catch {
    // Silently fail — badge just won't update
  }
}

// Transient "what the twin is doing right now" message. When set, it
// overrides the steady-state "Listening" text for a few seconds so the
// sidebar feels like the twin is alive rather than a passive connection
// indicator.
let _twinActivityText = null;
let _twinActivityTimer = null;
// Edge-trigger state for the back-online toast. Starts null (not "false")
// so the very first updateConnectionStatus() call after page load can't
// claim a transition from offline → online.
let _wasOffline = null;
function flashTwinActivity(text, durationMs = 4500) {
  _twinActivityText = text;
  if (_twinActivityTimer) clearTimeout(_twinActivityTimer);
  _twinActivityTimer = setTimeout(() => {
    _twinActivityText = null;
    _twinActivityTimer = null;
    updateConnectionStatus();
  }, durationMs);
  updateConnectionStatus();
}

/**
 * Update the connection status indicator.
 *
 * When the twin is actively working (recent SSE event), shows what it's
 * doing. Otherwise shows steady-state presence — "Listening" when SSE is
 * connected, "Connected" when only HTTP works, "Offline" when neither.
 */
async function updateConnectionStatus() {
  const statusEl = document.getElementById('connection-status');
  // UX review #12 (P1): a header banner mirrors the footer indicator
  // for the disconnected case. Most users never look at the bottom-left
  // corner; the banner sits below the page header so it's impossible
  // to miss when the API is offline.
  const banner = document.getElementById('connection-banner');
  const bannerText = banner?.querySelector('.connection-banner-text');

  // Build the footer indicator from a static dot + a textContent span
  // so any future caller of flashTwinActivity() that passes
  // user-derived text can't smuggle markup. _twinActivityText is
  // internal-only today; keeping the boundary safe is defense in depth
  // for tomorrow.
  const renderState = (dotClass, text) => {
    if (statusEl) {
      statusEl.innerHTML = `<span class="status-dot ${dotClass}"></span><span class="status-text"></span>`;
      const t = statusEl.querySelector('.status-text');
      if (t) t.textContent = text;
    }
    // Banner only shows when disconnected. Hidden otherwise so it
    // doesn't take vertical space on the happy path (most of the time).
    if (banner) {
      const isOffline = dotClass === 'disconnected';
      banner.hidden = !isOffline;
      if (isOffline && bannerText) bannerText.textContent = text;
    }
    // The idle state means "no user is signed in" — it's neither offline
    // NOR a recovery from offline. Don't touch _wasOffline so the
    // sign-in → connected transition can't accidentally fire the
    // "Back online" toast.
    if (dotClass === 'idle') return;
    // Edge-trigger a toast when we transition from offline → online so
    // the user gets explicit confirmation that their next action will
    // work. Skip the very first connect (no prior state to recover
    // from). _wasOffline is module-scoped above.
    const isOfflineNow = dotClass === 'disconnected';
    if (_wasOffline && !isOfflineNow) {
      showToast('Back online — SkyTwin is listening again.', { kind: 'success' });
    }
    _wasOffline = isOfflineNow;
  };

  // No userId means "waiting for sign-in", not "offline" (#365).
  // Render an idle grey dot and suppress the Reconnecting banner.
  if (!currentUserId) {
    renderState('idle', 'Sign in to start');
    return;
  }

  if (_twinActivityText) {
    renderState('connected', _twinActivityText);
    return;
  }

  if (isConnected()) {
    renderState('connected', 'Listening');
    return;
  }

  try {
    await fetchHealth();
    renderState('connected', 'Connected');
  } catch {
    renderState('disconnected', 'Reconnecting…');
  }
}

// "Retry now" button on the connection banner (UX review #12). Wired
// once; subsequent updateConnectionStatus() calls reuse the same DOM.
// Triggers an immediate health check + re-renders the status. Skips
// the next backoff window the SSE client would otherwise wait through.
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.getAttribute('data-action') !== 'connection-retry') return;
  e.preventDefault();
  updateConnectionStatus();
});

// Sign-in re-open from the no-user placeholder. Clears the 'skipped'
// marker so the modal is allowed to mount again, then explicitly shows
// it. Without this, an Esc/X/Skip dismiss on the first visit would
// permanently lock the user out of the only sign-in surface (no path
// back, since the modal is gated on KEY_ONBOARDED being null).
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target.closest('[data-action="signin-reopen"]') : null;
  if (!target) return;
  e.preventDefault();
  localStorage.removeItem(KEY_ONBOARDED);
  showOnboarding();
});

// Drive the activity flash off the events the API already broadcasts.
window.addEventListener('sse:decision:step', () => flashTwinActivity('Working on it…'));
window.addEventListener('sse:decision:executed', () => flashTwinActivity('Just handled something'));
window.addEventListener('sse:approval:new', () => flashTwinActivity('Wants your OK'));
window.addEventListener('sse:twin:updated', () => flashTwinActivity('Learned something new'));

/**
 * Navigate to the current hash route.
 *
 * Chrome (page heading, sidebar highlights, connection status) is
 * always updated first so the URL → heading binding holds even when
 * the user hasn't signed in (#362, #364). The page-content render is
 * gated on `currentUserId`: with no user, the modal shows over a
 * placeholder; the navigation around the modal still works.
 */
function navigate() {
  // Strip query suffix (e.g. "/?connected=google") so post-OAuth lands on
  // the dashboard route while preserving the params for that page to read.
  const hashRaw = window.location.hash.slice(1) || '/';
  const hash = hashRaw.split('?')[0] || '/';

  // Dynamic route: /capabilities/:id — check before static lookup
  const capabilityDetailMatch = hash.match(/^\/capabilities\/([^/]+)$/);
  // Dynamic route: /lifebook/<domain> (#193 Child 1)
  const lifebookMatch = hash.match(/^\/lifebook\/([^/?]+)$/);

  // Resolve route — dynamic segments before static table
  let route = routes[hash];
  let dynamicParam = null;
  if (!route && capabilityDetailMatch) {
    dynamicParam = capabilityDetailMatch[1];
    route = { title: 'Capability', render: (c, uid) => renderCapabilityDetail(c, uid, dynamicParam) };
  }
  if (!route && lifebookMatch) {
    let title = 'Lifebook';
    try { title = `Lifebook · ${decodeURIComponent(lifebookMatch[1])}`; } catch { /* keep default */ }
    route = { title, render: renderLifebook };
  }
  route = route || routes['/'];

  // Chrome updates — run unconditionally so the URL → heading binding
  // holds for unauthenticated visits too.
  document.getElementById('page-title').textContent = route.title;
  if (currentUserId) {
    // Show friendly name instead of UUID, and make the badge a switcher.
    renderUserBadge();
  }

  // Update active nav link (sidebar + bottom nav)
  document.querySelectorAll('.nav-link, .bottom-nav-link').forEach(link => {
    const page = link.getAttribute('data-page');
    const isActive = (hash === '/' && page === 'dashboard') ||
                     hash === `/${page}` ||
                     // Mark Capabilities nav link active for both list and detail routes
                     (page === 'capabilities' && (hash === '/capabilities' || hash.startsWith('/capabilities/')));
    link.classList.toggle('active', isActive);
  });

  const container = document.getElementById('page-content');

  if (!currentUserId) {
    // No user yet — surface the modal (only if the user hasn't already
    // dismissed it this session) and show a clickable placeholder behind
    // it so a dismissed user has a way back into the sign-in flow.
    // Without this re-open path, pressing Esc/X/Skip on the first visit
    // would permanently lock the user out of the only sign-in surface.
    container.innerHTML = `
      <div class="signin-placeholder">
        <p style="margin:0 0 1rem 0;">Sign in to see your decisions.</p>
        <button class="btn btn-primary" data-action="signin-reopen" type="button">
          Sign in
        </button>
      </div>
    `;
    updateConnectionStatus();
    if (needsOnboarding()) {
      showOnboarding();
    }
    return;
  }

  container.innerHTML = '<div class="loading">Loading...</div>';

  route.render(container, currentUserId).catch(err => {
    container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  });

  // Update sidebar state
  updateApprovalBadge();
  updateConnectionStatus();
  // Refresh the kill-switch banner on every route change so a flip
  // made on the Settings page reflects across the whole app within a
  // single navigation rather than waiting for the 30s poll.
  updateAutonomyBanner();
  // Same for the connector re-auth banner (#377) — refresh on
  // navigate so a successful re-auth click that lands on the
  // dashboard makes the banner disappear without waiting on the poll.
  updateConnectorsBanner();

  // Theme switcher used to live in the page header (UX review #7) where
  // it looked like a breadcrumb. Now mounted by the Settings page in a
  // labeled card. No-op call here.
}

export function setUserId(id) {
  currentUserId = id;
  localStorage.setItem(KEY_USER_ID, id);
  // Preserve 'sample' marker so tour-mode users stay distinguishable
  // for the P2 chrome banner work. Same invariant as hideWizard in
  // onboarding.js — only promote the never-onboarded null state here.
  const existing = localStorage.getItem(KEY_ONBOARDED);
  if (existing !== 'sample') {
    localStorage.setItem(KEY_ONBOARDED, 'true');
  }
  try { disconnectSSE(); } catch { /* noop */ }
  connectSSE(id);
  navigate();
}

// Mobile menu toggle
function closeMobileMenu() {
  document.getElementById('nav-links')?.classList.remove('open');
  document.getElementById('mobile-backdrop')?.classList.remove('visible');
}

document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
  const nav = document.getElementById('nav-links');
  const backdrop = document.getElementById('mobile-backdrop');
  const isOpen = nav?.classList.toggle('open');
  backdrop?.classList.toggle('visible', isOpen);
});

document.getElementById('mobile-backdrop')?.addEventListener('click', closeMobileMenu);

// Close mobile menu on navigation
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', closeMobileMenu);
});

window.addEventListener('hashchange', navigate);

/**
 * Body-wide drag-drop entry point for .dxt artifacts.
 *
 * Drops anywhere on the page route through the existing /api/dxt/import
 * preview flow, then navigate to the imports page so the user lands on
 * the confirm/reject UI shipped in #224. Skips any drop that doesn't
 * carry exactly one .dxt or .json file so we never interfere with text /
 * image / link drags.
 *
 * Also subscribes to the desktop `onDxtFileOpened` event so double-clicking
 * a .dxt file in Finder/Explorer (with file association registered) lands
 * in the same flow.
 */
function wireDxtDropAndOpen() {
  if (window._dxtDropWired) return;
  window._dxtDropWired = true;

  const isDxtFile = (f) => {
    const name = (f?.name ?? '').toLowerCase();
    return name.endsWith('.dxt') || name.endsWith('.json');
  };

  const importBlob = async (base64) => {
    const userId = localStorage.getItem(KEY_USER_ID) ?? '';
    if (!userId) {
      showToast('Sign in first, then drop the file again', 'error');
      return;
    }
    try {
      const res = await fetch(`/api/dxt/import?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blob: base64 }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      showToast(`Capability ready to review: ${data.preview?.capability?.name ?? 'unknown'}`);
      window.location.hash = '#/dxt/imports';
    } catch (err) {
      showToast(`DXT import failed: ${err?.message ?? 'unknown error'}`, 'error');
    }
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });

  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types ?? []);
    if (!types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    const dxtFiles = files.filter(isDxtFile);
    if (dxtFiles.length === 0) return;
    e.preventDefault();
    if (dxtFiles.length > 1) {
      showToast('Drop one .dxt file at a time', 'error');
      return;
    }
    try {
      const base64 = await fileToBase64(dxtFiles[0]);
      await importBlob(base64);
    } catch (err) {
      showToast(`Couldn't read file: ${err?.message ?? 'unknown error'}`, 'error');
    }
  });

  // Desktop file-association entry point. The main process forwards
  // OS open-file events here; we read the file via IPC and route it
  // through the same import flow.
  if (window.skytwinDesktop?.onDxtFileOpened && window.skytwinDesktop.readDxtFile) {
    window.skytwinDesktop.onDxtFileOpened(async ({ path }) => {
      try {
        const { base64 } = await window.skytwinDesktop.readDxtFile(path);
        await importBlob(base64);
      } catch (err) {
        showToast(`Couldn't open ${path}: ${err?.message ?? 'unknown error'}`, 'error');
      }
    });
  }

  // First window-close in this session fires a toast explaining that
  // the app keeps running in the tray (#381). Main process sends the
  // event exactly once per launch; subsequent closes are silent.
  // Wording branches on platform — "menu bar" reads as macOS jargon
  // on Windows/Linux where the affordance is the system tray.
  if (window.skytwinDesktop?.onFirstCloseToast) {
    const platform = window.skytwinDesktop.platform;
    const trayName = platform === 'darwin' ? 'menu bar icon' : 'system tray icon';
    window.skytwinDesktop.onFirstCloseToast(() => {
      showToast(
        `SkyTwin keeps running in the background so it can act on signals. ` +
        `Quit fully from the ${trayName}.`,
        { kind: 'info', durationMs: 8000 },
      );
    });
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  // Apply saved a11y preferences (text scale, reduced motion, voice-first)
  // before any render so users with prefs don't see a flash of base UI.
  initA11y();

  // Inject the WCAG skip-link as the first focusable element. Hidden
  // until focused (CSS pulls it in from -100px). Lets keyboard / screen
  // reader users jump past the nav into main content.
  if (!document.getElementById('skytwin-skip-link')) {
    const skip = document.createElement('a');
    skip.id = 'skytwin-skip-link';
    skip.className = 'skip-link';
    skip.href = '#page-content';
    skip.textContent = 'Skip to main content';
    document.body.insertBefore(skip, document.body.firstChild);
  }

  // Wire dashboard event handlers + document-level delegators.
  // Idempotent so re-running this in tests is safe.
  initDashboardGlobals();
  wireDxtDropAndOpen();

  // Mount the always-visible Pause-everything safety button (#190).
  // Floats top-right across all routes so the panic affordance is always
  // accessible. Component handles its own state + SSE subscription.
  if (!document.getElementById('global-pause-button-mount')) {
    const mount = document.createElement('div');
    mount.id = 'global-pause-button-mount';
    mount.className = 'global-pause-mount';
    document.body.appendChild(mount);
    renderGlobalPauseButton(mount);
  }

  // Handle mobile QR pairing entry. Two URL shapes:
  //   /mobile?pairToken=...&userId=...  ← new flow (#385). The pairToken
  //     is a SHORT-LIVED (5min) single-use credential we exchange for
  //     a real session via POST /api/sessions/pair/consume.
  //   /mobile?token=...&userId=...      ← legacy flow (pre-#385). The
  //     token IS the session. Kept for any in-flight QRs minted by an
  //     older API version during a rolling deploy; safe to remove after
  //     a deploy cycle has passed.
  const urlParams = new URLSearchParams(window.location.search);
  const pairToken = urlParams.get('pairToken');
  const mobileToken = urlParams.get('token');
  const mobileUserId = urlParams.get('userId');

  if (pairToken) {
    try {
      const res = await fetch('/api/sessions/pair/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairToken }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        // Strip the param either way — leaving a failed pairToken in
        // the URL would make a reload re-attempt and fail with
        // already-used or expired on the second try, masking the
        // original error.
        window.history.replaceState({}, '', '/');
        if (typeof showToast === 'function') {
          showToast(detail.message || 'Pairing code is no longer valid. Please generate a new one.', { kind: 'error' });
        }
        bootWithVerifiedUser();
        return;
      }
      const payload = await res.json();
      localStorage.setItem(KEY_SESSION_TOKEN, payload.token);
      localStorage.setItem(KEY_USER_ID, payload.userId);
      localStorage.setItem(KEY_ONBOARDED, 'true');
      currentUserId = payload.userId;
      window.history.replaceState({}, '', '/');
      navigate();
    } catch (err) {
      window.history.replaceState({}, '', '/');
      if (typeof showToast === 'function') {
        showToast(`Couldn't redeem pairing code: ${err?.message || 'unknown error'}`, { kind: 'error' });
      }
      bootWithVerifiedUser();
    }
    return;
  }

  if (mobileToken && mobileUserId) {
    localStorage.setItem(KEY_SESSION_TOKEN, mobileToken);
    localStorage.setItem(KEY_USER_ID, mobileUserId);
    localStorage.setItem(KEY_ONBOARDED, 'true');
    currentUserId = mobileUserId;
    // Clean up URL
    window.history.replaceState({}, '', '/');
    navigate();
    return;
  }

  // Plain ?userId=<id> override — switch to that user, persist, and strip
  // the param so reloads stay sticky. Useful when a Google OAuth callback or
  // the user-switcher dropdown lands here.
  if (mobileUserId) {
    localStorage.setItem(KEY_USER_ID, mobileUserId);
    localStorage.setItem(KEY_ONBOARDED, 'true');
    currentUserId = mobileUserId;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    // Route through verification — a forged or stale `?userId=` link must
    // not boot directly as that id. Legit callers (the OAuth callback
    // redirect, the user-switcher) pass a real id, which verifies cleanly
    // and proceeds to connectSSE + navigate inside bootWithVerifiedUser.
    bootWithVerifiedUser();
    return;
  }

  bootWithVerifiedUser();
});

/**
 * Boot path for the common case (no mobile-pairing / ?userId= override).
 *
 * A `skytwin_userId` in localStorage can outlive the user row it points
 * at — the dev database gets reseeded between sessions, or the user is
 * deleted. Booting straight into that phantom id silently breaks
 * everything keyed on userId: the dashboard still renders, but OAuth
 * connect, approvals, and the rest operate on a user the server has
 * never heard of (and the OAuth callback then quietly reassigns the
 * connection to whoever owns the email). So verify the stored id
 * against the server before committing to it.
 */
async function bootWithVerifiedUser() {
  if (!currentUserId) {
    // navigate() handles both the modal-mount-on-first-visit and the
    // "skipped"/'sample' state where the chrome should render without
    // re-mounting the modal.
    navigate();
    return;
  }
  // Verify against the server with `fetchJSON` directly, NOT `fetchUser`
  // — `fetchUser` swallows every failure into `null`, which can't tell a
  // real "this id is invalid" from a transient blip. `fetchJSON` throws
  // a typed `ApiError`; two kinds mean the stored id is not valid for
  // this client and we must NOT boot as it:
  //   - `not-found` (404): the user row is gone — a phantom id (e.g. the
  //     dev DB was reseeded between sessions).
  //   - `auth` (401/403): the id isn't the one this client's session
  //     authenticates as — a stale token, or a forged `?userId=` link.
  //     `requireOwnership` on /api/users/:id 403s in that case.
  // Anything else (`offline`, `server`) is transient — boot normally and
  // let the app's offline handling cope; don't punish a blip.
  try {
    await fetchJSON(`/api/users/${encodeURIComponent(currentUserId)}`);
  } catch (err) {
    if (err && (err.kind === 'not-found' || err.kind === 'auth')) {
      // Stored id is invalid — clear the whole SkyTwin localStorage slate
      // (id, onboarded flag, session token, tour mode, per-user state)
      // and re-onboard rather than run as a ghost or keep a stale token
      // that would 403 the next user.
      clearAllSkyTwinKeys();
      currentUserId = '';
      showOnboarding();
      return;
    }
    // Transient network / server error — don't force re-onboarding over
    // a blip. Boot normally; the app's offline handling covers it.
  }
  connectSSE(currentUserId);
  navigate();
}

// Make setUserId available globally for settings page
window.skyTwinSetUserId = setUserId;

// Expose the autonomy-banner refresher so Settings can re-fetch
// /autonomy-state immediately after a toggle flip (#379). Without
// this the banner would lag one navigation behind.
window.updateAutonomyBanner = updateAutonomyBanner;

// Approval-badge fallback poll. SSE pushes sse:approval:new + :resolved
// in real time, so we only need this when the live channel is down. Five
// minutes when SSE is healthy is a cheap reconciliation backstop; ten
// seconds when it's not is the "we still see this" rhythm.
setInterval(() => {
  if (!currentUserId) return;
  // UX review #20 — when the API is known down, back off the badge
  // poll from 10s → 60s. Pre-fix this loop produced 6 console errors
  // per minute against a dead server, on top of the SSE reconnect
  // attempts. The connection banner already tells the user the API
  // is offline; aggressive polling adds noise without information.
  if (isApiKnownOffline()) {
    if ((Date.now() - (window._skytwinLastBadgePoll || 0)) < 60 * 1000) return;
  } else if (isConnected()) {
    if ((Date.now() - (window._skytwinLastBadgePoll || 0)) < 5 * 60 * 1000) return;
  }
  window._skytwinLastBadgePoll = Date.now();
  updateApprovalBadge();
}, 10000);

// Kill-switch banner background refresh (#379). The operator env var
// can be flipped at any time on the API process (process restart);
// without a poll the user would only see the banner update on the
// next navigate(). 30s strikes a balance between freshness and
// /autonomy-state load. Backed off when the API is known offline.
setInterval(() => {
  if (!currentUserId) return;
  if (isApiKnownOffline()) return;
  updateAutonomyBanner();
}, 30_000);

// Connector re-auth banner background refresh (#377). The worker
// polls every minute and updates connector_health on every outcome,
// so a 60s dashboard poll matches the slowest-case detection time
// for a freshly-revoked token. Backed off when the API is known
// offline.
setInterval(() => {
  if (!currentUserId) return;
  if (isApiKnownOffline()) return;
  updateConnectorsBanner();
}, 60_000);

// ── SSE-driven live updates ─────────────────────────────

// Refresh approval badge immediately when SSE reports a new or resolved approval
window.addEventListener('sse:approval:new', () => updateApprovalBadge());
window.addEventListener('sse:approval:resolved', () => updateApprovalBadge());

// Update connection status dot when SSE connects/disconnects
window.addEventListener('sse:connected', () => updateConnectionStatus());
window.addEventListener('sse:disconnected', () => updateConnectionStatus());

// Re-render current page when twin is updated (e.g. after feedback).
// Drop the cached learned/skill-gaps too so the next render reflects
// the new state instead of the 30s-old snapshot.
window.addEventListener('sse:twin:updated', () => {
  invalidateDashboardCache('learned-');
  invalidateDashboardCache('skill-gaps-');
  const hash = window.location.hash.slice(1) || '/';
  if (hash === '/' || hash === '/twin') {
    const route = routes[hash] || routes['/'];
    const container = document.getElementById('page-content');
    route.render(container, currentUserId).catch(() => {});
  }
});

// Re-render dashboard or setup page when new credentials are needed.
// Bust the creds cache so the dashboard hero card flips state immediately.
window.addEventListener('sse:credential:needed', () => {
  invalidateDashboardCache('creds-status');
  invalidateDashboardCache('unmet-creds');
  const hash = window.location.hash.slice(1) || '/';
  if (hash === '/' || hash === '/setup') {
    const route = routes[hash] || routes['/'];
    const container = document.getElementById('page-content');
    route.render(container, currentUserId).catch(() => {});
  }
});

// Make the dashboard feel alive: when a decision lands or a step runs,
// re-render so the activity log + stats update without the user touching
// reload. We debounce rapid bursts so we don't thrash the dashboard
// during a busy first-scan window.
let _liveRefreshTimer = null;
function scheduleLiveRefresh(routesToWatch) {
  const hashRaw = window.location.hash.slice(1) || '/';
  const hash = hashRaw.split('?')[0] || '/';
  if (!routesToWatch.includes(hash)) return;
  if (_liveRefreshTimer) return;
  _liveRefreshTimer = setTimeout(() => {
    _liveRefreshTimer = null;
    const currentHashRaw = window.location.hash.slice(1) || '/';
    const currentHash = currentHashRaw.split('?')[0] || '/';
    if (!routesToWatch.includes(currentHash)) return;
    const route = routes[currentHash] || routes['/'];
    const container = document.getElementById('page-content');
    route.render(container, currentUserId).catch(() => { /* next event will retry */ });
  }, 600);
}

window.addEventListener('sse:decision:executed', () => scheduleLiveRefresh(['/', '/decisions']));
window.addEventListener('sse:decision:step', () => scheduleLiveRefresh(['/']));

// Browser notifications: when an approval lands while the user is in a
// different tab or app, fire an OS-level notification. Click → focus the
// dashboard tab and route to Approvals. Permission is asked the first
// time the user already has a pending approval (i.e. they've seen one
// approval card so they understand what they're being asked about) —
// never on bare page load.
function _twinNotificationsAllowed() {
  if (!('Notification' in window)) return false;
  return Notification.permission === 'granted';
}

// Expose helpers so the dashboard can render a friendly "want pings?" card
// in the right context, and trigger the OS prompt only when the user has
// affirmatively asked for it.
window.skyTwinNotificationsState = function() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
};

window.skyTwinRequestNotifications = function() {
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  return Notification.requestPermission();
};

// Sanitize SSE-derived strings before they reach OS-level notifications:
// strip control chars (newlines etc that could be used to forge a fake
// header/footer), cap length so a misbehaving upstream can't push a wall
// of text into the notification center, and fall back to a generic body.
function _safeNotificationBody(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > 140 ? trimmed.slice(0, 137) + '…' : trimmed;
}

window.addEventListener('sse:approval:new', (e) => {
  if (!_twinNotificationsAllowed()) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const detail = e.detail || {};
  const body = _safeNotificationBody(detail.reason)
    || _safeNotificationBody(detail.description)
    || 'A decision is waiting on the dashboard.';
  try {
    const n = new Notification('Your twin wants your OK', {
      body,
      tag: 'skytwin-approval',
    });
    n.onclick = () => {
      window.focus();
      window.location.hash = '#/approvals';
      n.close();
    };
  } catch { /* notification creation can throw on some browsers */ }
});
