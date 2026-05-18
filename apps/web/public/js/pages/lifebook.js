import {
  fetchLifebook,
  fetchLifebookBriefing,
  fetchLifebookLayout,
  hideLifebook,
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
      return emptyCard(
        title,
        'Inline fact-edit is the follow-up to this PR. The layout prompt is forward-compatible with it.',
      );
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
