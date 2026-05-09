import { fetchLifebook, hideLifebook, escapeHtml } from '../api-client.js';
import { showSavedToast, showErrorToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

/**
 * Per-Lifebook page (#193 Child 1).
 *
 * Reads `#/lifebook/<domainName>`, fetches the lifebook + wing summary,
 * and renders the domain's importance, sample signals, suggested
 * capabilities, and a Hide button. Detection itself is worker-driven —
 * this page is read-only except for the visibility toggle.
 */

let _lifebookListenerWired = false;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

/**
 * Parse `#/lifebook/<domain>` from the current location hash.
 * Returns null when the route doesn't match.
 */
export function parseLifebookRoute() {
  const raw = (window.location.hash || '').split('?')[0];
  const match = raw.match(/^#\/lifebook\/(.+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function importanceBadge(importance) {
  const colors = {
    core: 'var(--success)',
    secondary: 'var(--text)',
    emerging: 'var(--text-muted)',
  };
  const label = {
    core: 'Core',
    secondary: 'Secondary',
    emerging: 'Emerging',
  }[importance] ?? importance;
  const color = colors[importance] ?? 'var(--text-muted)';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;color:${color};border:1px solid ${color};">${escapeHtml(label)}</span>`;
}

export async function renderLifebook(container, _userIdFromArg) {
  ensureLifebookListener();
  const userId = getCurrentUserId();
  const domainName = parseLifebookRoute();
  if (!userId || !domainName) {
    container.innerHTML = '<div class="error-banner">Could not load Lifebook — missing route.</div>';
    return;
  }

  container.innerHTML = '<div class="card"><span class="card-subtitle">Loading…</span></div>';

  let data;
  try {
    data = await fetchLifebook(userId, domainName);
  } catch (err) {
    container.innerHTML = `<div class="error-banner">Lifebook not found: ${escapeHtml(err?.message ?? domainName)}</div>`;
    return;
  }

  const lb = data?.lifebook;
  const wing = data?.wingSummary;
  if (!lb) {
    container.innerHTML = `<div class="error-banner">Lifebook for "${escapeHtml(domainName)}" not found.</div>`;
    return;
  }

  const signals = Array.isArray(lb.sampleSignals) ? lb.sampleSignals : [];
  const caps = Array.isArray(lb.suggestedCapabilities) ? lb.suggestedCapabilities : [];

  container.innerHTML = `
    <div class="card">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;">
        <div>
          <span class="card-title">${escapeHtml(lb.domainName)}</span>
          <div style="margin-top:0.25rem;">${importanceBadge(lb.importance)}</div>
        </div>
        <button class="btn btn-outline btn-sm" data-action="hide-lifebook" data-domain="${escapeHtml(lb.domainName)}">Hide from dashboard</button>
      </div>
      <div class="card-subtitle" style="margin-top:0.5rem;">
        Detected ${lb.detectedAt ? formatDate(lb.detectedAt) : 'recently'} · last seen ${lb.lastSeenAt ? formatDate(lb.lastSeenAt) : 'recently'}
      </div>
    </div>

    ${wing ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Memory wing</span></div>
      <div class="card-subtitle">${wing.roomCount} rooms · ${wing.drawerCount}+ drawers</div>
      ${lb.wingId ? `<a href="#/provenance?wing=${encodeURIComponent(lb.wingId)}" class="btn btn-outline btn-sm" style="margin-top:0.5rem;">Open in provenance graph</a>` : ''}
    </div>
    ` : ''}

    ${signals.length > 0 ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Sample signals</span></div>
      <ul style="margin:0.5rem 0 0;padding-left:1.25rem;">
        ${signals.slice(0, 5).map((s) => `<li style="margin-bottom:0.25rem;">${escapeHtml(s)}</li>`).join('')}
      </ul>
    </div>
    ` : ''}

    ${caps.length > 0 ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Suggested capabilities</span></div>
      <div class="card-subtitle">Capability categories the LLM suggests for this domain. Browse the registry to install matching MCP servers.</div>
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.5rem;">
        ${caps.map((c) => `<span style="display:inline-block;padding:4px 10px;border-radius:14px;font-size:0.8rem;background:var(--bg);border:1px solid var(--border);">${escapeHtml(c)}</span>`).join('')}
      </div>
      <a href="#/capabilities" class="btn btn-outline btn-sm" style="margin-top:0.75rem;">Browse capabilities</a>
    </div>
    ` : ''}
  `;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function ensureLifebookListener() {
  if (_lifebookListenerWired || typeof document === 'undefined') return;
  _lifebookListenerWired = true;
  document.addEventListener('click', async (e) => {
    if ((window.location.hash || '').split('?')[0].indexOf('#/lifebook/') !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const btn = target.closest('[data-action="hide-lifebook"]');
    if (!btn) return;
    const domain = btn.getAttribute('data-domain');
    if (!domain) return;
    if (!confirm(`Hide ${domain} from dashboards? Your memories stay; only the surface visibility changes.`)) return;
    try {
      await hideLifebook(getCurrentUserId(), domain);
      showSavedToast(`${domain} hidden`);
      window.location.hash = '#/';
    } catch (err) {
      showErrorToast(`Couldn't hide: ${err?.message ?? 'unknown error'}`);
    }
  });
}
