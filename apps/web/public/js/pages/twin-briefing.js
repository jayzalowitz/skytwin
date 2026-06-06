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
  } else if (action === 'open-signal') {
    // Citation chip → in-app signal/decision detail (spec 08). Never an
    // external URL. Routes to the decisions page filtered to the signal ref.
    const ref = target.dataset.signalRef;
    if (ref) window.location.hash = `#/decisions?signal=${encodeURIComponent(ref)}`;
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

// Source-type → accessible label for the digest source chip (spec 08, #481).
// Text labels (not icon-only) for a11y; unknown types fall back to a neutral chip.
const SOURCE_CHIP_LABELS = {
  email: 'email',
  gmail: 'email',
  calendar: 'calendar',
  google_calendar: 'calendar',
  filesystem: 'file',
  file: 'file',
  voice: 'voice',
  app: 'app',
};

function sourceChip(sourceType) {
  const label = SOURCE_CHIP_LABELS[sourceType] || 'source';
  return `<span class="source-chip source-chip-${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function citationChips(signalRefs) {
  if (!Array.isArray(signalRefs) || signalRefs.length === 0) return '';
  // Each chip links to the in-app signal/decision detail — NEVER a raw external
  // URL (spec 06 / safety invariant #8). data-action delegated, no inline handler.
  return signalRefs
    .map(
      (ref) =>
        `<button type="button" class="citation-chip" data-action="open-signal" data-signal-ref="${escapeHtml(
          String(ref),
        )}" aria-label="source: ${escapeHtml(String(ref))}">source</button>`,
    )
    .join(' ');
}

/**
 * Render the structured digest (spec 01/08): To-dos bucket above Topics, each row
 * source-aware + cited. Returns '' when there's no structured payload (caller
 * falls back to prose — back-compat for old briefings).
 */
function renderDigestSection(structured) {
  if (!structured || (!structured.todos?.length && !structured.topics?.length)) return '';

  const todos = (structured.todos || [])
    .map(
      (t) => `
      <li class="digest-todo">
        ${sourceChip(t.sourceType)}
        <span class="digest-todo-text">${escapeHtml(t.text || '')}</span>
        ${t.deadline ? `<span class="digest-deadline">${escapeHtml(String(t.deadline))}</span>` : ''}
        ${citationChips(t.signalRefs)}
      </li>`,
    )
    .join('');

  const topics = (structured.topics || [])
    .map(
      (group) => `
      <div class="digest-topic">
        <h4 class="digest-topic-title">${escapeHtml(group.title || group.domain || 'Topic')}</h4>
        <ul>
          ${(group.items || [])
            .map(
              (it) => `
            <li class="digest-topic-item">
              ${sourceChip(it.sourceType)}
              <span>${escapeHtml(it.text || '')}</span>
              ${citationChips(it.signalRefs)}
            </li>`,
            )
            .join('')}
        </ul>
      </div>`,
    )
    .join('');

  return `
    <section class="digest" aria-label="Digest">
      <h3 class="digest-heading">To-dos</h3>
      ${todos ? `<ul class="digest-todos">${todos}</ul>` : '<p class="muted">Nothing needs you right now.</p>'}
      <h3 class="digest-heading">Topics to catch up on</h3>
      ${topics || '<p class="muted">No topics today.</p>'}
    </section>
  `;
}

function renderProseSection(briefing) {
  const el = document.getElementById('briefing-prose');
  if (!el) return;

  const prose = briefing ? briefing.prose_markdown || '' : '';
  const generated = briefing ? new Date(briefing.generated_at) : null;
  const isRead = !!briefing?.read_at;
  // Spec 08: render the structured two-bucket digest when present; the prose
  // block stays as a fallback / long-form view.
  const digestHtml = renderDigestSection(briefing?.structured);

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
    ${digestHtml}
    ${
      digestHtml
        ? // When the structured digest renders, the prose is redundant — tuck it
          // under a disclosure as the long-form view (design-review: avoid
          // showing the same briefing twice).
          `<details class="briefing-prose-details">
             <summary class="muted">Full briefing</summary>
             <div class="briefing-prose-content" style="white-space: pre-wrap; line-height: 1.7;">
               ${prose ? escapeHtml(prose) : '<em class="muted">No briefing content yet.</em>'}
             </div>
           </details>`
        : `<div class="briefing-prose-content" style="white-space: pre-wrap; line-height: 1.7;">
             ${prose ? escapeHtml(prose) : '<em class="muted">No briefing content yet.</em>'}
           </div>`
    }
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
    // #320: per-Lifebook sections folded into the same response.
    // Always an array — empty when no per-Lifebook briefings exist
    // (new user, none have been generated yet).
    const sections = Array.isArray(data?.sections) ? data.sections : [];

    const prosePl = document.createElement('div');
    prosePl.id = 'briefing-prose';
    tabContent.innerHTML = '';
    tabContent.appendChild(prosePl);
    renderProseSection(briefing);

    // #320: per-Lifebook collapsible sections, rendered between the
    // global prose and the history sidebar. Skipped entirely when
    // sections[] is empty (no need to claim space for nothing).
    if (sections.length > 0) {
      const sectionsEl = document.createElement('div');
      sectionsEl.id = 'briefing-lifebook-sections';
      tabContent.appendChild(sectionsEl);
      renderLifebookSections(sections, sectionsEl);
    }

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

/**
 * #320: render the per-Lifebook briefings as collapsible cards under
 * the global prose. Each card is a `<details>` element — native browser
 * collapsing, zero JS state. The summary line shows the domain name +
 * importance badge + age; the body shows the briefing prose.
 *
 * Cards are appended in the order `sections[]` arrives (which the API
 * sorts by Lifebook importance: core → secondary → emerging, then
 * last_seen_at DESC). The first 1 (core) section is open by default;
 * the rest are collapsed so a user with many Lifebooks doesn't get a
 * wall of text on load.
 */
function renderLifebookSections(sections, container) {
  const importanceBadge = (imp) => {
    const colors = { core: 'var(--success)', secondary: 'var(--text)', emerging: 'var(--text-muted)' };
    const labels = { core: 'Core', secondary: 'Secondary', emerging: 'Emerging' };
    const color = colors[imp] ?? 'var(--text-muted)';
    return `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:0.7rem;font-weight:600;color:${color};border:1px solid ${color};margin-left:0.4rem;">${escapeHtml(labels[imp] ?? imp)}</span>`;
  };

  const cards = sections.map((section, idx) => {
    const briefing = section.briefing;
    const generated = briefing?.generated_at ? new Date(briefing.generated_at) : null;
    const ageStr = generated ? formatTime(generated) : '';
    const prose = briefing?.prose_markdown || '';
    // First card is open by default — most users will look at it
    // immediately, and pre-opening it avoids a "what's in here?" click.
    // Subsequent cards stay collapsed.
    const openAttr = idx === 0 ? ' open' : '';
    return `
      <details${openAttr} style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:0.5rem;">
        <summary style="cursor:pointer;padding:0.6rem 0.8rem;font-size:0.9rem;display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">
          <span>
            <strong>${escapeHtml(section.domainName)}</strong>
            ${importanceBadge(section.importance)}
          </span>
          ${ageStr ? `<span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(ageStr)}</span>` : ''}
        </summary>
        <div style="padding:0 0.8rem 0.8rem;white-space:pre-wrap;line-height:1.6;font-size:0.88rem;color:var(--text);">
          ${prose ? escapeHtml(prose) : '<em class="muted">No briefing prose yet.</em>'}
        </div>
      </details>
    `;
  });

  container.innerHTML = `
    <h4 style="font-size:0.82rem;color:var(--text-dim);margin:1.25rem 0 0.5rem;">By Lifebook</h4>
    ${cards.join('')}
  `;
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
