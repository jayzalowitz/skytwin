import {
  fetchJSON,
  uninstallCapability,
  rehearseCapability,
  regretCapability,
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
      // Navigate to the provenance graph page (#184 wires the viz)
      window.location.hash = `#/provenance/${serverId}`;
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
            Provenance graph
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
