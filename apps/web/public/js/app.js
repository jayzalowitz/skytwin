import { renderDashboard } from './pages/dashboard.js';
import { renderApprovals } from './pages/approvals.js';
import { renderDecisions } from './pages/decisions.js';
import { renderTwin } from './pages/twin.js';
import { renderSettings } from './pages/settings.js';
import { renderOnboarding } from './pages/onboarding.js';
import { fetchPendingApprovals, fetchHealth, fetchUser, escapeHtml } from './api-client.js';
import { mountThemeSwitcher, initTheme } from './theme-switcher.js';

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
    const mobileBadge = document.getElementById('mobile-approval-count');
    if (mobileBadge) {
      mobileBadge.textContent = String(count);
      mobileBadge.style.display = count > 0 ? 'inline-block' : 'none';
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

  if (needsOnboarding() || !currentUserId) {
    showOnboarding();
  } else {
    navigate();
  }
});

// Make setUserId available globally for settings page
window.skyTwinSetUserId = setUserId;

// Poll for approval badge updates every 30s
setInterval(updateApprovalBadge, 30000);
