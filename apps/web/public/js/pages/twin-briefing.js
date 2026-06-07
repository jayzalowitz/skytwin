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
  } else if (action === 'toggle-power-view') {
    // Spec 14: flip the persisted power-view preference and re-render the tab.
    try {
      localStorage.setItem(POWER_VIEW_KEY, isPowerView() ? '0' : '1');
    } catch {
      /* localStorage unavailable — non-fatal */
    }
    renderBriefingTab(userId, _activeCadence);
  } else if (action === 'toggle-item-detail') {
    // Spec 14: per-item inline detail expand (no re-render).
    const item = target.closest('.digest-todo, .digest-topic-item');
    if (item) item.classList.toggle('detail-open');
  } else if (action === 'toggle-check') {
    // Mark a to-do done (visual). Persistence rides with the act layer.
    target.classList.toggle('is-on');
    const row = target.closest('.digest-todo');
    if (row) row.classList.toggle('is-done');
  } else if (action === 'row-action') {
    // Inline action zone (DESIGN.md). The act layer (draft/snooze/verify) wires
    // these to real execution; until then, route or acknowledge honestly.
    const act = target.dataset.act;
    if (act === 'grant') {
      window.location.hash = '#/settings';
    } else {
      showToast(`"${act}" runs through the act layer — wiring lands with that work.`, { kind: 'info', durationMs: 2600 });
    }
  } else if (action === 'connect-source') {
    window.location.hash = '#/settings';
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

// ── Digest render (DESIGN.md) ───────────────────────────────────────────────
// Calm command center: iris accent = "needs you / act"; action zone (to-dos) vs
// awareness zone (topics); source as a small neutral mark (not a chip), one
// citation affordance, provenance as a dot, power-view depth on demand.

const SOURCE_LABELS = {
  email: 'email', gmail: 'email', calendar: 'calendar', google_calendar: 'calendar',
  filesystem: 'file', file: 'file', voice: 'voice', app: 'app',
};
function renderSource(sourceType) {
  const label = SOURCE_LABELS[sourceType];
  return label ? `<span class="digest-source">${escapeHtml(label)}</span>` : '';
}

// One quiet citation affordance per row → opens the in-app signal/decision detail.
// NEVER a raw external URL (safety #8).
function renderCite(signalRefs) {
  if (!Array.isArray(signalRefs) || signalRefs.length === 0) return '';
  const n = signalRefs.length;
  return `<button type="button" class="digest-cite" data-action="open-signal" data-signal-ref="${escapeHtml(
    String(signalRefs[0]),
  )}" aria-label="view ${n} source${n > 1 ? 's' : ''}">·${n} source${n > 1 ? 's' : ''}</button>`;
}

// Provenance dot: filled (neutral) = from you, hollow = inbound. Never accent-colored.
function provDot(detail) {
  const you = detail && /from you/i.test(detail.provenanceLabel || '');
  return `<span class="digest-prov ${you ? 'you' : 'inbound'}" title="${you ? 'from you' : 'inbound'}"></span>`;
}

// Power view (spec 14): persisted, defaults OFF (clean view is the default).
const POWER_VIEW_KEY = 'skytwin.digest.powerView';
function isPowerView() {
  try { return localStorage.getItem(POWER_VIEW_KEY) === '1'; } catch { return false; }
}

function detailToggle(detail) {
  return detail ? `<button type="button" class="digest-detail-toggle" data-action="toggle-item-detail">Details</button>` : '';
}
function detailPanel(detail) {
  if (!detail) return '';
  // The actionable "suggested" step is shown in the row itself; this power-view
  // panel is the trust/technical metadata behind the decision.
  const rows = [`<div><span class="dd-k">origin</span> ${escapeHtml(detail.provenanceLabel || '')}</div>`];
  if (typeof detail.confidencePct === 'number') rows.push(`<div><span class="dd-k">confidence</span> ${detail.confidencePct}%</div>`);
  if (detail.urgencyReason) rows.push(`<div><span class="dd-k">urgency</span> ${escapeHtml(detail.urgencyReason)}</div>`);
  if (Array.isArray(detail.whyNotAutoExecuted) && detail.whyNotAutoExecuted.length)
    rows.push(`<div><span class="dd-k">not auto-run</span> ${detail.whyNotAutoExecuted.map((r) => escapeHtml(String(r))).join('; ')}</div>`);
  if (Array.isArray(detail.sourceRefs) && detail.sourceRefs.length)
    rows.push(`<div><span class="dd-k">refs</span> <code>${detail.sourceRefs.map((r) => escapeHtml(String(r))).join(', ')}</code></div>`);
  if (detail.explanation) rows.push(`<div><span class="dd-k">why</span> ${escapeHtml(detail.explanation)}</div>`);
  return `<div class="digest-detail">${rows.join('')}</div>`;
}

// Inline action zone (the "it can act" thesis). Primary actions come from the
// payload (item.actions) when the act layer is wired; security + scope-blocked
// states derive from what we know today; Snooze is the universal default.
function renderActions(t) {
  const d = t.detail;
  const scopeBlocked = d && Array.isArray(d.whyNotAutoExecuted) && d.whyNotAutoExecuted.some((r) => /permission|scope/i.test(r));
  const acts = [];
  if (t.kind === 'security') {
    acts.push(`<button class="digest-act primary" data-action="row-action" data-act="verify">Verify in app</button>`);
  } else {
    if (Array.isArray(t.actions)) {
      for (const a of t.actions) acts.push(`<button class="digest-act primary" data-action="row-action" data-act="${escapeHtml(a.id || '')}">${escapeHtml(a.label || '')}</button>`);
    } else if (scopeBlocked) {
      acts.push(`<button class="digest-act grant" data-action="row-action" data-act="grant">Grant access</button>`);
    }
    acts.push(`<button class="digest-act" data-action="row-action" data-act="snooze">Snooze</button>`);
  }
  return `<div class="digest-actions">${acts.join('')}</div>`;
}

function renderTodoRow(t) {
  const isSec = t.kind === 'security';
  const open = isPowerView() ? '' : '';
  return `
    <li class="digest-todo${isSec ? ' is-security' : ''}${open}">
      ${isSec ? '' : `<button type="button" class="digest-check" data-action="toggle-check" aria-label="mark done"></button>`}
      ${provDot(t.detail)}
      <div class="digest-todo-body">
        <div>
          <span class="digest-todo-text">${escapeHtml(t.text || '')}</span>
          ${t.deadline ? `<span class="digest-deadline">${escapeHtml(String(t.deadline))}</span>` : ''}
          ${renderSource(t.sourceType)}
          ${renderCite(t.signalRefs)}
          ${detailToggle(t.detail)}
        </div>
        ${t.body ? `<div class="digest-body">${escapeHtml(t.body)}</div>` : ''}
        ${t.detail?.suggestedAction ? `<div class="digest-suggested">→ ${escapeHtml(t.detail.suggestedAction)}</div>` : ''}
        ${isSec ? `<div class="digest-todo-hint">Open your provider directly — don't trust links in the message.</div>` : ''}
        ${detailPanel(t.detail)}
      </div>
      ${renderActions(t)}
    </li>`;
}

function renderTopicItem(it) {
  return `
    <li class="digest-topic-item">
      ${provDot(it.detail)}
      <div class="digest-todo-body">
        <div>${escapeHtml(it.text || '')} ${renderSource(it.sourceType)} ${renderCite(it.signalRefs)} ${detailToggle(it.detail)}</div>
        ${it.body ? `<div class="digest-body">${escapeHtml(it.body)}</div>` : ''}
        ${it.detail?.suggestedAction ? `<div class="digest-suggested">→ ${escapeHtml(it.detail.suggestedAction)}</div>` : ''}
        ${detailPanel(it.detail)}
      </div>
    </li>`;
}

function renderCoveragePanel(coverage) {
  if (!coverage || !Array.isArray(coverage.capabilityStatus)) return '';
  const status = coverage.capabilityStatus
    .map(
      (c) =>
        `<li><span class="cov-dot cov-${escapeHtml(c.status)}"></span>${escapeHtml(c.capability)}${
          c.status !== 'available' && c.unlockedBy?.length
            ? ` <span class="muted">— connect ${escapeHtml(c.unlockedBy.join(', '))}</span>`
            : ''
        }</li>`,
    )
    .join('');
  return `<div class="digest-coverage"><h4 class="digest-topic-title">What I can see</h4><ul class="digest-coverage-list">${status}</ul></div>`;
}

// Cold-start: zero connectors → the PRIMARY surface, not a buried panel (DESIGN.md).
function renderColdStart(coverage) {
  const sources = ['Gmail', 'Calendar', 'Files'];
  return `
    <div class="digest-state">
      <p class="digest-voice">Connect a source and I'll start your briefing.</p>
      <p class="sub">I read your signals, surface what needs you, and handle the rest under your rules.</p>
      <div class="digest-coldstart-sources">
        ${sources.map((s) => `<button class="digest-act primary" data-action="connect-source" data-source="${escapeHtml(s)}">Connect ${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>`;
}

/**
 * Render the structured digest (DESIGN.md). Returns '' when there's no structured
 * payload (caller falls back to prose). Handles cold-start + empty-quiet states.
 */
function renderDigestSection(structured) {
  if (!structured) return '';
  if (structured.coverage?.coldStart) return renderColdStart(structured.coverage);

  const todoList = structured.todos || [];
  const topicList = structured.topics || [];
  if (!todoList.length && !topicList.length) {
    return `<section class="digest"><p class="digest-voice">You're all caught up.</p><p class="muted">Nothing needs you right now.</p></section>`;
  }
  const powerOn = isPowerView();

  // Value line: the twin earned its keep.
  const needYou = todoList.length;
  const catchUp = topicList.reduce((n, g) => n + (g.items?.length || 0), 0);
  const handled = typeof structured.handledCount === 'number' ? structured.handledCount : null;
  const valueLine = `
    <p class="digest-value">
      ${handled !== null ? `<span class="done">✓ ${handled} handled on my own</span><span class="sep"></span>` : ''}
      <span><b>${needYou}</b> need you</span><span class="sep"></span>
      <span><b>${catchUp}</b> to catch up on</span>
    </p>`;

  const todos = todoList.map(renderTodoRow).join('');
  const topics = topicList
    .map(
      (g) => `<div class="digest-topic"><h4 class="digest-topic-title">${escapeHtml(g.title || g.domain || 'Topic')}</h4><ul>${(g.items || []).map(renderTopicItem).join('')}</ul></div>`,
    )
    .join('');

  return `
    <section class="digest ${powerOn ? 'digest--power' : ''}" aria-label="Digest">
      <div class="digest-toolbar">
        <button type="button" class="digest-power-toggle" data-action="toggle-power-view" aria-pressed="${powerOn ? 'true' : 'false'}">
          ${powerOn ? 'Power view: on' : 'Power view'}
        </button>
      </div>
      <p class="digest-voice">${needYou === 1 ? 'One thing needs you.' : `${needYou} things need you.`}</p>
      ${valueLine}
      <div class="digest-heading">To-dos <span class="count">· ${needYou}</span></div>
      ${todos ? `<ul class="digest-todos">${todos}</ul>` : '<p class="muted">Nothing needs you right now.</p>'}
      <div class="digest-heading">Topics to catch up on <span class="count">· ${catchUp}</span></div>
      ${topics || '<p class="muted">No topics today.</p>'}
      ${powerOn ? renderCoveragePanel(structured.coverage) : ''}
    </section>
  `;
}

function renderProseSection(briefing) {
  const el = document.getElementById('briefing-prose');
  if (!el) return;

  const prose = briefing ? briefing.prose_markdown || '' : '';
  const generated = briefing ? new Date(briefing.generated_at) : null;
  const isRead = !!briefing?.read_at;
  // The live-computed digest (no stored row) carries the sentinel id 'live';
  // read-state controls only apply to a persisted briefing.
  const isPersisted = !!briefing && briefing.id !== 'live';
  // Spec 08: render the structured two-bucket digest when present; the prose
  // block stays as a fallback / long-form view.
  const digestHtml = renderDigestSection(briefing?.structured);

  el.innerHTML = `
    <div class="briefing-meta" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; font-size: 0.82rem; color: var(--text-dim);">
      <span>
        ${generated ? `Generated ${formatTime(generated)}` : ''}
        ${!isRead && isPersisted
          ? `<span class="badge badge-info briefing-unread-badge" data-briefing-id="${escapeHtml(briefing.id)}" style="margin-left: 0.5rem;">New</span>`
          : ''}
      </span>
      ${!isRead && isPersisted
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

  // Loading skeleton (DESIGN.md gap state) instead of bare "Loading…".
  tabContent.innerHTML = `
    <div class="digest-skel" aria-busy="true" aria-label="Loading briefing">
      <div class="sk voice"></div>
      <div class="sk row"></div><div class="sk row"></div><div class="sk row"></div>
    </div>`;

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
