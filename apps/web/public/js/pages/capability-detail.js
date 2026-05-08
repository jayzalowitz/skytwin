import {
  fetchJSON,
  uninstallCapability,
  rehearseCapability,
  regretCapability,
  fetchCapabilityProvenance,
  fetchCapabilityChangelog,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';

/** Warn threshold for success-rate display. Matches @skytwin/observability constant. */
const SUCCESS_RATE_WARN_THRESHOLD = 0.9;
/** Warn threshold for p95 latency (ms). Matches @skytwin/observability constant. */
const LATENCY_P95_WARN_MS = 2000;
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
    case 'capability-zero-trust-enable':
      handleZeroTrustToggle(serverId, userId, true, btn);
      break;
    case 'capability-zero-trust-disable':
      handleZeroTrustToggle(serverId, userId, false, btn);
      break;
  }
}

async function handleZeroTrustToggle(serverId, userId, enable, btn) {
  if (!serverId || !userId) return;
  if (btn) btn.setAttribute('disabled', 'disabled');
  try {
    const path = enable ? 'enable' : 'disable';
    const res = await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}/zero-trust/${path}?userId=${encodeURIComponent(userId)}`,
      { method: 'POST' },
    );
    showToast(
      `Zero-trust ${enable ? 'enabled' : 'disabled'}.`,
      { kind: 'success' },
    );
    void res;
    // Re-render to reflect new state
    const container = document.getElementById('page-content');
    if (container) await renderCapabilityDetail(container, userId, serverId);
  } catch (err) {
    showToast(
      err instanceof Error ? err.message : 'Failed to toggle zero-trust',
      { kind: 'error' },
    );
  } finally {
    if (btn) btn.removeAttribute('disabled');
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

      <!-- Performance metrics (#183) -->
      <div class="card" id="metrics-card">
        <div class="card-header">
          <span class="card-title">Performance</span>
        </div>
        <div class="card-subtitle" style="margin-bottom: 0.75rem;">
          Last 24 hours — latency and success rate.
          ${server.last_active_at
            ? `Last used ${escapeHtml(formatRelative(server.last_active_at))}.`
            : 'No usage recorded yet.'}
        </div>
        <div id="sparkline-container">
          <div style="color: var(--text-muted); font-size: 0.85rem;">Loading metrics…</div>
        </div>
      </div>

      <!-- Changelog (#184 AC#2) -->
      <div class="card" id="changelog-card">
        <div class="card-header">
          <span class="card-title">Changelog</span>
        </div>
        <div id="changelog-container">
          <div style="color: var(--text-muted); font-size: 0.85rem;">Loading changelog…</div>
        </div>
      </div>

      <!-- Monthly cost meter (#183) -->
      <div class="card" id="monthly-cost-card">
        <div class="card-header">
          <span class="card-title">Monthly spend</span>
        </div>
        <div id="monthly-cost-container">
          <div style="color: var(--text-muted); font-size: 0.85rem;">Loading spend data…</div>
        </div>
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

      <!-- Zero-trust mode (#183 AC#4) -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Zero-trust mode</span>
          ${server.zero_trust_mode ? '<span class="badge badge-warning">enabled</span>' : '<span class="badge" style="opacity: 0.6;">disabled</span>'}
        </div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin: 0.5rem 0 0.75rem;">
          When enabled, the toggle is recorded as a provenance event and surfaced
          throughout the capability's audit trail. The runtime enforcement —
          a +1 risk modifier on every action and a forced approval prompt regardless
          of trust tier — is wired through <code>applyZeroTrustOverride()</code> in
          <code>@skytwin/policy-engine</code> but not yet invoked from the decision
          pipeline; that wiring is tracked as a #222 follow-up. Container-level
          network isolation lives in the desktop app (#180).
        </div>
        ${server.zero_trust_mode
          ? `<button class="btn btn-outline btn-sm" data-action="capability-zero-trust-disable">Disable zero-trust</button>`
          : `<button class="btn btn-warning btn-sm" data-action="capability-zero-trust-enable">Enable zero-trust</button>`}
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

  // Best-effort: load sparklines, monthly cost meter, and changelog asynchronously
  loadSparklines(serverId, userId);
  loadMonthlyCostMeter(serverId, userId, server);
  loadChangelog(serverId, userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline + monthly cost meter (#183)
// ─────────────────────────────────────────────────────────────────────────────

async function loadSparklines(serverId, userId) {
  const el = document.getElementById('sparkline-container');
  if (!el) return;
  try {
    const data = await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}/metrics?userId=${encodeURIComponent(userId)}&hours=24`,
    );
    const points = data.sparkline || [];
    if (points.length === 0) {
      el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No metrics collected yet — tool call data populates once the server is used.</div>';
      return;
    }
    el.innerHTML = renderSparklineSvgs(points);
  } catch {
    el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.82rem;">Metrics unavailable.</div>';
  }
}

function renderSparklineSvgs(points) {
  const latencies50 = points.map(p => p.latencyP50Ms ?? 0);
  const latencies95 = points.map(p => p.latencyP95Ms ?? 0);
  const successRates = points.map(p => p.successRate ?? 1);

  const p50Last = latencies50.at(-1) ?? 0;
  const p95Last = latencies95.at(-1) ?? 0;
  const srLast = successRates.at(-1) ?? 1;

  const p95Color = p95Last > LATENCY_P95_WARN_MS ? 'var(--warning)' : 'var(--accent)';
  const srColor = srLast < SUCCESS_RATE_WARN_THRESHOLD ? 'var(--danger)' : 'var(--success)';

  return `
    <div style="display: flex; gap: 1.5rem; flex-wrap: wrap;">
      <div>
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.25rem;">Latency p50</div>
        <div style="font-size: 1.1rem; font-weight: 600;">${p50Last}ms</div>
        ${renderSvgSparkline(latencies50, 'var(--accent)')}
      </div>
      <div>
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.25rem;">Latency p95</div>
        <div style="font-size: 1.1rem; font-weight: 600; color: ${escapeHtml(p95Color)};">${p95Last}ms</div>
        ${renderSvgSparkline(latencies95, p95Color)}
      </div>
      <div>
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.25rem;">Success rate</div>
        <div style="font-size: 1.1rem; font-weight: 600; color: ${escapeHtml(srColor)};">${Math.round(srLast * 100)}%</div>
        ${renderSvgSparkline(successRates.map(r => r * 100), srColor)}
      </div>
    </div>
    <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.5rem;">${points.length} minute-buckets in the last 24h</div>
  `;
}

/**
 * Render a simple SVG polyline sparkline from an array of values.
 * No external library — lightweight inline SVG.
 */
function renderSvgSparkline(values, color) {
  if (!values.length) return '';
  const W = 120, H = 32, PAD = 2;
  const max = Math.max(...values, 1);
  const step = (W - PAD * 2) / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => {
    const x = PAD + i * step;
    const y = H - PAD - ((v / max) * (H - PAD * 2));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${W}" height="${H}" style="display:block;" aria-hidden="true">
    <polyline points="${escapeHtml(points)}" fill="none" stroke="${escapeHtml(color)}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

async function loadMonthlyCostMeter(serverId, userId, server) {
  const el = document.getElementById('monthly-cost-container');
  if (!el) return;

  // Fetch the server's monthly cap from the server record (set via mcp_servers table)
  const perMonthCap = server.per_app_monthly_spend_cents ?? null;

  if (perMonthCap === null) {
    el.innerHTML = `
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        No monthly cap configured.
        <a href="#/settings" style="color: var(--accent); margin-left: 0.25rem;">Configure in settings</a>
      </div>
    `;
    return;
  }

  try {
    // Fetch current month spend from the metrics table
    const data = await fetchJSON(
      `${API}/capabilities/${encodeURIComponent(serverId)}/metrics?userId=${encodeURIComponent(userId)}&hours=720`,
    );
    const recent = data.recent || [];
    // Sum spend_cents across all buckets in the current calendar month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const spentCents = recent
      .filter(b => new Date(b.bucket_started_at) >= monthStart)
      .reduce((sum, b) => sum + (b.spend_cents || 0), 0);

    const spentDollars = (spentCents / 100).toFixed(2);
    const capDollars = (perMonthCap / 100).toFixed(2);
    const pct = perMonthCap > 0 ? Math.min(100, Math.round((spentCents / perMonthCap) * 100)) : 0;
    const barColor = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';

    el.innerHTML = `
      <div style="font-size: 0.9rem; margin-bottom: 0.5rem;">
        $${escapeHtml(spentDollars)} of $${escapeHtml(capDollars)} used this month
        <span style="font-size: 0.8rem; color: var(--text-muted);">(${pct}%)</span>
      </div>
      <div style="background: var(--border); border-radius: 9999px; height: 8px; overflow: hidden;">
        <div style="width: ${pct}%; background: ${escapeHtml(barColor)}; height: 100%; border-radius: 9999px; transition: width 0.3s;"></div>
      </div>
      ${server.per_app_monthly_rollover
        ? '<div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.35rem;">Unspent budget rolls over monthly.</div>'
        : ''}
    `;
  } catch {
    el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.82rem;">Spend data unavailable.</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Changelog card (#184 AC#2)
// ─────────────────────────────────────────────────────────────────────────────

async function loadChangelog(serverId, userId) {
  const el = document.getElementById('changelog-container');
  if (!el) return;
  try {
    const data = await fetchCapabilityChangelog(serverId, userId);
    const changelog = data.changelog;
    if (!changelog) {
      el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No changelog published by this server.</div>';
      return;
    }

    const version = changelog.current_version
      ? `<span style="font-weight: 600; font-size: 1rem;">${escapeHtml(changelog.current_version)}</span>`
      : '<span style="color: var(--text-muted); font-size: 0.85rem;">Version unknown</span>';

    const fetchedAt = changelog.fetched_at
      ? `<div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">Last fetched: ${escapeHtml(formatRelative(changelog.fetched_at))}</div>`
      : '';

    const rawHtml = changelog.raw_text
      ? `<details style="margin-top: 0.75rem;">
           <summary style="cursor: pointer; font-size: 0.85rem; color: var(--accent);">Show full changelog</summary>
           <pre style="white-space: pre-wrap; word-break: break-word; font-size: 0.78rem; color: var(--text); margin-top: 0.5rem; background: var(--surface-2); padding: 0.75rem; border-radius: var(--radius-sm); overflow-x: auto;">${escapeHtml(changelog.raw_text)}</pre>
         </details>`
      : '<div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 0.5rem;">No changelog text available.</div>';

    el.innerHTML = `
      <div>${version}</div>
      ${fetchedAt}
      ${rawHtml}
    `;
  } catch (err) {
    // 404 means no changelog fetched yet — show a gentle nudge
    if (err && err.kind === 'not-found') {
      el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No changelog fetched yet. The weekly sweep will check again soon.</div>';
    } else {
      el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.82rem;">Changelog unavailable.</div>';
    }
  }
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
