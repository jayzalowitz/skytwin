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
let _sseListenerWired = false;
let _sseRefreshTimer = null;

function getCurrentUserId() {
  return localStorage.getItem('skytwin.userId') ?? '';
}

/**
 * Subscribe to memory-layer SSE events and debounce a re-render. Memory
 * writes can come in bursts (rapid signal ingest); debouncing to 1s means
 * the dashboard updates once per burst instead of thrashing the DOM.
 *
 * Singleton-wired via a `_sseListenerWired` guard. Gated on hash so the
 * listener no-ops when the user is on another page.
 */
function ensureSseListener() {
  if (_sseListenerWired) return;
  _sseListenerWired = true;
  const refresh = () => {
    if (window.location.hash.split('?')[0] !== '#/memory-settings') return;
    if (_sseRefreshTimer) clearTimeout(_sseRefreshTimer);
    _sseRefreshTimer = setTimeout(() => {
      _sseRefreshTimer = null;
      const container = document.getElementById('page-content');
      if (container) renderMemorySettings(container, getCurrentUserId());
    }, 1000);
  };
  window.addEventListener('sse:memory:page-indexed', refresh);
  window.addEventListener('sse:memory:episode-recorded', refresh);
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

    // #251 Layer 2: tier-weighting toggle. Enabling auto-recomputes the
    // calibration band server-side from the user's recent writing volume.
    if (action === 'toggle-tier-weighting') {
      const next = target.dataset.next === 'true';
      target.disabled = true;
      try {
        const res = await api('/api/memory-config/tier-weighting', {
          method: 'POST',
          body: JSON.stringify({ enabled: next }),
        });
        if (!res.ok) {
          showErrorToast('Failed to update tier weighting');
          return;
        }
        showSavedToast(next ? 'Tier weighting enabled' : 'Tier weighting disabled');
        const container = document.getElementById('page-content');
        if (container) await renderMemorySettings(container, getCurrentUserId());
      } catch {
        // Offline / DNS / network — `api()` throws rather than returning an
        // ok=false response, so without this branch the user would only see
        // the button re-enable with no feedback.
        showErrorToast('Failed to update tier weighting');
      } finally {
        target.disabled = false;
      }
      return;
    }

    // #251 privacy: per-page pin/hide. Sends the chosen override
    // (or null to clear) to /pages/:pageId/override.
    if (action === 'page-override') {
      const pageId = target.dataset.pageId;
      const override = target.dataset.override === 'null' ? null : target.dataset.override;
      if (!pageId) return;
      target.disabled = true;
      try {
        const res = await api(
          `/api/memory-config/pages/${encodeURIComponent(pageId)}/override`,
          {
            method: 'POST',
            body: JSON.stringify({ override }),
          },
        );
        if (!res.ok) {
          showErrorToast('Failed to update page');
          return;
        }
        const label =
          override === 'pinned' ? 'Pinned' : override === 'hidden' ? 'Hidden' : 'Cleared';
        showSavedToast(label);
        const container = document.getElementById('page-content');
        if (container) await renderMemorySettings(container, getCurrentUserId());
      } catch {
        showErrorToast('Failed to update page');
      } finally {
        target.disabled = false;
      }
      return;
    }

    // #251 privacy: per-sender bulk hide. Confirms with the user first
    // since this can hide many rows at once.
    if (action === 'hide-sender') {
      const fromAddress = target.dataset.fromAddress;
      if (!fromAddress) return;
      // Native confirm — not a custom modal because nothing on this page
      // surfaces a generic confirmation UI yet, and "stop indexing all
      // mail from X" is exactly the kind of action that deserves a
      // friction prompt.
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        `Hide all indexed pages from ${fromAddress}? This won't delete the data — they just won't surface in memory search any more.`,
      );
      if (!ok) return;
      target.disabled = true;
      try {
        const res = await api('/api/memory-config/senders/hide', {
          method: 'POST',
          body: JSON.stringify({ fromAddress }),
        });
        if (!res.ok) {
          showErrorToast('Failed to hide sender');
          return;
        }
        const json = (await res.json()) ?? {};
        showSavedToast(`Hid ${json.hidden ?? 0} pages from ${fromAddress}`);
        const container = document.getElementById('page-content');
        if (container) await renderMemorySettings(container, getCurrentUserId());
      } catch {
        showErrorToast('Failed to hide sender');
      } finally {
        target.disabled = false;
      }
      return;
    }
  });
}

export async function renderMemorySettings(container, userId) {
  ensurePageListener();
  ensureSseListener();
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
    ${renderTierWeightingCard(data)}
    ${diagBlock}
    ${renderDashboard(dashboard)}
  `;
}

/**
 * #251 Layer 2 control: toggle authoring-tier-weighted retrieval. Off by
 * default. Enabling auto-recomputes the calibration band server-side from
 * the user's `user_sent_*` page count in the last 90 days, so a thin-sent
 * user gets the sparse weights (capped spread) and a heavy writer gets the
 * dense weights (wide spread).
 */
function renderTierWeightingCard(data) {
  const enabled = data.tierWeighting === true;
  const calibration = data.tierCalibration ?? 'normal';
  const nextState = enabled ? 'false' : 'true';
  return `
    <div class="card" style="margin-top: 1rem;">
      <h3>Weight what you wrote (Layer 2 — beta)</h3>
      <p class="card-subtitle" style="margin: 0.25rem 0 0.75rem;">
        Treat emails you <em>sent</em> as higher-signal than emails you
        received when ranking memory search results. A newsletter that
        mentions "board prep" gets demoted relative to an email you
        actually wrote about board prep. See
        <a href="https://github.com/jayzalowitz/skytwin/issues/251" target="_blank" rel="noopener">issue&nbsp;#251</a>
        for the rationale and calibration table.
      </p>
      <p style="margin: 0 0 0.5rem;">
        Status:
        <strong>${enabled ? 'Enabled' : 'Disabled'}</strong>
        ${enabled ? `<span class="card-subtitle">— calibration: <code>${escapeHtml(calibration)}</code></span>` : ''}
      </p>
      <button class="btn ${enabled ? 'btn-outline' : ''}"
              data-action="toggle-tier-weighting"
              data-next="${nextState}">
        ${enabled ? 'Disable tier weighting' : 'Enable tier weighting'}
      </button>
      <p class="card-subtitle" style="margin-top: 0.75rem;">
        Off by default — we're treating Layer 2 as opt-in until the
        labeled-retrieval eval confirms recall@5 improves on a real
        production corpus. Off mode keeps pure Reciprocal Rank Fusion
        scoring; on mode applies the per-tier multipliers from the issue.
      </p>
    </div>`;
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

  const recentPages = dashboard.pages?.recent ?? [];
  const pagesBlock = recentPages.length === 0
    ? `<p class="card-subtitle">No pages indexed yet. Connect a signal source to start.</p>`
    : `<table class="data-table" style="margin-top: 0.5rem; width: 100%;">
        <thead><tr><th>When</th><th>Tier</th><th>Relationship</th><th>Source</th><th>Title</th><th style="text-align:right;">Actions</th></tr></thead>
        <tbody>
          ${recentPages.map((p) => `
            <tr>
              <td>${formatRelativeTime(p.createdAt)}</td>
              <td>${renderTierBadge(p.authoringTier, p.userOverride)}</td>
              <td>${renderRelationshipBadge(p.relationshipTier)}</td>
              <td>${escapeHtml(p.source ?? '')}</td>
              <td>${escapeHtml(p.title ?? '')}</td>
              <td style="text-align:right; white-space:nowrap;">${renderPageActions(p)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

  return `
    <div class="card" style="margin-top: 1rem;">
      <h3>What your twin remembers</h3>
      <p class="card-subtitle" style="margin-bottom: 1rem;">
        ${dashboard.entities?.total ?? 0} entities and
        ${eps.length} recent episodes indexed.
        Memory feeds back into every decision — past approvals boost similar actions,
        past rejections push them down.
      </p>
      <h4>Recent pages indexed</h4>
      ${pagesBlock}
      <h4 style="margin-top: 1rem;">Recent decisions</h4>
      ${episodesBlock}
      ${fbBlock}
      <h4 style="margin-top: 1rem;">Top entities</h4>
      ${entitiesBlock}
      ${typeBlock}
    </div>
  `;
}

/**
 * #251 privacy: per-row actions for the Recent pages table. The pin and
 * hide buttons swap between "set" and "clear" depending on the current
 * override. The "hide sender" button only shows up for pages that have a
 * fromAddress stamped on metadata (which is most email-derived pages —
 * calendar invites and idle-miner code pages skip it).
 *
 * Buttons emit `data-action` events that the singleton click delegator
 * in `ensurePageListener` catches. No inline onclick — see CLAUDE.md
 * "Frontend Event Handling".
 */
function renderPageActions(page) {
  const pageId = String(page.id ?? '');
  const fromAddress = typeof page.fromAddress === 'string' ? page.fromAddress : '';
  const override = page.userOverride ?? null;
  const pinned = override === 'pinned';
  const hidden = override === 'hidden';
  // If currently pinned/hidden, the button clears; otherwise it sets.
  const pinNext = pinned ? 'null' : 'pinned';
  const hideNext = hidden ? 'null' : 'hidden';
  const pinLabel = pinned ? 'Unpin' : 'Pin';
  const hideLabel = hidden ? 'Unhide' : 'Hide';
  const senderBtn = fromAddress
    ? `<button class="btn btn-sm btn-outline" data-action="hide-sender"
              data-from-address="${escapeHtml(fromAddress)}"
              title="Hide all pages from ${escapeHtml(fromAddress)}"
              style="margin-left: 0.25rem;">Hide sender</button>`
    : '';
  return `
    <button class="btn btn-sm btn-outline" data-action="page-override"
            data-page-id="${escapeHtml(pageId)}"
            data-override="${pinNext}">${pinLabel}</button>
    <button class="btn btn-sm btn-outline" data-action="page-override"
            data-page-id="${escapeHtml(pageId)}"
            data-override="${hideNext}"
            style="margin-left: 0.25rem;">${hideLabel}</button>
    ${senderBtn}
  `;
}

/**
 * #251 Phase 2: relationship-tier badge. Shows how strong the user's
 * back-and-forth with this sender has been over the last 90 days. Used
 * alongside the authoring-tier badge — together they explain why a page
 * ranks where it does.
 */
function renderRelationshipBadge(tier) {
  if (!tier) {
    return '<span class="card-subtitle" style="font-size: 0.85em;">—</span>';
  }
  const map = {
    core: { label: 'core', color: 'var(--success)' },
    frequent: { label: 'frequent', color: 'var(--text)' },
    occasional: { label: 'occasional', color: 'var(--text)' },
    stranger: { label: 'stranger', color: 'var(--muted)' },
  };
  const meta = map[tier] ?? { label: tier, color: 'var(--text)' };
  return `<span style="color: ${meta.color}; font-size: 0.85em;">${escapeHtml(meta.label)}</span>`;
}

/**
 * #251: small inline badge showing the authoring tier a page was classified
 * into. Lets the user see at a glance how the twin is weighting what it
 * reads. Color-coded for skimmability — green for "you wrote it," neutral
 * for personal mail, muted for newsletter/automated noise.
 */
function renderTierBadge(tier, userOverride) {
  if (userOverride === 'pinned') {
    return '<span style="color: var(--info); font-size: 0.85em;">📌 pinned</span>';
  }
  if (userOverride === 'hidden') {
    return '<span style="color: var(--muted); font-size: 0.85em; text-decoration: line-through;">hidden</span>';
  }
  if (!tier) {
    return '<span class="card-subtitle" style="font-size: 0.85em;">—</span>';
  }
  const map = {
    user_sent_originated: { label: 'you wrote', color: 'var(--success)' },
    user_sent_reply: { label: 'you replied', color: 'var(--success)' },
    inbox_personal: { label: 'personal', color: 'var(--text)' },
    inbox_broadcast: { label: 'broadcast', color: 'var(--text)' },
    inbox_newsletter: { label: 'newsletter', color: 'var(--muted)' },
    inbox_automated: { label: 'automated', color: 'var(--muted)' },
  };
  const meta = map[tier] ?? { label: tier, color: 'var(--text)' };
  return `<span style="color: ${meta.color}; font-size: 0.85em;">${escapeHtml(meta.label)}</span>`;
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
