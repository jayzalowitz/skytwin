import { escapeHtml } from '../api-client.js';
import { showSavedToast, showErrorToast } from '../toast.js';

/**
 * Memory backend settings page (#197 AC #6).
 *
 *   - Shows the active backend, declared capabilities, and (in hybrid mode)
 *     a routing-counter snapshot.
 *   - Lets the user switch between gbrain, hybrid, and mempalace.
 *   - Surfaces the "Your twin just got smarter" notice the first time hybrid
 *     mode is enabled (until the user dismisses it).
 *   - Detects an existing local gbrain config / CLI and prompts the user to
 *     try hybrid mode.
 *
 * Singleton click delegator pattern per CLAUDE.md "Frontend Event Handling".
 */

let _pageListenerWired = false;

function getCurrentUserId() {
  return localStorage.getItem('skytwin.userId') ?? '';
}

async function api(path, init = {}) {
  const userId = getCurrentUserId();
  const sessionToken = localStorage.getItem('skytwin.sessionToken') ?? '';
  const url = path.includes('?') ? `${path}&userId=${userId}` : `${path}?userId=${userId}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'content-type': 'application/json',
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
  });
}

function ensurePageListener() {
  if (_pageListenerWired) return;
  _pageListenerWired = true;

  document.addEventListener('click', async (event) => {
    if (window.location.hash.split('?')[0] !== '#/memory-settings') return;
    // event.target can be a Text node when the click lands on whitespace —
    // Text nodes have no .closest(). Other pages guard the same way; see
    // CLAUDE.md "Frontend Event Handling".
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'switch-backend') {
      const backend = target.dataset.backend;
      if (!backend) return;
      target.disabled = true;
      try {
        const res = await api('/api/memory-config', {
          method: 'POST',
          body: JSON.stringify({ backend }),
        });
        if (!res.ok) {
          showErrorToast('Failed to switch memory backend');
          return;
        }
        showSavedToast(`Switched to ${backend}`);
        // Re-render
        const container = document.getElementById('page-content');
        if (container) await renderMemorySettings(container, getCurrentUserId());
      } finally {
        target.disabled = false;
      }
      return;
    }

    if (action === 'dismiss-notification') {
      try {
        await api('/api/memory-config/dismiss-notification', { method: 'POST' });
        const container = document.getElementById('page-content');
        if (container) await renderMemorySettings(container, getCurrentUserId());
      } catch {
        showErrorToast('Failed to dismiss notification');
      }
      return;
    }
  });
}

export async function renderMemorySettings(container, userId) {
  ensurePageListener();
  container.innerHTML = `<div class="card"><h2>Memory backend</h2><p>Loading…</p></div>`;
  let data = null;
  let diagnostics = null;
  let dashboard = null;
  try {
    const [r1, r2, r3] = await Promise.all([
      api('/api/memory-config'),
      api('/api/memory-config/diagnostics'),
      api('/api/memory-config/dashboard'),
    ]);
    if (r1.ok) data = await r1.json();
    if (r2.ok) diagnostics = await r2.json();
    if (r3.ok) dashboard = await r3.json();
  } catch (err) {
    container.innerHTML = `<div class="card"><h2>Memory backend</h2><p>Failed to load: ${escapeHtml(String(err))}</p></div>`;
    return;
  }
  if (!data) {
    container.innerHTML = `<div class="card"><h2>Memory backend</h2><p>Memory backend not available.</p></div>`;
    return;
  }

  const capList = Array.isArray(data.capabilities) ? data.capabilities : [];
  const showSmarterNotice =
    data.backend === 'hybrid' && data.hybridNotificationDismissed === false;
  const suggest = data.suggestion ?? {};
  const showHybridSuggestion =
    suggest.suggest && data.backend !== 'hybrid' && !data.hybridNotificationDismissed;

  const diagBlock = diagnostics?.diagnostics
    ? `<div class="card" style="margin-top: 1rem;">
        <h3>Routing counters (since process start)</h3>
        <ul>
          <li>Reads → primary: ${diagnostics.diagnostics.routedPrimary ?? 0}</li>
          <li>Reads → secondary: ${diagnostics.diagnostics.routedSecondary ?? 0}</li>
          <li>Primary writes ok / failed: ${diagnostics.diagnostics.writesPrimaryOk ?? 0}
            / ${diagnostics.diagnostics.writesPrimaryFailed ?? 0}</li>
          <li>Secondary writes ok / failed: ${diagnostics.diagnostics.writesSecondaryOk ?? 0}
            / ${diagnostics.diagnostics.writesSecondaryFailed ?? 0}</li>
        </ul>
      </div>`
    : '';

  container.innerHTML = `
    ${showSmarterNotice ? `
      <div class="card" style="border-left: 3px solid var(--success); margin-bottom: 1rem;">
        <strong>Your twin just got smarter.</strong>
        Hybrid memory mode is active — semantic + code-aware retrieval is now
        powered by gbrain (vector + tsvector RRF), and graph + episodic memory
        falls through to mempalace.
        <div style="margin-top: 0.5rem;">
          <button class="btn btn-sm" data-action="dismiss-notification">Got it</button>
        </div>
      </div>
    ` : ''}
    ${showHybridSuggestion ? `
      <div class="card" style="border-left: 3px solid var(--info); margin-bottom: 1rem;">
        <strong>You already have a gbrain set up locally.</strong>
        Switch to hybrid mode to combine your existing brain with mempalace's
        spatial + AAAK features.
      </div>
    ` : ''}
    <div class="card">
      <h2>Memory backend</h2>
      <p>This twin's memory is currently powered by:
        <strong>${escapeHtml(data.backend)}</strong>
      </p>
      <ul>
        <li>Total brain pages indexed: ${data.index?.totalPages ?? 0}</li>
        <li>Pages with embeddings: ${data.index?.embeddedPages ?? 0}</li>
        <li>Pending embedding jobs: ${data.index?.pendingEmbeddingJobs ?? 0}</li>
      </ul>
      <h3>Active capabilities</h3>
      <ul>
        ${capList.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
      </ul>
      <h3>Switch backend</h3>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn ${data.backend === 'gbrain' ? '' : 'btn-outline'}"
                data-action="switch-backend" data-backend="gbrain">
          gbrain (default)
        </button>
        <button class="btn ${data.backend === 'hybrid' ? '' : 'btn-outline'}"
                data-action="switch-backend" data-backend="hybrid">
          hybrid (gbrain + mempalace)
        </button>
        <button class="btn ${data.backend === 'mempalace' ? '' : 'btn-outline'}"
                data-action="switch-backend" data-backend="mempalace">
          mempalace only
        </button>
      </div>
      <p class="card-subtitle" style="margin-top: 0.75rem;">
        gbrain is the default. It runs in-process against the SkyTwin
        CockroachDB stack — no extra install needed. Hybrid mode adds the
        legacy mempalace spatial features as a fallback. Mempalace-only is
        for users who prefer the original stack.
      </p>
    </div>
    ${diagBlock}
    ${renderDashboard(dashboard)}
  `;
}

function renderDashboard(dashboard) {
  if (!dashboard) return '';
  const eps = dashboard.episodes?.recent ?? [];
  const fbCounts = dashboard.episodes?.feedbackCounts ?? {};
  const ents = dashboard.entities?.topByRecency ?? [];
  const typeHist = dashboard.entities?.topByType ?? [];

  const episodesBlock = eps.length === 0
    ? `<p class="card-subtitle">No episodes yet. They'll appear here once your twin makes some decisions.</p>`
    : `<table class="data-table" style="margin-top: 0.5rem; width: 100%;">
        <thead><tr><th>When</th><th>Action</th><th>Outcome</th><th>Summary</th></tr></thead>
        <tbody>
          ${eps.map((ep) => `
            <tr>
              <td>${formatRelativeTime(ep.createdAt)}</td>
              <td>${escapeHtml(ep.actionTaken ?? '—')}</td>
              <td>${renderFeedbackBadge(ep.feedbackType)}</td>
              <td>${escapeHtml(ep.summary ?? '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

  const fbBlock = Object.keys(fbCounts).length === 0
    ? ''
    : `<div style="margin-top: 0.5rem; font-size: 0.9em;">
        ${Object.entries(fbCounts).map(([k, v]) =>
          `<span style="margin-right: 0.75rem;">${renderFeedbackBadge(k)} <strong>${v}</strong></span>`
        ).join('')}
      </div>`;

  const entitiesBlock = ents.length === 0
    ? `<p class="card-subtitle">No entities mined yet. Connect Gmail / Calendar to start.</p>`
    : `<ul style="margin-top: 0.5rem;">
        ${ents.map((e) => `
          <li>
            <strong>${escapeHtml(e.name)}</strong>
            <span class="card-subtitle">(${escapeHtml(e.entityType)})</span>
          </li>`).join('')}
      </ul>`;

  const typeBlock = typeHist.length === 0
    ? ''
    : `<div style="margin-top: 0.5rem; font-size: 0.9em;">
        ${typeHist.map((t) =>
          `<span style="margin-right: 0.75rem;">${escapeHtml(t.type)} <strong>${t.count}</strong></span>`
        ).join('')}
      </div>`;

  return `
    <div class="card" style="margin-top: 1rem;">
      <h3>What your twin remembers</h3>
      <p class="card-subtitle" style="margin-bottom: 1rem;">
        ${dashboard.entities?.total ?? 0} entities and
        ${eps.length} recent episodes indexed.
        Memory feeds back into every decision — past approvals boost similar actions,
        past rejections push them down.
      </p>
      <h4>Recent decisions</h4>
      ${episodesBlock}
      ${fbBlock}
      <h4 style="margin-top: 1rem;">Top entities</h4>
      ${entitiesBlock}
      ${typeBlock}
    </div>
  `;
}

function renderFeedbackBadge(type) {
  if (type === 'approve') return '<span style="color: var(--success);">✓ approved</span>';
  if (type === 'reject') return '<span style="color: var(--danger);">✗ rejected</span>';
  if (type === 'undo') return '<span style="color: var(--danger);">↶ undone</span>';
  if (type === 'correct') return '<span style="color: var(--warning);">✎ corrected</span>';
  return '<span class="card-subtitle">pending</span>';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '—';
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return '—';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
