import { renderDashboard } from './pages/dashboard.js';
import { renderApprovals } from './pages/approvals.js';
import { renderDecisions } from './pages/decisions.js';
import { renderTwin } from './pages/twin.js';
import { renderSettings } from './pages/settings.js';
import { renderOnboarding } from './pages/onboarding.js';
import { fetchPendingApprovals, fetchHealth, fetchUser, escapeHtml } from './api-client.js';
import { mountThemeSwitcher, initTheme } from './theme-switcher.js';
import { connectSSE, disconnectSSE, isConnected } from './sse-client.js';

let currentUserId = localStorage.getItem('skytwin_userId') || '';

const routes = {
  '/': { title: 'Home', render: renderDashboard },
  '/approvals': { title: 'Needs your OK', render: renderApprovals },
  '/decisions': { title: 'What happened', render: renderDecisions },
  '/twin': { title: 'What I\'ve learned', render: renderTwin },
  '/settings': { title: 'Settings', render: renderSettings },
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
 * Update the approval count badge in the sidebar.
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
  } catch {
    // Silently fail — badge just won't update
  }
}

/**
 * Update the connection status indicator.
 */
async function updateConnectionStatus() {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;

  if (isConnected()) {
    statusEl.innerHTML = '<span class="status-dot connected"></span><span class="status-text">Live</span>';
    return;
  }

  try {
    await fetchHealth();
    statusEl.innerHTML = '<span class="status-dot connected"></span><span class="status-text">Connected</span>';
  } catch {
    statusEl.innerHTML = '<span class="status-dot disconnected"></span><span class="status-text">Offline</span>';
  }
}

/**
 * Navigate to the current hash route.
 */
function navigate() {
  if (!currentUserId) {
    showOnboarding();
    return;
  }

  const hash = window.location.hash.slice(1) || '/';
  const route = routes[hash] || routes['/'];

  document.getElementById('page-title').textContent = route.title;
  // Show friendly name instead of UUID
  const badge = document.getElementById('user-badge');
  fetchUser(currentUserId).then(data => {
    const u = data?.user ?? data;
    badge.textContent = u?.name || u?.email || currentUserId;
  }).catch(() => {
    badge.textContent = currentUserId;
  });

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach(link => {
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
