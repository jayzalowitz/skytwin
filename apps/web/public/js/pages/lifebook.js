import {
  fetchLifebook,
  fetchLifebookBriefing,
  fetchLifebookLayout,
  hideLifebook,
  setLifebookImportance,
  clearLifebookImportance,
  editLifebookFact,
  escapeHtml,
} from '../api-client.js';
import { showSavedToast, showErrorToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

/**
 * Per-Lifebook page (#193 Child 1, adaptive layout #319).
 *
 * Reads `#/lifebook/<domainName>`, fetches the lifebook + wing summary +
 * adaptive layout (from the lifebook-layout prompt), and renders sections
 * in the layout's chosen order. When the LLM isn't configured / the wing
 * is sparse / the prompt errors, the server returns the deterministic
 * `generic-two-column` layout — same code path, no separate fallback
 * branch in the renderer.
 */

let _lifebookListenerWired = false;
// The most-recently-rendered container, captured so the singleton
// delegated handler can re-render in place after a mutation (importance
// change) without the handler closing over a stale container from an
// earlier render.
let _lifebookContainer = null;

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

const IMPORTANCE_ORDER = ['emerging', 'secondary', 'core'];
const IMPORTANCE_LABELS = { core: 'Core', secondary: 'Secondary', emerging: 'Emerging' };

function importanceBadge(importance) {
  const colors = {
    core: 'var(--success)',
    secondary: 'var(--text)',
    emerging: 'var(--text-muted)',
  };
  const label = IMPORTANCE_LABELS[importance] ?? importance;
  const color = colors[importance] ?? 'var(--text-muted)';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;color:${color};border:1px solid ${color};">${escapeHtml(label)}</span>`;
}

/**
 * #321 promote/demote ceremony — the user-facing control for telling
 * the twin "treat this Lifebook as more / less important than the
 * weekly extractor decided." Renders three tier buttons (Emerging →
 * Secondary → Core); the current tier is the disabled/active one, the
 * others promote or demote. When a manual override is in effect we
 * surface a "set by you" line + a Clear button that hands importance
 * back to the extractor.
 *
 * No inline handlers — every control is a `data-action` button that the
 * hash-gated singleton delegator (`ensureLifebookListener`) dispatches.
 * The domain is carried on `data-domain` and the target tier on
 * `data-importance` so the handler reads the current user id at click
 * time (per CLAUDE.md "Frontend Event Handling").
 */
export function renderImportanceControl(lb) {
  const current = lb.importance;
  const override = lb.importanceOverride; // { value, setAt, decayDays } | null
  const buttons = IMPORTANCE_ORDER.map((tier) => {
    const isCurrent = tier === current;
    const cls = isCurrent ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
    const disabledAttr = isCurrent ? ' aria-pressed="true" disabled' : '';
    return `<button type="button" class="${cls}" data-action="set-importance" data-domain="${escapeHtml(lb.domainName)}" data-importance="${escapeHtml(tier)}"${disabledAttr}>${escapeHtml(IMPORTANCE_LABELS[tier])}</button>`;
  }).join('');

  const overrideLine = override
    ? `<div class="card-subtitle" style="margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
         <span style="color:var(--accent, #7C72E8);">Set by you${override.decayDays === 0 ? ' (stays until you clear it)' : ` · resets ${formatOverrideExpiry(override)}`}.</span>
         <button type="button" class="btn btn-outline btn-sm" data-action="clear-importance" data-domain="${escapeHtml(lb.domainName)}">Let the twin decide</button>
       </div>`
    : `<div class="card-subtitle" style="margin-top:0.5rem;">Auto-detected by your weekly review. Promote or demote to tell the twin what matters right now.</div>`;

  return `
    <div class="card">
      <div class="card-header"><span class="card-title">How important is this right now?</span></div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.5rem;">${buttons}</div>
      ${overrideLine}
    </div>
  `;
}

/**
 * Format the date an override decays back to the extractor's pick:
 * `setAt + decayDays`. Defensive — bad input falls back to a vague
 * "soon" rather than rendering `Invalid Date`.
 */
export function formatOverrideExpiry(override) {
  try {
    const setAt = new Date(override.setAt);
    if (Number.isNaN(setAt.getTime())) return 'soon';
    const expiry = new Date(setAt.getTime() + override.decayDays * 24 * 60 * 60 * 1000);
    return expiry.toLocaleDateString();
  } catch {
    return 'soon';
  }
}

export async function renderLifebook(container, _userIdFromArg) {
  ensureLifebookListener();
  _lifebookContainer = container;
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

  // #193 + #319 follow-ups in parallel — both are best-effort.
  //   - briefing: per-Lifebook briefing if the worker has emitted one
  //   - layout: adaptive section ordering from the lifebook-layout prompt
  // Both endpoints fail-soft (briefing returns null when none exists;
  // layout returns the generic shape when LLM is unavailable / wing is
  // sparse), so the page always renders even when both calls degrade.
  const [briefingResult, layoutResult] = await Promise.allSettled([
    fetchLifebookBriefing(userId, domainName),
    fetchLifebookLayout(userId, domainName),
  ]);
  const briefing =
    briefingResult.status === 'fulfilled' ? briefingResult.value?.briefing ?? null : null;
  const layout =
    layoutResult.status === 'fulfilled'
      ? layoutResult.value?.layout ?? GENERIC_LAYOUT
      : GENERIC_LAYOUT;
  const layoutSource =
    layoutResult.status === 'fulfilled' ? layoutResult.value?.source ?? 'unknown' : 'fetch_error';

  // The fixed header + briefing card render first regardless of layout —
  // they're identity, not data. Sections below them come from the layout.
  const header = `
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
        ${renderLayoutSourceHint(layoutSource, layout?.layoutId)}
      </div>
    </div>

    ${renderImportanceControl(lb)}

    ${renderLifebookBriefingCard(briefing, lb.domainName)}

    ${wing ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Memory wing</span></div>
      <div class="card-subtitle">${wing.roomCount} rooms · ${wing.drawerCount}+ drawers</div>
      ${lb.wingId ? `<a href="#/provenance?wing=${encodeURIComponent(lb.wingId)}" class="btn btn-outline btn-sm" style="margin-top:0.5rem;">Open in provenance graph</a>` : ''}
    </div>
    ` : ''}
  `;

  // Adaptive sections — render in layout.order, each delegating to a
  // small section renderer keyed by `type`. Unknown types render an
  // explicit "unsupported section" card rather than failing silently,
  // so a future prompt that returns a new section type is visible to
  // the next developer who reads this page.
  const orderedSections = (Array.isArray(layout?.sections) ? layout.sections : [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const renderedSections = orderedSections
    .map((section) => renderLayoutSection(section, lb, lb.domainName))
    .join('');

  container.innerHTML = `${header}${renderedSections}`;
}

/**
 * #319 deterministic layout — same shape the server returns when the
 * LLM is unavailable / the wing is sparse / the prompt errors. Lives
 * here too so a fetch failure on the client still has a renderable
 * default and the page never blanks out.
 *
 * MUST stay in sync with two other declarations of the same shape:
 *   1. apps/api/src/routes/lifebooks.ts — `GENERIC_LAYOUT` const
 *      (the server-side fallback the layout endpoint returns).
 *   2. packages/policy-prompts/prompts/lifebook-layout/v1.md —
 *      `deterministic_fallback` field in frontmatter.
 * If you change section ordering or titles here, update both.
 */
const GENERIC_LAYOUT = {
  layoutId: 'generic-two-column',
  sections: [
    { type: 'signals', title: 'Recent Signals', order: 0 },
    { type: 'capabilities', title: 'Suggested Capabilities', order: 1 },
  ],
};

/**
 * One-liner badge under the header that explains why the user is seeing
 * a generic layout (no LLM / sparse wing) vs a domain-tuned one. Renders
 * nothing on the LLM happy path — the layout itself is the signal.
 */
function renderLayoutSourceHint(source, layoutId) {
  if (source === 'llm') return '';
  const hints = {
    no_llm_configured:
      ' · <span style="color:var(--text-muted);">generic layout (connect an AI provider for a domain-tuned one)</span>',
    sparse_fallback:
      ' · <span style="color:var(--text-muted);">generic layout (not enough signal variety yet)</span>',
    no_signals:
      ' · <span style="color:var(--text-muted);">generic layout (no signals in this wing yet)</span>',
    deterministic_fallback:
      ' · <span style="color:var(--text-muted);">generic layout (prompt fell back to deterministic)</span>',
    prompt_error:
      ' · <span style="color:var(--text-muted);">generic layout (prompt errored — see logs)</span>',
    provider_lookup_failed:
      ' · <span style="color:var(--text-muted);">generic layout (provider lookup failed — transient)</span>',
    fetch_error:
      ' · <span style="color:var(--text-muted);">generic layout (layout fetch failed)</span>',
  };
  const text = hints[source];
  if (!text) return '';
  return text + (layoutId ? ` · <code style="font-size:0.7rem;">${escapeHtml(layoutId)}</code>` : '');
}

/**
 * Dispatch a single layout section to its renderer. Section types
 * that don't have backend data yet render a placeholder card; the
 * placeholder is intentionally visible (not an empty div) so future
 * developers can see what the layout prompt asked for and wire the
 * data side incrementally.
 */
function renderLayoutSection(section, lb, domainName) {
  const title = section?.title || titleCase(section?.type || 'Section');
  switch (section?.type) {
    case 'signals': {
      const signals = Array.isArray(lb.sampleSignals) ? lb.sampleSignals : [];
      if (signals.length === 0) {
        return emptyCard(
          title,
          `No signals yet for ${escapeHtml(domainName)}. Connect a capability or wait for the next idle scan.`,
        );
      }
      return `
        <div class="card">
          <div class="card-header"><span class="card-title">${escapeHtml(title)}</span></div>
          <ul style="margin:0.5rem 0 0;padding-left:1.25rem;">
            ${signals
              .slice(0, 5)
              .map((s) => `<li style="margin-bottom:0.25rem;">${escapeHtml(s)}</li>`)
              .join('')}
          </ul>
        </div>
      `;
    }
    case 'capabilities': {
      const caps = Array.isArray(lb.suggestedCapabilities) ? lb.suggestedCapabilities : [];
      if (caps.length === 0) {
        return emptyCard(
          title,
          'No capability suggestions yet — the extractor will surface some on the next run.',
        );
      }
      return `
        <div class="card">
          <div class="card-header"><span class="card-title">${escapeHtml(title)}</span></div>
          <div class="card-subtitle">Capability categories the extractor suggests for this domain.</div>
          <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.5rem;">
            ${caps
              .map(
                (c) =>
                  `<span style="display:inline-block;padding:4px 10px;border-radius:14px;font-size:0.8rem;background:var(--bg);border:1px solid var(--border);">${escapeHtml(c)}</span>`,
              )
              .join('')}
          </div>
          <a href="#/capabilities" class="btn btn-outline btn-sm" style="margin-top:0.75rem;">Browse capabilities</a>
        </div>
      `;
    }
    case 'timeline': {
      // For now, timeline renders the same data as signals with a
      // different title — the lifebook-layout prompt can request
      // timeline ordering even before a richer chronological feed
      // backend lands. When that arrives, swap this branch for the
      // real timeline data.
      const signals = Array.isArray(lb.sampleSignals) ? lb.sampleSignals : [];
      if (signals.length === 0) {
        return emptyCard(title, 'Timeline will populate as signals land in this wing.');
      }
      return `
        <div class="card">
          <div class="card-header"><span class="card-title">${escapeHtml(title)}</span></div>
          <div class="card-subtitle">Recent events in this Lifebook's wing.</div>
          <ol style="margin:0.5rem 0 0;padding-left:1.25rem;">
            ${signals
              .slice(0, 5)
              .map((s) => `<li style="margin-bottom:0.35rem;">${escapeHtml(s)}</li>`)
              .join('')}
          </ol>
        </div>
      `;
    }
    case 'entities':
      return emptyCard(
        title,
        'Per-Lifebook entity surfacing lands with the entity-router slice. The layout prompt asked for this section; the data side is the follow-up.',
      );
    case 'decisions':
      return emptyCard(
        title,
        `<a href="#/decisions">Open the decisions surface</a> to see twin decisions tagged to this domain (per-Lifebook filtering is the follow-up).`,
      );
    case 'metrics':
      return emptyCard(
        title,
        'Per-Lifebook metrics rollup is the follow-up. The layout prompt asked for this section.',
      );
    case 'schedule':
      return emptyCard(
        title,
        'Per-Lifebook upcoming-events view lands with the calendar-filter slice.',
      );
    case 'inline_edit':
      return renderInlineEditCard(title, lb, domainName);
    default:
      // Forward-compatible default. Surfaces unknown types loudly so
      // they're visible to the next developer rather than silently
      // dropped (which would let a prompt-output drift go unnoticed).
      return emptyCard(
        title,
        `Unsupported section type <code>${escapeHtml(String(section?.type ?? 'unknown'))}</code> — frontend needs an update.`,
      );
  }
}

/**
 * #319: inline fact-edit section. Renders each extracted fact
 * (`sampleSignals`) with an Edit affordance. Clicking Edit reveals an
 * inline input (toggled by the delegated handler via the `hidden`
 * attribute — no inline onclick); Save PATCHes the fact and records a
 * user-authored provenance correction server-side.
 *
 * Every row carries `data-fact-index` so the delegated handler knows
 * which fact to PATCH without closing over per-render state.
 */
function renderInlineEditCard(title, lb, domainName) {
  const signals = Array.isArray(lb.sampleSignals) ? lb.sampleSignals : [];
  if (signals.length === 0) {
    return emptyCard(
      title,
      `Nothing extracted for ${escapeHtml(domainName)} yet — once the twin reads signals into this Lifebook, you'll be able to correct anything it gets wrong here.`,
    );
  }
  const rows = signals
    .map((s, i) => {
      const safe = escapeHtml(s);
      return `
        <li data-fact-index="${i}" style="margin-bottom:0.6rem;list-style:none;">
          <div data-fact-display="${i}" style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;">
            <span style="flex:1;">${safe}</span>
            <button class="btn btn-outline btn-sm" data-action="edit-fact" data-fact-index="${i}">Edit</button>
          </div>
          <div data-fact-editor="${i}" hidden style="margin-top:0.4rem;display:flex;gap:0.4rem;align-items:center;">
            <input type="text" data-fact-input="${i}" value="${safe}" maxlength="2000"
              style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;" />
            <button class="btn btn-primary btn-sm" data-action="save-fact" data-fact-index="${i}">Save</button>
            <button class="btn btn-outline btn-sm" data-action="cancel-fact" data-fact-index="${i}">Cancel</button>
          </div>
        </li>
      `;
    })
    .join('');
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">${escapeHtml(title)}</span></div>
      <div class="card-subtitle">Wrong date, misread name? Fix any extracted fact — your correction is recorded.</div>
      <ul style="margin:0.6rem 0 0;padding-left:0;">${rows}</ul>
    </div>
  `;
}

function emptyCard(title, htmlBody) {
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">${escapeHtml(title)}</span></div>
      <div class="card-subtitle">${htmlBody}</div>
    </div>
  `;
}

function titleCase(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

/**
 * #193 follow-up: render the per-Lifebook briefing card. Three states:
 *   1. briefing exists: show the prose + the generation timestamp.
 *   2. no briefing yet: friendly empty state explaining when one
 *      shows up (weekly worker run after at least one event in the
 *      domain's window).
 *   3. briefing was returned but has empty prose: defensive — render
 *      the empty state, same as case 2.
 *
 * The prose is server-side Markdown but the dashboard doesn't bundle
 * a Markdown renderer; we render the raw text inside a <pre>-style
 * block that preserves line breaks. A future enhancement could wire
 * up a Markdown renderer for the whole twin-briefings surface.
 */
function renderLifebookBriefingCard(briefing, domainName) {
  if (briefing && typeof briefing.prose_markdown === 'string' && briefing.prose_markdown.trim().length > 0) {
    const when = briefing.generated_at ? formatDate(briefing.generated_at) : 'recently';
    const cadenceLabel = briefing.cadence === 'weekly' ? 'Weekly' : 'Daily';
    return `
      <div class="card">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;">
          <span class="card-title">${escapeHtml(cadenceLabel)} briefing — ${escapeHtml(domainName)}</span>
          <span class="card-subtitle" style="margin:0;font-size:0.75rem;">Generated ${escapeHtml(when)}</span>
        </div>
        <div style="margin-top:0.75rem;white-space:pre-wrap;line-height:1.55;font-size:0.9rem;color:var(--text);">${escapeHtml(briefing.prose_markdown)}</div>
      </div>
    `;
  }
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">${escapeHtml(domainName)} briefing</span></div>
      <div class="card-subtitle">
        Your twin will write a per-${escapeHtml(domainName)} briefing on the next briefing run if
        there's been activity in this Lifebook. Until then you'll see the global briefing on the dashboard.
      </div>
    </div>
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
    // Hash-gated singleton (per CLAUDE.md): the SPA reuses one
    // #page-content container across routes, so gate on the hash, not
    // on DOM containment, and wire exactly once on `document`.
    if ((window.location.hash || '').split('?')[0].indexOf('#/lifebook/') !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    // #319 inline fact-edit affordances (edit/save/cancel). Read userId +
    // domain inside the handler (not closed over) so a dev "Switch user"
    // doesn't leave stale-id listeners firing under the next user.
    const factBtn = target.closest(
      '[data-action="edit-fact"],[data-action="save-fact"],[data-action="cancel-fact"]',
    );
    if (factBtn) {
      await handleFactAction(factBtn);
      return;
    }

    const hideBtn = target.closest('[data-action="hide-lifebook"]');
    if (hideBtn) {
      const domain = hideBtn.getAttribute('data-domain');
      if (!domain) return;
      if (!confirm(`Hide ${domain} from dashboards? Your memories stay; only the surface visibility changes.`)) return;
      try {
        await hideLifebook(getCurrentUserId(), domain);
        showSavedToast(`${domain} hidden`);
        window.location.hash = '#/';
      } catch (err) {
        showErrorToast(`Couldn't hide: ${err?.message ?? 'unknown error'}`);
      }
      return;
    }

    // #321 promote/demote.
    const setBtn = target.closest('[data-action="set-importance"]');
    if (setBtn) {
      if (setBtn.hasAttribute('disabled')) return; // current tier — no-op
      const domain = setBtn.getAttribute('data-domain');
      const value = setBtn.getAttribute('data-importance');
      if (!domain || !value) return;
      await applyImportanceChange(setBtn, () =>
        setLifebookImportance(getCurrentUserId(), domain, value),
        `${domain} set to ${IMPORTANCE_LABELS[value] ?? value}`,
      );
      return;
    }

    // #321 clear override — hand importance back to the extractor.
    const clearBtn = target.closest('[data-action="clear-importance"]');
    if (clearBtn) {
      const domain = clearBtn.getAttribute('data-domain');
      if (!domain) return;
      await applyImportanceChange(clearBtn, () =>
        clearLifebookImportance(getCurrentUserId(), domain),
        `${domain} importance handed back to your twin`,
      );
      return;
    }
  });
}

/**
 * Shared apply-and-rerender helper for the #321 promote/demote/clear
 * buttons. Disables the clicked button while the request is in flight
 * (so a double-click can't fire two overlapping writes), shows a toast,
 * and re-renders the detail page in place so the badge + "set by you"
 * line reflect the new state. Errors surface via the toast and the
 * page is re-rendered to restore the pre-click control state.
 */
async function applyImportanceChange(btn, apiCall, successMessage) {
  const wasDisabled = btn.hasAttribute('disabled');
  btn.setAttribute('disabled', 'true');
  try {
    await apiCall();
    showSavedToast(successMessage);
  } catch (err) {
    showErrorToast(`Couldn't update importance: ${err?.friendlyMessage ?? err?.message ?? 'unknown error'}`);
  } finally {
    if (!wasDisabled) btn.removeAttribute('disabled');
    // Re-render in place so the active tier + override line update.
    // _lifebookContainer is set on every renderLifebook call.
    if (_lifebookContainer) {
      try {
        await renderLifebook(_lifebookContainer);
      } catch {
        /* re-render is best-effort; the toast already reported success/failure */
      }
    }
  }
}

/**
 * #319: dispatch the three inline fact-edit actions. Edit/Cancel only
 * toggle the row's display vs editor blocks (no network). Save PATCHes
 * the corrected fact and re-renders the page so the new value + any
 * server-side normalization (trim/cap) is reflected.
 */
async function handleFactAction(btn) {
  const action = btn.getAttribute('data-action');
  const index = btn.getAttribute('data-fact-index');
  if (index === null) return;
  const li = btn.closest('[data-fact-index]');
  if (!li) return;
  const display = li.querySelector(`[data-fact-display="${index}"]`);
  const editor = li.querySelector(`[data-fact-editor="${index}"]`);
  const input = li.querySelector(`[data-fact-input="${index}"]`);

  if (action === 'edit-fact') {
    if (display) display.setAttribute('hidden', '');
    if (editor) editor.removeAttribute('hidden');
    if (input instanceof HTMLInputElement) input.focus();
    return;
  }
  if (action === 'cancel-fact') {
    if (editor) editor.setAttribute('hidden', '');
    if (display) display.removeAttribute('hidden');
    return;
  }
  if (action === 'save-fact') {
    if (!(input instanceof HTMLInputElement)) return;
    const text = input.value.trim();
    if (text.length === 0) {
      showErrorToast('Fact text cannot be empty.');
      return;
    }
    const domain = parseLifebookRoute();
    const userId = getCurrentUserId();
    if (!domain || !userId) {
      showErrorToast('Could not determine which Lifebook to edit.');
      return;
    }
    try {
      await editLifebookFact(userId, domain, index, text);
      showSavedToast('Fact corrected');
      // Re-render so the corrected value shows everywhere it appears
      // (signals, timeline, inline-edit) from a single source of truth.
      const container = document.getElementById('page-content');
      if (container) await renderLifebook(container);
    } catch (err) {
      showErrorToast(`Couldn't save: ${err?.message ?? 'unknown error'}`);
    }
  }
}
