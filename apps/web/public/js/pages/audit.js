import { fetchAudit, escapeHtml, renderApiError, wireApiRetry } from '../api-client.js';

const TYPE_ICONS = {
  tier_change: '\u{1F6E1}',  // shield
  spend_event: '\u{1F4B0}',  // money bag
  preference_change: '\u{1F4A1}', // light bulb
};

const TYPE_LABELS = {
  tier_change: 'Trust earned',
  spend_event: 'Money moved',
  preference_change: 'Learned about you',
};

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString();
}

// Singleton delegator. Re-binding inside renderAudit() (the prior
// implementation) stacked one addEventListener per navigation back to
// /audit — N visits → N parallel loadAudit() fires per click. Hash-route
// gate keeps the singleton from misfiring on other pages (the SPA reuses
// one #page-content container across routes).
let _auditListenerWired = false;
let _auditUserId = '';

export async function renderAudit(container, userId) {
  _auditUserId = userId;
  ensureAuditListener();
  container.innerHTML = `
    <div class="audit-page">
      <div class="card" style="border-left: 3px solid var(--primary);">
        <div class="card-header">
          <span class="card-title">The full paper trail</span>
        </div>
        <div class="card-subtitle">
          Every time your twin earns trust, spends money, or learns something about you, it gets logged here.
          Filter by type or date if you're looking for something specific.
        </div>
      </div>

      <div class="audit-filters" style="margin: 0.5rem 0 1rem;" data-region="audit-filters">
        <label><input type="checkbox" data-type="tier_change" checked> Trust changes</label>
        <label><input type="checkbox" data-type="spend_event" checked> Spending</label>
        <label><input type="checkbox" data-type="preference_change" checked> Things learned</label>
        <input type="date" id="audit-from" class="themed-date" placeholder="From" aria-label="From date">
        <input type="date" id="audit-to" class="themed-date" placeholder="To" aria-label="To date">
        <button id="audit-refresh" class="btn btn-sm" data-action="audit-refresh">Refresh</button>
      </div>

      <div id="audit-timeline" class="audit-timeline">
        <div class="loading">Loading…</div>
      </div>
    </div>
  `;

  await loadAudit();
}

async function loadAudit() {
  const container = document.getElementById('page-content');
  if (!container) return;

  const types = Array.from(container.querySelectorAll('.audit-filters input[type="checkbox"]:checked'))
    .map(cb => cb.dataset.type);
  const from = container.querySelector('#audit-from')?.value || '';
  const to = container.querySelector('#audit-to')?.value || '';

  const timeline = container.querySelector('#audit-timeline');
  if (!timeline) return;
  timeline.innerHTML = '<div class="loading">Loading...</div>';

  try {
    // If all types are checked (or none, treated as all), fetch unfiltered;
    // otherwise fetch each selected type and merge.
    let allEntries = [];
    if (types.length === 3 || types.length === 0) {
      const data = await fetchAudit(_auditUserId, { limit: '100', ...(from && { from }), ...(to && { to }) });
      allEntries = data.entries;
    } else {
      for (const type of types) {
        const data = await fetchAudit(_auditUserId, { type, limit: '50', ...(from && { from }), ...(to && { to }) });
        allEntries.push(...data.entries);
      }
      allEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    if (allEntries.length === 0) {
      timeline.innerHTML = `<div class="empty-state">
        <div class="empty-state-title">Nothing logged yet</div>
        <div class="empty-state-desc">As your twin earns trust, makes spending decisions, or learns something new about you, those moments land here with timestamps you can rely on. Nothing happens in the dark.</div>
      </div>`;
      return;
    }

    timeline.innerHTML = allEntries.map(entry => `
      <div class="audit-entry audit-${escapeHtml(entry.type)}">
        <div class="audit-icon">${TYPE_ICONS[entry.type] || '?'}</div>
        <div class="audit-body">
          <div class="audit-header">
            <span class="audit-type-badge">${escapeHtml(TYPE_LABELS[entry.type] || entry.type)}</span>
            <time class="audit-time">${formatTimestamp(entry.timestamp)}</time>
          </div>
          <div class="audit-description">${escapeHtml(entry.description)}</div>
          ${entry.detail?.decisionId ? `<a href="#/decisions" class="audit-link">View decision</a>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    // UX review #4 (P0): centralized friendly-error helper.
    // (The prior code had `retry: load` — `load` was never defined, so
    // the Retry button silently did nothing. `loadAudit` is the intended
    // reference.)
    timeline.innerHTML = renderApiError(err, {
      context: "Couldn't load the audit trail.",
      retry: loadAudit,
    });
    wireApiRetry(timeline, loadAudit);
  }
}

function isOnAuditRoute() {
  return (window.location.hash || '').split('?')[0] === '#/audit';
}

function ensureAuditListener() {
  if (_auditListenerWired || typeof document === 'undefined') return;
  _auditListenerWired = true;

  // Click delegator — gates on hash route, not DOM containment, because
  // the SPA reuses the same #page-content element across routes.
  document.addEventListener('click', (e) => {
    if (!isOnAuditRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const btn = target.closest('[data-action]');
    if (!btn) return;
    if (btn.getAttribute('data-action') === 'audit-refresh') {
      loadAudit();
    }
  });

  // Filter changes (checkbox toggles + date input edits) auto-reload.
  // Delegated `change` covers both checkbox and date input changes.
  document.addEventListener('change', (e) => {
    if (!isOnAuditRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const filters = target.closest('[data-region="audit-filters"]');
    if (!filters) return;
    loadAudit();
  });
}
