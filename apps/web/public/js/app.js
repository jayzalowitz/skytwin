import { renderDashboard } from './pages/dashboard.js';
import { renderApprovals } from './pages/approvals.js';
import { renderDecisions } from './pages/decisions.js';
import { renderTwin } from './pages/twin.js';
import { renderSettings } from './pages/settings.js';
import { renderAudit } from './pages/audit.js';
import { renderSetup } from './pages/setup.js';
import { renderOnboarding } from './pages/onboarding.js';
import { fetchPendingApprovals, fetchHealth, fetchUser, listUsers, escapeHtml } from './api-client.js';
import { mountThemeSwitcher, initTheme } from './theme-switcher.js';
import { connectSSE, disconnectSSE, isConnected } from './sse-client.js';

let currentUserId = localStorage.getItem('skytwin_userId') || '';

const routes = {
  '/': { title: 'Home', render: renderDashboard },
  '/approvals': { title: 'Needs your OK', render: renderApprovals },
  '/decisions': { title: 'What happened', render: renderDecisions },
  '/twin': { title: 'What I\'ve learned', render: renderTwin },
  '/settings': { title: 'Settings', render: renderSettings },
  '/audit': { title: 'Audit Trail', render: renderAudit },
  '/setup': { title: 'Connect', render: renderSetup },
};

/**
 * Check if onboarding is needed.
 */
function needsOnboarding() {
  return !localStorage.getItem('skytwin_onboarded');
}

/**
 * Show the onboarding overlay.
 */
function showOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  overlay.style.display = 'flex';
  renderOnboarding(
    document.getElementById('onboarding-content'),
    (userId) => {
      currentUserId = userId;
      localStorage.setItem('skytwin_userId', userId);
      localStorage.setItem('skytwin_onboarded', 'true');
      overlay.style.display = 'none';
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
function renderUserBadge() {
  const badge = document.getElementById('user-badge');
  if (!badge) return;

  // Friendly current label.
  fetchUser(currentUserId).then((data) => {
    const u = data?.user ?? data;
    badge.textContent = u?.name || u?.email || currentUserId || 'No user';
  }).catch(() => {
    badge.textContent = currentUserId || 'No user';
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
// the eye even when the title is truncated.
function setFaviconForPending(hasPending) {
  const link = document.getElementById('favicon');
  if (!link) return;
  const color = hasPending ? '%23e6a700' : '%231976d2';
  link.href = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${color}"/><text x="16" y="22" font-family="-apple-system,system-ui,sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="white">S</text></svg>`;
}

/**
 * Update the approval count badge in the sidebar — and the browser tab
 * title, so a user with the tab in the background sees there's something
 * waiting on them without having to switch.
 */
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
    // eye even without focus.
    if (count > 0) {
      document.title = `(${count}) ${DEFAULT_DOC_TITLE.replace(/^\(\d+\)\s*/, '')}`;
      setFaviconForPending(true);
    } else {
      document.title = DEFAULT_DOC_TITLE.replace(/^\(\d+\)\s*/, '');
      setFaviconForPending(false);
    }
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
  if (!statusEl) return;

  if (_twinActivityText) {
    statusEl.innerHTML = `<span class="status-dot connected"></span><span class="status-text">${_twinActivityText}</span>`;
    return;
  }

  if (isConnected()) {
    statusEl.innerHTML = '<span class="status-dot connected"></span><span class="status-text">Listening</span>';
    return;
  }

  try {
    await fetchHealth();
    statusEl.innerHTML = '<span class="status-dot connected"></span><span class="status-text">Connected</span>';
  } catch {
    statusEl.innerHTML = '<span class="status-dot disconnected"></span><span class="status-text">Reconnecting…</span>';
  }
}

// Drive the activity flash off the events the API already broadcasts.
window.addEventListener('sse:decision:step', () => flashTwinActivity('Working on it…'));
window.addEventListener('sse:decision:executed', () => flashTwinActivity('Just handled something'));
window.addEventListener('sse:approval:new', () => flashTwinActivity('Wants your OK'));
window.addEventListener('sse:twin:updated', () => flashTwinActivity('Learned something new'));

/**
 * Navigate to the current hash route.
 */
function navigate() {
  if (!currentUserId) {
    showOnboarding();
    return;
  }

  // Strip query suffix (e.g. "/?connected=google") so post-OAuth lands on
  // the dashboard route while preserving the params for that page to read.
  const hashRaw = window.location.hash.slice(1) || '/';
  const hash = hashRaw.split('?')[0] || '/';
  const route = routes[hash] || routes['/'];

  document.getElementById('page-title').textContent = route.title;
  // Show friendly name instead of UUID, and make the badge a switcher.
  renderUserBadge();

  // Update active nav link (sidebar + bottom nav)
  document.querySelectorAll('.nav-link, .bottom-nav-link').forEach(link => {
    const page = link.getAttribute('data-page');
    const isActive = (hash === '/' && page === 'dashboard') ||
                     hash === `/${page}`;
    link.classList.toggle('active', isActive);
  });

  const container = document.getElementById('page-content');
  container.innerHTML = '<div class="loading">Loading...</div>';

  route.render(container, currentUserId).catch(err => {
    container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  });

  // Update sidebar state
  updateApprovalBadge();
  updateConnectionStatus();

  // Mount theme switcher in the page header
  mountThemeSwitcher();
}

export function setUserId(id) {
  currentUserId = id;
  localStorage.setItem('skytwin_userId', id);
  localStorage.setItem('skytwin_onboarded', 'true');
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
window.addEventListener('DOMContentLoaded', () => {
  // Handle mobile QR pairing entry (/mobile?token=...&userId=...)
  const urlParams = new URLSearchParams(window.location.search);
  const mobileToken = urlParams.get('token');
  const mobileUserId = urlParams.get('userId');
  if (mobileToken && mobileUserId) {
    localStorage.setItem('skytwin_session_token', mobileToken);
    localStorage.setItem('skytwin_userId', mobileUserId);
    localStorage.setItem('skytwin_onboarded', 'true');
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
    localStorage.setItem('skytwin_userId', mobileUserId);
    localStorage.setItem('skytwin_onboarded', 'true');
    currentUserId = mobileUserId;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    connectSSE(currentUserId);
    navigate();
    return;
  }

  if (needsOnboarding() || !currentUserId) {
    showOnboarding();
  } else {
    connectSSE(currentUserId);
    navigate();
  }
});

// Make setUserId available globally for settings page
window.skyTwinSetUserId = setUserId;

// Poll for approval badge updates every 30s (fallback if SSE not connected)
setInterval(updateApprovalBadge, 30000);

// ── SSE-driven live updates ─────────────────────────────

// Refresh approval badge immediately when SSE reports a new or resolved approval
window.addEventListener('sse:approval:new', () => updateApprovalBadge());
window.addEventListener('sse:approval:resolved', () => updateApprovalBadge());

// Update connection status dot when SSE connects/disconnects
window.addEventListener('sse:connected', () => updateConnectionStatus());
window.addEventListener('sse:disconnected', () => updateConnectionStatus());

// Re-render current page when twin is updated (e.g. after feedback)
window.addEventListener('sse:twin:updated', () => {
  const hash = window.location.hash.slice(1) || '/';
  if (hash === '/' || hash === '/twin') {
    const route = routes[hash] || routes['/'];
    const container = document.getElementById('page-content');
    route.render(container, currentUserId).catch(() => {});
  }
});

// Re-render dashboard or setup page when new credentials are needed
window.addEventListener('sse:credential:needed', () => {
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

window.addEventListener('sse:approval:new', (e) => {
  if (!_twinNotificationsAllowed()) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const detail = e.detail || {};
  try {
    const n = new Notification('Your twin wants your OK', {
      body: detail.reason || detail.description || 'A decision is waiting on the dashboard.',
      tag: 'skytwin-approval',
      icon: '/favicon.ico',
    });
    n.onclick = () => {
      window.focus();
      window.location.hash = '#/approvals';
      n.close();
    };
  } catch { /* notification creation can throw on some browsers */ }
});
