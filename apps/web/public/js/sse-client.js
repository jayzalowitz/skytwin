/**
 * SSE client with automatic reconnection and fallback polling.
 *
 * Connects to /api/events/stream/:userId and dispatches custom events
 * on window so any page can listen.
 */

let eventSource = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

/**
 * Connect to the SSE stream for the given user.
 */
export function connectSSE(userId) {
  if (!userId) return;
  disconnectSSE();

  try {
    eventSource = new EventSource(`/api/events/stream/${encodeURIComponent(userId)}`);
  } catch {
    // EventSource not supported — fall back to polling only
    return;
  }

  eventSource.addEventListener('connected', () => {
    reconnectDelay = 1000; // Reset backoff on successful connect
    window.dispatchEvent(new CustomEvent('sse:connected'));
  });

  eventSource.addEventListener('approval:new', (e) => {
    const data = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent('sse:approval:new', { detail: data }));
    showToast('New approval needed', data.reason || 'A decision needs your review', 'info');
  });

  eventSource.addEventListener('approval:resolved', (e) => {
    const data = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent('sse:approval:resolved', { detail: data }));
  });

  eventSource.addEventListener('decision:executed', (e) => {
    const data = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent('sse:decision:executed', { detail: data }));
    const verb = data.status === 'completed' ? 'completed' : 'attempted';
    showToast(`Action ${verb}`, data.description || data.actionType, data.status === 'completed' ? 'success' : 'warning');
  });

  eventSource.addEventListener('twin:updated', (e) => {
    const data = JSON.parse(e.data);
    window.dispatchEvent(new CustomEvent('sse:twin:updated', { detail: data }));
  });

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    window.dispatchEvent(new CustomEvent('sse:disconnected'));
    scheduleReconnect(userId);
  };
}

/**
 * Disconnect from the SSE stream.
 */
export function disconnectSSE() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(userId) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectSSE(userId);
  }, reconnectDelay);
}

/**
 * Check if the SSE connection is active.
 */
export function isConnected() {
  return eventSource !== null && eventSource.readyState === EventSource.OPEN;
}

// ── Toast Notifications ──────────────────────────────────

let toastContainer = null;

function getToastContainer() {
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  toastContainer.style.cssText =
    'position:fixed;top:1rem;right:1rem;z-index:10000;display:flex;flex-direction:column;gap:0.5rem;pointer-events:none;';
  document.body.appendChild(toastContainer);
  return toastContainer;
}

/**
 * Show a toast notification that auto-dismisses after 5 seconds.
 */
export function showToast(title, message, type = 'info') {
  const container = getToastContainer();

  const colors = {
    success: { bg: 'var(--success-soft, #d4edda)', border: 'var(--success, #28a745)', icon: '\u2713' },
    warning: { bg: 'var(--warning-soft, #fff3cd)', border: 'var(--warning, #ffc107)', icon: '!' },
    error:   { bg: 'var(--danger-soft, #f8d7da)',  border: 'var(--danger, #dc3545)',  icon: '\u2717' },
    info:    { bg: 'var(--info-soft, #d1ecf1)',    border: 'var(--info, #17a2b8)',    icon: '\u2139' },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.style.cssText =
    `background:${c.bg};border:1px solid ${c.border};border-radius:8px;padding:0.75rem 1rem;` +
    'min-width:280px;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:auto;' +
    'opacity:0;transform:translateX(100%);transition:all 0.3s ease;cursor:pointer;';

  toast.innerHTML =
    `<div style="display:flex;align-items:start;gap:0.5rem;">` +
    `<span style="font-size:1.1em;line-height:1;">${c.icon}</span>` +
    `<div><strong style="display:block;margin-bottom:2px;">${escapeText(title)}</strong>` +
    `<span style="font-size:0.85em;opacity:0.85;">${escapeText(message)}</span></div>` +
    `</div>`;

  toast.addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';
  });

  // Auto-dismiss after 5s
  setTimeout(() => dismissToast(toast), 5000);
}

function dismissToast(toast) {
  toast.style.opacity = '0';
  toast.style.transform = 'translateX(100%)';
  setTimeout(() => toast.remove(), 300);
}

function escapeText(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
