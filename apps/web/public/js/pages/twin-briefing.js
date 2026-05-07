/**
 * Twin Briefing page — #/briefing (issue #177)
 *
 * Shows the latest daily or weekly twin briefing in rendered Markdown.
 * Pattern: singleton delegator + hash-gate, same as about-me.js.
 */
import {
  fetchLatestTwinBriefing,
  listTwinBriefings,
  markBriefingRead,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton delegator guard — see CLAUDE.md "Frontend Event Handling".
// Hash-gated, not container-gated.
// ─────────────────────────────────────────────────────────────────────────────
let _briefingListenerWired = false;
let _container = null;
let _activeCadence = 'daily';

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function isOnBriefingRoute() {
  return (window.location.hash || '').split('?')[0] === '#/briefing';
}

function ensureBriefingListener() {
  if (_briefingListenerWired || typeof document === 'undefined') return;
  _briefingListenerWired = true;
  document.addEventListener('click', handleBriefingClick);
}

function handleBriefingClick(e) {
  if (!isOnBriefingRoute()) return;
  const target = e.target instanceof HTMLElement ? e.target.closest('[data-action]') : null;
  if (!target) return;

  const action = target.dataset.action;
  const userId = getCurrentUserId();
  if (!userId) return;

  if (action === 'briefing-tab') {
    const cadence = target.dataset.cadence;
    if (cadence === 'daily' || cadence === 'weekly') {
      _activeCadence = cadence;
      renderBriefingTab(userId, cadence);
    }
  } else if (action === 'mark-briefing-read') {
    const id = target.dataset.briefingId;
    if (id) handleMarkRead(id, userId);
  } else if (action === 'briefing-history-item') {
    const id = target.dataset.briefingId;
    if (id) handleShowHistoryItem(id, userId);
  }
}

async function handleMarkRead(briefingId, userId) {
  try {
    await markBriefingRead(briefingId, userId);
    showToast('Briefing marked as read.', { kind: 'success', durationMs: 2000 });
    // Update the badge in place
    const badge = document.querySelector(`[data-briefing-id="${CSS.escape(briefingId)}"] .briefing-unread-badge`);
    if (badge) badge.remove();
  } catch (err) {
    showToast('Could not mark briefing read: ' + (err?.message || 'unknown'), { kind: 'error' });
  }
}

async function handleShowHistoryItem(briefingId, userId) {
  // Re-render the prose section with the selected history item
  const rows = await listTwinBriefings(userId, { limit: 30 }).catch(() => ({ briefings: [] }));
  const target = (rows.briefings || []).find((b) => b.id === briefingId);
  if (!target) return;
  renderProseSection(target);
}

function renderProseSection(briefing) {
  const el = document.getElementById('briefing-prose');
  if (!el) return;

  const prose = briefing ? briefing.prose_markdown || '' : '';
  const generated = briefing ? new Date(briefing.generated_at) : null;
  const isRead = !!briefing?.read_at;

  el.innerHTML = `
    <div class="briefing-meta" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; font-size: 0.82rem; color: var(--text-dim);">
      <span>
        ${generated ? `Generated ${formatTime(generated)}` : ''}
        ${!isRead && briefing
          ? `<span class="badge badge-info briefing-unread-badge" data-briefing-id="${escapeHtml(briefing.id)}" style="margin-left: 0.5rem;">New</span>`
          : ''}
      </span>
      ${!isRead && briefing
        ? `<button class="btn btn-sm btn-outline"
              data-action="mark-briefing-read"
              data-briefing-id="${escapeHtml(briefing.id)}"
              style="font-size: 0.78rem;">Mark as read</button>`
        : ''}
    </div>
    <div class="briefing-prose-content" style="white-space: pre-wrap; line-height: 1.7;">
      ${prose ? escapeHtml(prose) : '<em class="muted">No briefing content yet.</em>'}
    </div>
  `;
}

async function renderBriefingTab(userId, cadence) {
  const tabContent = document.getElementById('briefing-tab-content');
  if (!tabContent) return;

  // Update tab active state
  document.querySelectorAll('[data-action="briefing-tab"]').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.cadence === cadence);
  });

  tabContent.innerHTML = `<p class="muted">Loading…</p>`;

  try {
    const data = await fetchLatestTwinBriefing(userId, cadence);
    const briefing = data?.briefing;

    const prosePl = document.createElement('div');
    prosePl.id = 'briefing-prose';
    tabContent.innerHTML = '';
    tabContent.appendChild(prosePl);
    renderProseSection(briefing);

    // History sidebar
    const historyData = await listTwinBriefings(userId, { cadence, limit: 10 }).catch(() => ({ briefings: [] }));
    const history = historyData?.briefings || [];
    if (history.length > 1) {
      const histEl = document.createElement('div');
      histEl.className = 'briefing-history';
      histEl.innerHTML = `
        <h4 style="font-size: 0.82rem; color: var(--text-dim); margin-bottom: 0.5rem;">Previous briefings</h4>
        ${history.slice(1).map((b) => `
          <button class="briefing-history-item"
                  data-action="briefing-history-item"
                  data-briefing-id="${escapeHtml(b.id)}"
                  style="display: block; width: 100%; text-align: left; padding: 0.4rem 0.5rem; margin-bottom: 0.2rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-card); cursor: pointer; font-size: 0.82rem;">
            ${formatTime(new Date(b.generated_at))}
            ${!b.read_at ? '<span class="badge badge-info" style="font-size: 0.7rem; margin-left: 0.25rem;">New</span>' : ''}
          </button>
        `).join('')}
      `;
      tabContent.appendChild(histEl);
    }
  } catch (err) {
    tabContent.innerHTML = renderApiError(err, {
      context: "Couldn't load your twin briefing.",
      retry: () => renderBriefingTab(userId, cadence),
    });
    wireApiRetry(tabContent, () => renderBriefingTab(userId, cadence));
  }
}

/**
 * Entry point called by app.js for the #/briefing route.
 */
export async function renderTwinBriefing(container) {
  ensureBriefingListener();
  _container = container;
  const userId = getCurrentUserId();
  if (!userId) {
    container.innerHTML = '<p class="muted">Please log in to view your briefing.</p>';
    return;
  }

  container.innerHTML = `
    <section class="twin-briefing-page">
      <header style="margin-bottom: 1.5rem;">
        <h1>Twin Briefing</h1>
        <p class="subtle">Your twin's periodic summary of what it's been up to.</p>
      </header>

      <div class="briefing-tabs" style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
        <button class="btn btn-sm btn-outline is-active"
                data-action="briefing-tab"
                data-cadence="daily">Daily</button>
        <button class="btn btn-sm btn-outline"
                data-action="briefing-tab"
                data-cadence="weekly">Weekly</button>
      </div>

      <div id="briefing-tab-content">
        <p class="muted">Loading…</p>
      </div>
    </section>
  `;

  // Load the default tab
  await renderBriefingTab(userId, _activeCadence);
}

function formatTime(d) {
  if (!d) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}
