import {
  fetchJSON,
  uninstallCapability,
  rehearseCapability,
  regretCapability,
  fetchCapabilityProvenance,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

const API = '/api';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton delegator guard — same pattern as approvals.js / capabilities.js
// ─────────────────────────────────────────────────────────────────────────────
let _capabilityDetailListenerWired = false;

// Store the current server ID for use by handlers without a closure
let _currentDetailServerId = '';

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function getCurrentDetailHash() {
  // Route is #/capabilities/:id
  return (window.location.hash || '').split('?')[0];
}

function ensureCapabilityDetailListener() {
  if (_capabilityDetailListenerWired || typeof document === 'undefined') return;
  _capabilityDetailListenerWired = true;
  document.addEventListener('click', handleCapabilityDetailAction);
}

function handleCapabilityDetailAction(e) {
  // CRITICAL: hash-gate — only fire when on a /capabilities/:id route
  const hash = getCurrentDetailHash();
  if (!hash.startsWith('#/capabilities/') || hash === '#/capabilities') return;

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const btn = target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');
  // Read userId inside the handler
  const userId = getCurrentUserId();
  const serverId = _currentDetailServerId;

  switch (action) {
    case 'capability-uninstall':
      handleDetailUninstall(serverId, userId);
      break;
    case 'capability-regret': {
      const withinHours = parseInt(btn.getAttribute('data-hours') || '24', 10);
      handleDetailRegret(serverId, userId, withinHours);
      break;
    }
    case 'capability-rehearse': {
      const daysBack = parseInt(btn.getAttribute('data-days') || '30', 10);
      handleDetailRehearse(serverId, userId, daysBack, btn);
      break;
    }
    case 'capability-export-dxt':
      // Placeholder — Export DXT wiring is downstream (#180)
      showToast('Export DXT is not yet wired — coming in #180.', { kind: 'info' });
      break;
    case 'capability-save-spend-cap': {
      const perActionInput = document.getElementById('cap-per-action');
      const perDayInput = document.getElementById('cap-per-day');
      const perAction = perActionInput ? Math.round(parseFloat(perActionInput.value) * 100) : null;
      const perDay = perDayInput ? Math.round(parseFloat(perDayInput.value) * 100) : null;
      handleSaveSpendCap(serverId, userId, perAction, perDay, btn);
      break;
    }
    case 'capability-provenance':
      handleProvenanceFlyout(serverId, userId);
      break;
    case 'provenance-flyout-close':
      closeProvenanceFlyout();
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render entry point
// Called from app.js route dispatch as renderCapabilityDetail(container, userId, serverId)
// ─────────────────────────────────────────────────────────────────────────────
export async function renderCapabilityDetail(container, userId, serverId) {
  _currentDetailServerId = serverId || '';
  ensureCapabilityDetailListener();

  container.innerHTML = '<div class="loading">Loading capability…</div>';

  let server;
  let skills = [];
  let policies = null;

  try {
    // Fetch the server record
    const serverRes = await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}?userId=${encodeURIComponent(userId)}`,
    );
    server = serverRes.server ?? serverRes;
  } catch (err) {
    container.innerHTML = renderApiError(err, {
      context: "Couldn't load this capability.",
      retry: () => renderCapabilityDetail(container, userId, serverId),
    });
    wireApiRetry(container, () => renderCapabilityDetail(container, userId, serverId));
    return;
  }

  // Best-effort: fetch skills and policy settings — don't block render if unavailable
  try {
    const skillsRes = await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}/skills?userId=${encodeURIComponent(userId)}`,
    );
    skills = skillsRes.skills ?? [];
  } catch { /* non-critical */ }

  try {
    const policyRes = await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}/policy?userId=${encodeURIComponent(userId)}`,
    );
    policies = policyRes.policy ?? policyRes ?? null;
  } catch { /* non-critical */ }

  const statusBadgeClass = server.status === 'active' ? 'badge-success'
    : server.status === 'dormant' || server.status === 'paused' ? 'badge-warning'
    : server.status === 'uninstalled' ? 'badge-danger'
    : 'badge-muted';

  const perActionDollars = server.per_app_spend_per_action_cents != null
    ? (server.per_app_spend_per_action_cents / 100).toFixed(2)
    : '';
  const perDayDollars = server.per_app_daily_spend_cents != null
    ? (server.per_app_daily_spend_cents / 100).toFixed(2)
    : '';

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 1.25rem;">

      <!-- Header card -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">${escapeHtml(server.display_name || server.registry_id || 'Capability')}</span>
          <span class="badge ${statusBadgeClass}">${escapeHtml(server.status)}</span>
        </div>
        ${server.registry_id ? `<div class="card-subtitle">${escapeHtml(server.registry_id)}</div>` : ''}
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">
          Trust tier: <strong>${escapeHtml(server.trust_tier || 'observer')}</strong>
          ${server.last_active_at ? ` · Last active: ${escapeHtml(formatRelative(server.last_active_at))}` : ''}
          ${server.installed_at ? ` · Installed: ${escapeHtml(formatRelative(server.installed_at))}` : ''}
        </div>
      </div>

      <!-- Skills -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Skills</span>
          <span class="badge badge-info">${skills.length}</span>
        </div>
        ${skills.length === 0
          ? '<div class="card-subtitle">No skill records yet — skills populate once the server runs.</div>'
          : `<div style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.5rem;">
               ${skills.map(sk => `<span class="badge badge-muted" style="font-size: 0.78rem;">${escapeHtml(sk.skill_name ?? sk)}</span>`).join('')}
             </div>`
        }
      </div>

      <!-- Metrics dashboard (sparklines placeholder — #183 lands the data) -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Usage metrics</span>
        </div>
        <div class="card-subtitle">
          Detailed usage sparklines are coming in #183. Right now:
          ${server.last_active_at
            ? `last used ${escapeHtml(formatRelative(server.last_active_at))}.`
            : 'no usage recorded yet.'}
        </div>
        <!-- TODO (#183): mount sparkline component here once metrics-rollup lands -->
      </div>

      <!-- Per-app policy editor -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Spending guardrails for this capability</span>
        </div>
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          Override global spending limits just for ${escapeHtml(server.display_name || 'this capability')}.
          Leave blank to use your global defaults.
        </div>
        <div class="form-group">
          <label>Max per action</label>
          <div style="position: relative;">
            <span style="position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%); color: var(--text-dim);">$</span>
            <input class="form-input" type="number" id="cap-per-action"
              value="${escapeHtml(perActionDollars)}"
              placeholder="inherit from global"
              min="0" step="0.01" style="padding-left: 1.4rem;">
          </div>
        </div>
        <div class="form-group">
          <label>Max per day</label>
          <div style="position: relative;">
            <span style="position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%); color: var(--text-dim);">$</span>
            <input class="form-input" type="number" id="cap-per-day"
              value="${escapeHtml(perDayDollars)}"
              placeholder="inherit from global"
              min="0" step="0.01" style="padding-left: 1.4rem;">
          </div>
        </div>
        <button class="btn btn-primary btn-sm" data-action="capability-save-spend-cap">Save</button>
        <div id="cap-policy-status" style="font-size: 0.8rem; margin-top: 0.5rem;"></div>
      </div>

      <!-- Actions -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Actions</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem;">
          <button class="btn btn-outline btn-sm" data-action="capability-rehearse" data-days="30">
            Rehearse (30d)
          </button>
          <button class="btn btn-outline btn-sm" data-action="capability-regret" data-hours="24">
            Regret last 24h
          </button>
          <button class="btn btn-outline btn-sm" data-action="capability-provenance">
            View provenance
          </button>
          <button class="btn btn-outline btn-sm" data-action="capability-export-dxt">
            Export DXT
          </button>
          <button class="btn btn-outline btn-sm" data-action="capability-uninstall"
            style="color: var(--danger);">
            Uninstall
          </button>
        </div>
        <div id="capability-action-result" style="margin-top: 0.75rem;"></div>
      </div>

      <!-- Back link -->
      <div>
        <a href="#/capabilities" style="color: var(--accent); font-size: 0.85rem;">← Back to Capabilities</a>
      </div>

    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleDetailUninstall(serverId, userId) {
  if (!confirm('Uninstall this capability? This will soft-delete the server record.')) return;
  try {
    await uninstallCapability(serverId, userId);
    showToast('Capability uninstalled.', { kind: 'success' });
    window.location.hash = '#/capabilities';
  } catch (err) {
    showToast(err.friendlyMessage || err.message || 'Could not uninstall.', { kind: 'error' });
  }
}

async function handleDetailRehearse(serverId, userId, daysBack, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Rehearsing…'; }
  const resultEl = document.getElementById('capability-action-result');
  try {
    const { wouldHaveActions } = await rehearseCapability(serverId, userId, daysBack);
    const count = wouldHaveActions?.length ?? 0;
    if (resultEl) {
      resultEl.innerHTML = `<div class="card" style="border-left: 3px solid var(--accent);">
        <div class="card-header"><span class="card-title">Rehearsal results</span></div>
        <div class="card-subtitle">${count} decision${count !== 1 ? 's' : ''} would have auto-executed in the last ${daysBack} days if trust tier were higher.</div>
      </div>`;
    }
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="error-banner">${escapeHtml(err.friendlyMessage || err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `Rehearse (${daysBack}d)`; }
  }
}

async function handleDetailRegret(serverId, userId, withinHours) {
  if (!confirm(`Roll back reversible actions from this capability in the last ${withinHours}h?`)) return;
  const resultEl = document.getElementById('capability-action-result');
  try {
    const { undone, irreversible } = await regretCapability(serverId, userId, withinHours);
    if (resultEl) {
      resultEl.innerHTML = `<div class="card" style="border-left: 3px solid var(--warning);">
        <div class="card-header"><span class="card-title">Regret results</span></div>
        <div class="card-subtitle">Rolled back: ${undone?.length ?? 0} · Could not undo: ${irreversible?.length ?? 0} (irreversible)</div>
      </div>`;
    }
    showToast('Regret complete.', { kind: 'success' });
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="error-banner">${escapeHtml(err.friendlyMessage || err.message)}</div>`;
  }
}

async function handleSaveSpendCap(serverId, userId, perActionCents, perDayCents, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const statusEl = document.getElementById('cap-policy-status');
  try {
    await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}/policy?userId=${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ perAppSpendPerActionCents: perActionCents, perAppDailySpendCents: perDayCents }),
      },
    );
    if (statusEl) statusEl.innerHTML = '<span style="color: var(--success);">Saved</span>';
    showToast('Spend caps saved.', { kind: 'success' });
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.friendlyMessage || err.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance flyout (issue #177)
// ─────────────────────────────────────────────────────────────────────────────

const PROVENANCE_FLYOUT_ID = 'provenance-flyout';

function closeProvenanceFlyout() {
  const flyout = document.getElementById(PROVENANCE_FLYOUT_ID);
  if (flyout) flyout.remove();
  // Remove backdrop
  const backdrop = document.getElementById('provenance-flyout-backdrop');
  if (backdrop) backdrop.remove();
}

const NODE_TYPE_LABELS = {
  signal:         { icon: '📡', label: 'Signal detected' },
  entity:         { icon: '🔍', label: 'Entity extracted' },
  suggestion:     { icon: '💡', label: 'Install suggested' },
  install:        { icon: '✅', label: 'Installed' },
  tier_promotion: { icon: '⬆️', label: 'Tier promoted' },
  action:         { icon: '⚡', label: 'Action executed' },
  feedback:       { icon: '💬', label: 'Feedback recorded' },
  uninstall:      { icon: '🗑️', label: 'Uninstalled' },
  external_agent: { icon: '🤖', label: 'External agent' },
};

function renderProvenanceNode(node) {
  const meta = NODE_TYPE_LABELS[node.node_type] || { icon: '•', label: node.node_type };
  const when = node.occurred_at ? formatRelative(node.occurred_at) : '';
  const payload = node.payload ? JSON.stringify(node.payload) : null;
  // Truncate payload for display
  const payloadPreview = payload && payload.length > 120
    ? payload.slice(0, 117) + '…'
    : payload;

  return `
    <div class="provenance-node" style="display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.6rem 0; border-bottom: 1px solid var(--border);">
      <span style="font-size: 1.1rem; flex-shrink: 0; margin-top: 0.1rem;">${meta.icon}</span>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 500; font-size: 0.85rem;">${escapeHtml(meta.label)}</div>
        ${payloadPreview
          ? `<div style="font-size: 0.78rem; color: var(--text-dim); word-break: break-all; margin-top: 0.1rem;">${escapeHtml(payloadPreview)}</div>`
          : ''}
      </div>
      <span style="font-size: 0.75rem; color: var(--text-dim); flex-shrink: 0; white-space: nowrap;">${escapeHtml(when)}</span>
    </div>
  `;
}

async function handleProvenanceFlyout(serverId, userId) {
  // Backdrop
  closeProvenanceFlyout(); // close any previous

  const backdrop = document.createElement('div');
  backdrop.id = 'provenance-flyout-backdrop';
  backdrop.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.25); z-index: 200;';
  backdrop.addEventListener('click', closeProvenanceFlyout);
  document.body.appendChild(backdrop);

  // Flyout drawer
  const flyout = document.createElement('div');
  flyout.id = PROVENANCE_FLYOUT_ID;
  flyout.style.cssText = [
    'position: fixed; right: 0; top: 0; bottom: 0; z-index: 201;',
    'width: min(420px, 100vw);',
    'background: var(--bg-card); border-left: 1px solid var(--border);',
    'box-shadow: -4px 0 20px rgba(0,0,0,0.12);',
    'display: flex; flex-direction: column; overflow: hidden;',
  ].join(' ');

  flyout.innerHTML = `
    <div style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
      <h3 style="margin: 0; font-size: 1rem;">Capability provenance</h3>
      <button class="btn btn-sm" data-action="provenance-flyout-close"
              aria-label="Close provenance flyout"
              style="background: none; border: none; font-size: 1.25rem; cursor: pointer; padding: 0; color: var(--text-dim);">&times;</button>
    </div>
    <div id="provenance-flyout-body" style="flex: 1; overflow-y: auto; padding: 0.75rem 1.25rem;">
      <p class="muted">Loading provenance chain…</p>
    </div>
  `;

  document.body.appendChild(flyout);

  const bodyEl = flyout.querySelector('#provenance-flyout-body');

  try {
    const data = await fetchCapabilityProvenance(serverId, userId);
    const nodes = data?.nodes || [];

    if (nodes.length === 0) {
      bodyEl.innerHTML = `
        <div class="empty-state" style="padding: 2rem 0;">
          <div class="empty-state-title">No provenance nodes yet</div>
          <div class="empty-state-desc">The lineage chain will populate as this capability is used.</div>
        </div>
      `;
    } else {
      bodyEl.innerHTML = `
        <p class="muted" style="font-size: 0.82rem; margin-bottom: 1rem;">
          ${nodes.length} event${nodes.length === 1 ? '' : 's'} — oldest first
        </p>
        <div class="provenance-chain">
          ${nodes.map(renderProvenanceNode).join('')}
        </div>
      `;
    }
  } catch (err) {
    bodyEl.innerHTML = renderApiError(err, { context: "Couldn't load provenance chain." });
  }
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
  return `${diffDays}d ago`;
}
