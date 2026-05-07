import { fetchJSON, escapeHtml, renderApiError, wireApiRetry } from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

const API = '/api';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton delegator guard — same pattern as capabilities.js / approvals.js.
//
// The SPA reuses one #page-content container; container.contains(target) is
// always true. We gate on window.location.hash (authoritative for current page)
// and attach once to document, never inside the render function.
// ─────────────────────────────────────────────────────────────────────────────
let _capabilitiesAuditListenerWired = false;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function ensureCapabilitiesAuditListener() {
  if (_capabilitiesAuditListenerWired || typeof document === 'undefined') return;
  _capabilitiesAuditListenerWired = true;
  document.addEventListener('click', handleCapabilitiesAuditAction);
  document.addEventListener('input', handleCapabilitiesAuditInput);
  document.addEventListener('change', handleCapabilitiesAuditChange);
}

function handleCapabilitiesAuditInput(e) {
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/capabilities/audit') return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target) return;
  if (target.id === 'audit-search') {
    scheduleFilteredRender();
  }
}

function handleCapabilitiesAuditChange(e) {
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/capabilities/audit') return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target) return;
  if (target.id === 'audit-node-type' || target.id === 'audit-date-from' || target.id === 'audit-date-to') {
    scheduleFilteredRender();
  }
}

let _auditFilterTimer = null;
function scheduleFilteredRender() {
  if (_auditFilterTimer) clearTimeout(_auditFilterTimer);
  _auditFilterTimer = setTimeout(() => {
    _auditFilterTimer = null;
    const userId = getCurrentUserId();
    renderAuditTable(userId, 0);
  }, 300);
}

function handleCapabilitiesAuditAction(e) {
  // CRITICAL: hash-gate, not container.contains
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/capabilities/audit') return;

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const btn = target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');
  const userId = getCurrentUserId();

  switch (action) {
    case 'audit-prev-page': {
      const offset = parseInt(btn.getAttribute('data-offset') || '0', 10);
      renderAuditTable(userId, Math.max(0, offset));
      break;
    }
    case 'audit-next-page': {
      const offset = parseInt(btn.getAttribute('data-offset') || '0', 10);
      renderAuditTable(userId, offset);
      break;
    }
    case 'audit-search-submit': {
      renderAuditTable(userId, 0);
      break;
    }
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render entry point
// ─────────────────────────────────────────────────────────────────────────────
export async function renderCapabilitiesAudit(container, userId) {
  ensureCapabilitiesAuditListener();

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 1.25rem;">

      <div class="card">
        <div class="card-header">
          <span class="card-title">Capability audit trail</span>
        </div>
        <div class="card-subtitle">
          Every capability event — installs, tier promotions, actions, and feedback — is logged here.
        </div>
      </div>

      <!-- Filter bar -->
      <div class="card">
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: flex-end;">
          <div style="flex: 2; min-width: 160px;">
            <label style="font-size: 0.8rem; color: var(--text-muted);">Search payload</label>
            <input class="form-input" id="audit-search" placeholder="Filter by keyword…" style="margin-top: 0.25rem;">
          </div>
          <div style="flex: 1; min-width: 140px;">
            <label style="font-size: 0.8rem; color: var(--text-muted);">Event type</label>
            <select class="form-input" id="audit-node-type" style="margin-top: 0.25rem;">
              <option value="">All types</option>
              <option value="signal">Signal</option>
              <option value="entity">Entity</option>
              <option value="suggestion">Suggestion</option>
              <option value="install">Install</option>
              <option value="tier_promotion">Tier promotion</option>
              <option value="action">Action</option>
              <option value="feedback">Feedback</option>
              <option value="uninstall">Uninstall</option>
              <option value="external_agent">External agent</option>
            </select>
          </div>
          <div style="flex: 1; min-width: 120px;">
            <label style="font-size: 0.8rem; color: var(--text-muted);">From</label>
            <input class="form-input" type="date" id="audit-date-from" style="margin-top: 0.25rem;">
          </div>
          <div style="flex: 1; min-width: 120px;">
            <label style="font-size: 0.8rem; color: var(--text-muted);">To</label>
            <input class="form-input" type="date" id="audit-date-to" style="margin-top: 0.25rem;">
          </div>
          <button class="btn btn-primary btn-sm" data-action="audit-search-submit" style="align-self: flex-end;">Search</button>
        </div>
      </div>

      <!-- Results table -->
      <div id="audit-table-container">
        <div class="loading">Loading audit trail…</div>
      </div>

      <div>
        <a href="#/capabilities" style="color: var(--accent); font-size: 0.85rem;">← Back to Capabilities</a>
      </div>

    </div>
  `;

  await renderAuditTable(userId, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Table partial re-render (handles pagination and filter changes)
// ─────────────────────────────────────────────────────────────────────────────

async function renderAuditTable(userId, offset) {
  const container = document.getElementById('audit-table-container');
  if (!container) return;

  container.innerHTML = '<div class="loading">Loading…</div>';

  const nodeType = document.getElementById('audit-node-type')?.value || '';
  const dateFrom = document.getElementById('audit-date-from')?.value || '';
  const dateTo = document.getElementById('audit-date-to')?.value || '';
  const q = document.getElementById('audit-search')?.value || '';

  const params = new URLSearchParams({ userId, limit: '50', offset: String(offset) });
  if (nodeType) params.set('nodeType', nodeType);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (q) params.set('q', q);

  let data;
  try {
    data = await fetchJSON(`${API}/capabilities/audit?${params.toString()}`);
  } catch (err) {
    container.innerHTML = renderApiError(err, {
      context: "Couldn't load audit trail.",
      retry: () => renderAuditTable(userId, offset),
    });
    wireApiRetry(container, () => renderAuditTable(userId, offset));
    return;
  }

  const nodes = data.nodes || [];
  const total = data.total ?? 0;
  const limit = data.limit ?? 50;

  if (nodes.length === 0) {
    container.innerHTML = `
      <div class="card">
        <div class="card-subtitle">No audit events match your filters.</div>
      </div>
    `;
    return;
  }

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Events</span>
        <span class="badge badge-info">${total} total</span>
      </div>
      <div style="overflow-x: auto; margin-top: 0.75rem;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border); text-align: left;">
              <th style="padding: 0.4rem 0.6rem; font-weight: 600; color: var(--text-muted);">Type</th>
              <th style="padding: 0.4rem 0.6rem; font-weight: 600; color: var(--text-muted);">When</th>
              <th style="padding: 0.4rem 0.6rem; font-weight: 600; color: var(--text-muted);">Table</th>
              <th style="padding: 0.4rem 0.6rem; font-weight: 600; color: var(--text-muted);">Payload (preview)</th>
            </tr>
          </thead>
          <tbody>
            ${nodes.map(renderAuditRow).join('')}
          </tbody>
        </table>
      </div>
      ${hasPrev || hasNext ? `
        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem; justify-content: flex-end;">
          <button class="btn btn-outline btn-sm"
            data-action="audit-prev-page"
            data-offset="${prevOffset}"
            ${hasPrev ? '' : 'disabled'}>Previous</button>
          <span style="font-size: 0.8rem; color: var(--text-muted); align-self: center;">
            ${offset + 1}–${Math.min(offset + limit, total)} of ${total}
          </span>
          <button class="btn btn-outline btn-sm"
            data-action="audit-next-page"
            data-offset="${nextOffset}"
            ${hasNext ? '' : 'disabled'}>Next</button>
        </div>
      ` : ''}
    </div>
  `;
}

const NODE_TYPE_BADGE = {
  signal:         'badge-muted',
  entity:         'badge-muted',
  suggestion:     'badge-info',
  install:        'badge-success',
  tier_promotion: 'badge-warning',
  action:         'badge-info',
  feedback:       'badge-info',
  uninstall:      'badge-danger',
  external_agent: 'badge-muted',
};

function renderAuditRow(node) {
  const badgeClass = NODE_TYPE_BADGE[node.node_type] || 'badge-muted';
  const when = node.occurred_at ? formatRelative(node.occurred_at) : '';
  const payloadStr = node.payload ? JSON.stringify(node.payload) : '';
  const payloadPreview = payloadStr.length > 80 ? payloadStr.slice(0, 77) + '…' : payloadStr;

  return `
    <tr style="border-bottom: 1px solid var(--border);">
      <td style="padding: 0.5rem 0.6rem;">
        <span class="badge ${escapeHtml(badgeClass)}">${escapeHtml(node.node_type)}</span>
      </td>
      <td style="padding: 0.5rem 0.6rem; color: var(--text-muted); white-space: nowrap;">
        ${escapeHtml(when)}
      </td>
      <td style="padding: 0.5rem 0.6rem; color: var(--text-dim); font-size: 0.78rem;">
        ${escapeHtml(node.ref_table || '')}
      </td>
      <td style="padding: 0.5rem 0.6rem; color: var(--text-dim); font-size: 0.78rem; word-break: break-all;">
        ${escapeHtml(payloadPreview)}
      </td>
    </tr>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatRelative(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}
