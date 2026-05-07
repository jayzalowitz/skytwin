import {
  fetchCapabilities,
  fetchCapabilityRecipes,
  searchCapabilityRegistry,
  dismissCapabilitySuggestion,
  snoozeCapabilitySuggestion,
  installCapabilityRecipe,
  uninstallCapability,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton click delegator guard.
//
// The SPA reuses one #page-content container across all routes, so
// container.contains(target) is always true for every page's clicks.
// Instead we gate on window.location.hash (authoritative for which page
// is rendered). The guard prevents stacking one new listener per render.
// ─────────────────────────────────────────────────────────────────────────────
let _capabilitiesListenerWired = false;

// Module-level registry search debounce timer
let _registrySearchTimer = null;

// Cached data for partial re-renders (avoids re-fetching on minor mutations)
let _cachedInstalled = [];
let _cachedSuggestions = [];
let _cachedDormant = [];
let _cachedRecipes = [];
let _lastContainer = null;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function ensureCapabilitiesListener() {
  if (_capabilitiesListenerWired || typeof document === 'undefined') return;
  _capabilitiesListenerWired = true;
  document.addEventListener('click', handleCapabilitiesAction);
  document.addEventListener('input', handleCapabilitiesInput);
}

function handleCapabilitiesInput(e) {
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/capabilities') return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target) return;
  if (target.id === 'registry-search') {
    if (_registrySearchTimer) clearTimeout(_registrySearchTimer);
    _registrySearchTimer = setTimeout(() => {
      _registrySearchTimer = null;
      const q = target.value.trim();
      const categorySelect = document.getElementById('registry-category');
      const category = categorySelect ? categorySelect.value : '';
      renderRegistryResults(getCurrentUserId(), q, category);
    }, 400);
  }
}

function handleCapabilitiesAction(e) {
  // CRITICAL: hash-gate, not container.contains — same pattern as approvals.js
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/capabilities') return;

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const btn = target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');
  // Read userId inside the handler so dev "Switch user" can't leave stale closures
  const userId = getCurrentUserId();

  switch (action) {
    case 'dismiss-suggestion': {
      const id = btn.getAttribute('data-suggestion-id');
      if (id) handleDismissSuggestion(id, userId);
      break;
    }
    case 'snooze-suggestion': {
      const id = btn.getAttribute('data-suggestion-id');
      if (id) handleSnoozeSuggestion(id, userId, 7);
      break;
    }
    case 'install-suggestion': {
      const registryId = btn.getAttribute('data-registry-id');
      if (registryId) handleInstallFromSuggestion(registryId, userId);
      break;
    }
    case 'install-recipe': {
      const slug = btn.getAttribute('data-slug');
      if (slug) handleInstallRecipe(slug, userId, btn);
      break;
    }
    case 'registry-search-submit': {
      const q = document.getElementById('registry-search')?.value?.trim() || '';
      const category = document.getElementById('registry-category')?.value || '';
      renderRegistryResults(userId, q, category);
      break;
    }
    case 'registry-category-change': {
      const q = document.getElementById('registry-search')?.value?.trim() || '';
      const category = btn.getAttribute('data-category') || document.getElementById('registry-category')?.value || '';
      renderRegistryResults(userId, q, category);
      break;
    }
    case 'install-registry-entry': {
      const registryId = btn.getAttribute('data-registry-id');
      if (registryId) handleInstallRegistryEntry(registryId, userId, btn);
      break;
    }
    case 'view-capability': {
      const serverId = btn.getAttribute('data-server-id');
      if (serverId) window.location.hash = `#/capabilities/${serverId}`;
      break;
    }
    case 'uninstall-capability': {
      const serverId = btn.getAttribute('data-server-id');
      if (serverId) handleUninstall(serverId, userId, btn);
      break;
    }
    case 'reactivate-capability': {
      // Reactivation: placeholder — mcp-host wiring is downstream (#176 follow-up)
      showToast('Reactivation not yet wired — coming soon.', { kind: 'info' });
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render entry point
// ─────────────────────────────────────────────────────────────────────────────
export async function renderCapabilities(container, userId) {
  _lastContainer = container;
  ensureCapabilitiesListener();

  container.innerHTML = '<div class="loading">Loading capabilities…</div>';

  let capData;
  let recipesData;

  try {
    [capData, recipesData] = await Promise.all([
      fetchCapabilities(userId),
      fetchCapabilityRecipes(userId),
    ]);
  } catch (err) {
    container.innerHTML = renderApiError(err, {
      context: "Couldn't load capabilities.",
      retry: () => renderCapabilities(container, userId),
    });
    wireApiRetry(container, () => renderCapabilities(container, userId));
    return;
  }

  _cachedInstalled = capData.installed ?? [];
  _cachedSuggestions = capData.suggestions ?? [];
  _cachedDormant = capData.dormant ?? [];
  _cachedRecipes = recipesData.recipes ?? [];

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 1.5rem;">

      ${renderSuggestionsSection(_cachedSuggestions)}

      ${renderInstalledSection(_cachedInstalled)}

      <div class="card" id="browse-registry-section">
        <div class="card-header">
          <span class="card-title">Browse registry</span>
        </div>
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          Search available MCP servers and install new capabilities.
        </div>
        <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
          <input class="form-input" id="registry-search" placeholder="Search capabilities…" style="flex: 2; min-width: 160px;">
          <select class="form-input" id="registry-category" style="flex: 1; min-width: 120px;" data-action="registry-category-change">
            <option value="">All categories</option>
            <option value="developer">Developer</option>
            <option value="productivity">Productivity</option>
            <option value="lifestyle">Lifestyle</option>
          </select>
          <button class="btn btn-primary btn-sm" data-action="registry-search-submit">Search</button>
        </div>
        <div id="registry-results">
          <div style="color: var(--text-muted); font-size: 0.85rem;">Type to search, or browse all above.</div>
        </div>
      </div>

      ${renderRecipesSection(_cachedRecipes)}

      ${renderDormantSection(_cachedDormant)}

    </div>
  `;

  // Wire category change separately since it's on a <select>
  document.getElementById('registry-category')?.addEventListener('change', (e) => {
    const q = document.getElementById('registry-search')?.value?.trim() || '';
    const category = e.target.value || '';
    renderRegistryResults(userId, q, category);
  });

  // Auto-load all entries on first render
  renderRegistryResults(userId, '', '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderSuggestionsSection(suggestions) {
  if (suggestions.length === 0) {
    return `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Suggested for you</span>
        </div>
        <div class="card-subtitle">No suggestions right now — I'll surface capabilities when I notice you need them.</div>
      </div>
    `;
  }

  return `
    <div class="card" id="suggestions-section">
      <div class="card-header">
        <span class="card-title">Suggested for you</span>
        <span class="badge badge-warning">${suggestions.length}</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Based on signals from your activity, these capabilities could help.
      </div>
      ${suggestions.map(renderSuggestionCard).join('')}
    </div>
  `;
}

function renderEvidencePreview(item) {
  if (!item || typeof item !== 'object') return '';
  const kind = item.kind;

  if (kind === 'email') {
    const subject = item.subject ? escapeHtml(String(item.subject)) : '(no subject)';
    const snippet = item.snippet ? escapeHtml(String(item.snippet)) : '';
    return `
      <div style="font-size: 0.8rem; padding: 0.4rem 0.5rem; background: var(--surface-2); border-radius: 4px; margin-top: 0.25rem;">
        <div style="font-weight: 500;">📧 ${subject}</div>
        ${snippet ? `<div style="color: var(--text-muted); margin-top: 0.15rem;">${snippet}…</div>` : ''}
      </div>
    `;
  }
  if (kind === 'calendar') {
    const title = item.eventTitle ? escapeHtml(String(item.eventTitle)) : '(untitled)';
    const when = item.startTime ? escapeHtml(String(item.startTime)) : '';
    return `
      <div style="font-size: 0.8rem; padding: 0.4rem 0.5rem; background: var(--surface-2); border-radius: 4px; margin-top: 0.25rem;">
        <div style="font-weight: 500;">📅 ${title}</div>
        ${when ? `<div style="color: var(--text-muted); margin-top: 0.15rem;">${when}</div>` : ''}
      </div>
    `;
  }
  if (kind === 'file_image' && item.thumbnailDataUrl) {
    const name = item.fileName ? escapeHtml(String(item.fileName)) : 'image';
    return `
      <div style="font-size: 0.8rem; padding: 0.4rem 0.5rem; background: var(--surface-2); border-radius: 4px; margin-top: 0.25rem; display: flex; gap: 0.5rem; align-items: center;">
        <img src="${escapeHtml(String(item.thumbnailDataUrl))}" alt="${name}" style="max-width: 48px; max-height: 48px; border-radius: 3px;">
        <span>${name}</span>
      </div>
    `;
  }
  if (kind === 'file_other' || kind === 'file_image') {
    const name = item.fileName ? escapeHtml(String(item.fileName)) : 'file';
    const size = typeof item.fileSizeBytes === 'number' ? `${Math.round(item.fileSizeBytes / 1024)} KB` : '';
    return `
      <div style="font-size: 0.8rem; padding: 0.4rem 0.5rem; background: var(--surface-2); border-radius: 4px; margin-top: 0.25rem;">
        📄 ${name} ${size ? `<span style="color: var(--text-muted);">(${size})</span>` : ''}
      </div>
    `;
  }
  if (kind === 'code_file') {
    const lang = item.language ? escapeHtml(String(item.language)) : '';
    const imports = Array.isArray(item.firstImports) ? item.firstImports.slice(0, 3).map((i) => escapeHtml(String(i))).join(', ') : '';
    return `
      <div style="font-size: 0.8rem; padding: 0.4rem 0.5rem; background: var(--surface-2); border-radius: 4px; margin-top: 0.25rem;">
        <div style="font-weight: 500;">⌨ ${lang}</div>
        ${imports ? `<div style="color: var(--text-muted); margin-top: 0.15rem; font-family: monospace;">imports: ${imports}</div>` : ''}
      </div>
    `;
  }
  return '';
}

function renderSuggestionCard(s) {
  const evidenceText = s.reason_summary
    ? escapeHtml(s.reason_summary)
    : `${escapeHtml(String(s.evidence_count))} signal${s.evidence_count !== 1 ? 's' : ''} detected`;

  const confidence = typeof s.confidence_score === 'number'
    ? `${Math.round(s.confidence_score * 100)}%`
    : typeof s.confidence_score === 'string'
    ? s.confidence_score
    : '';

  const evidenceItems = Array.isArray(s.evidence) ? s.evidence.slice(0, 3) : [];
  const evidenceHtml = evidenceItems.map(renderEvidencePreview).join('');

  return `
    <div class="card" id="suggestion-${escapeHtml(s.id)}" style="margin-bottom: 0.75rem; border-left: 3px solid var(--accent);">
      <div class="card-header">
        <span class="card-title">${escapeHtml(s.display_name)}</span>
        ${confidence ? `<span class="badge badge-info">${escapeHtml(confidence)} confidence</span>` : ''}
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin: 0.25rem 0 0.5rem;">
        ${evidenceText}
      </div>
      ${evidenceHtml ? `<div style="margin-bottom: 0.75rem;">${evidenceHtml}</div>` : ''}
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn-primary btn-sm"
          data-action="install-suggestion"
          data-registry-id="${escapeHtml(s.registry_id)}">Install</button>
        <button class="btn btn-outline btn-sm"
          data-action="snooze-suggestion"
          data-suggestion-id="${escapeHtml(s.id)}">Snooze 7d</button>
        <button class="btn btn-outline btn-sm"
          data-action="dismiss-suggestion"
          data-suggestion-id="${escapeHtml(s.id)}"
          style="color: var(--text-muted);">Dismiss</button>
      </div>
    </div>
  `;
}

function renderInstalledSection(servers) {
  if (servers.length === 0) {
    return `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Installed</span>
        </div>
        <div class="card-subtitle">No capabilities installed yet. Browse the registry or install a recipe below.</div>
      </div>
    `;
  }

  return `
    <div class="card" id="installed-section">
      <div class="card-header">
        <span class="card-title">Installed</span>
        <span class="badge badge-success">${servers.length} active</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.75rem;">
        ${servers.map(renderInstalledCard).join('')}
      </div>
    </div>
  `;
}

function renderInstalledCard(s) {
  const statusBadge = s.status === 'active'
    ? '<span class="badge badge-success">active</span>'
    : `<span class="badge badge-warning">${escapeHtml(s.status)}</span>`;

  return `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.65rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">
      <div style="min-width: 0;">
        <div style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(s.display_name)}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(s.registry_id || '')}</div>
      </div>
      <div style="display: flex; gap: 0.4rem; align-items: center; flex-shrink: 0;">
        ${statusBadge}
        <button class="btn btn-outline btn-sm"
          data-action="view-capability"
          data-server-id="${escapeHtml(s.id)}">Details</button>
        <button class="btn btn-outline btn-sm"
          data-action="uninstall-capability"
          data-server-id="${escapeHtml(s.id)}"
          style="color: var(--danger);">Uninstall</button>
      </div>
    </div>
  `;
}

function renderRecipesSection(recipes) {
  if (!recipes || recipes.length === 0) return '';

  return `
    <div class="card" id="recipes-section">
      <div class="card-header">
        <span class="card-title">Recipes</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Install a curated bundle of capabilities with one click.
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem;">
        ${recipes.map(renderRecipeCard).join('')}
      </div>
    </div>
  `;
}

function renderRecipeCard(r) {
  const categoryBadgeClass = r.category === 'developer' ? 'badge-info'
    : r.category === 'productivity' ? 'badge-success'
    : 'badge-warning';

  return `
    <div style="background: var(--bg); border-radius: var(--radius-sm); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem;">
        <span style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(r.displayName)}</span>
        <span class="badge ${escapeHtml(categoryBadgeClass)}">${escapeHtml(r.category)}</span>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.5;">${escapeHtml(r.description)}</div>
      <div style="font-size: 0.75rem; color: var(--text-dim);">${r.registryIds.length} capabilities</div>
      <button class="btn btn-primary btn-sm" style="margin-top: 0.25rem;"
        data-action="install-recipe"
        data-slug="${escapeHtml(r.slug)}">Install bundle</button>
    </div>
  `;
}

function renderDormantSection(servers) {
  if (servers.length === 0) return '';

  return `
    <div class="card" id="dormant-section">
      <div class="card-header">
        <span class="card-title">Dormant</span>
        <span class="badge badge-warning">${servers.length}</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        These capabilities haven't been used recently and have been paused.
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${servers.map(renderDormantCard).join('')}
      </div>
    </div>
  `;
}

function renderDormantCard(s) {
  return `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.65rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); opacity: 0.75;">
      <div style="min-width: 0;">
        <div style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(s.display_name)}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(s.registry_id || '')} · ${escapeHtml(s.status)}</div>
      </div>
      <div style="display: flex; gap: 0.4rem; align-items: center; flex-shrink: 0;">
        <button class="btn btn-outline btn-sm"
          data-action="reactivate-capability"
          data-server-id="${escapeHtml(s.id)}">Reactivate</button>
        <button class="btn btn-outline btn-sm"
          data-action="uninstall-capability"
          data-server-id="${escapeHtml(s.id)}"
          style="color: var(--danger);">Remove</button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry search (partial re-render — no full page reload)
// ─────────────────────────────────────────────────────────────────────────────

async function renderRegistryResults(userId, q, category) {
  const resultsEl = document.getElementById('registry-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">Searching…</div>';

  try {
    const { entries } = await searchCapabilityRegistry(userId, q, category);
    if (!entries || entries.length === 0) {
      resultsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No results found.</div>';
      return;
    }
    resultsEl.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.6rem;">
        ${entries.map(renderRegistryEntryCard).join('')}
      </div>
    `;
  } catch (err) {
    resultsEl.innerHTML = `<div class="error-banner">${escapeHtml(err.friendlyMessage || err.message)}</div>`;
  }
}

function renderRegistryEntryCard(entry) {
  const verifiedBadge = entry.verified === 'anthropic'
    ? '<span class="badge badge-success" style="font-size: 0.7rem;">Verified</span>'
    : entry.verified === 'community'
    ? '<span class="badge badge-info" style="font-size: 0.7rem;">Community</span>'
    : '';

  const oauthNote = entry.oauthProvider
    ? `<div style="font-size: 0.7rem; color: var(--text-dim); margin-top: 0.25rem;">Requires ${escapeHtml(entry.oauthProvider)} OAuth</div>`
    : '';

  return `
    <div style="background: var(--bg); border-radius: var(--radius-sm); padding: 0.65rem 0.75rem; display: flex; flex-direction: column; gap: 0.35rem;">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.4rem;">
        <span style="font-weight: 600; font-size: 0.85rem;">${escapeHtml(entry.displayName)}</span>
        ${verifiedBadge}
      </div>
      <div style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.45;">${escapeHtml(entry.description)}</div>
      ${oauthNote}
      <button class="btn btn-primary btn-sm" style="margin-top: 0.3rem; align-self: flex-start;"
        data-action="install-registry-entry"
        data-registry-id="${escapeHtml(entry.id)}">Install</button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleDismissSuggestion(id, userId) {
  try {
    await dismissCapabilitySuggestion(id, userId);
    const el = document.getElementById(`suggestion-${id}`);
    if (el) {
      el.style.opacity = '0.4';
      el.style.pointerEvents = 'none';
      el.querySelector('[data-action="dismiss-suggestion"]')?.replaceWith(
        Object.assign(document.createElement('span'), {
          className: 'badge badge-muted',
          textContent: 'Dismissed',
        }),
      );
    }
    showToast('Suggestion dismissed.', { kind: 'success' });
  } catch (err) {
    showToast(err.friendlyMessage || err.message || 'Could not dismiss suggestion.', { kind: 'error' });
  }
}

async function handleSnoozeSuggestion(id, userId, days) {
  try {
    await snoozeCapabilitySuggestion(id, userId, days);
    const el = document.getElementById(`suggestion-${id}`);
    if (el) {
      el.style.opacity = '0.4';
      el.style.pointerEvents = 'none';
    }
    showToast(`Snoozed for ${days} days.`, { kind: 'success' });
  } catch (err) {
    showToast(err.friendlyMessage || err.message || 'Could not snooze suggestion.', { kind: 'error' });
  }
}

async function handleInstallFromSuggestion(registryId, userId) {
  // Install from suggestion: placeholder — actual install wiring is via mcp-host (#176 follow-up)
  showToast(`Install requested for ${registryId} — wiring coming soon.`, { kind: 'info' });
}

async function handleInstallRecipe(slug, userId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  try {
    const { jobs } = await installCapabilityRecipe(userId, slug);
    const count = jobs?.length ?? 0;
    showToast(`Recipe queued: ${count} capability${count !== 1 ? 's' : ''} pending OAuth.`, { kind: 'success' });
  } catch (err) {
    showToast(err.friendlyMessage || err.message || 'Could not install recipe.', { kind: 'error' });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Install bundle'; }
  }
}

async function handleInstallRegistryEntry(registryId, userId, btn) {
  // Direct registry install: placeholder — mcp-host wiring is downstream (#176 follow-up)
  showToast(`Install requested for ${registryId} — wiring coming soon.`, { kind: 'info' });
}

async function handleUninstall(serverId, userId, btn) {
  if (!confirm('Uninstall this capability? This will soft-delete the server record.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
  try {
    await uninstallCapability(serverId, userId);
    showToast('Capability uninstalled.', { kind: 'success' });
    // Re-render the page to reflect the change
    if (_lastContainer) {
      renderCapabilities(_lastContainer, userId);
    }
  } catch (err) {
    showToast(err.friendlyMessage || err.message || 'Could not uninstall.', { kind: 'error' });
    if (btn) { btn.disabled = false; btn.textContent = 'Uninstall'; }
  }
}
