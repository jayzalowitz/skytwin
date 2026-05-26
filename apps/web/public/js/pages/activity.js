/**
 * Activity tab — unified signal/decision/feedback timeline (#391 UI slice).
 *
 * Backed by `GET /api/activity/:userId?hours=24` (see
 * `apps/api/src/routes/activity.ts`). The endpoint returns
 * newest-first events; this page preserves that reverse-chronological
 * order and renders each row with a kind/domain pill plus a drill-
 * down link to the ExplanationRecord on decision + feedback rows.
 *
 * Time-range filter lives in the URL hash (`#/activity?hours=24`)
 * so a back-button or bookmarked link round-trips the user's
 * selection.
 *
 * No inline event handlers — every interactive element uses
 * `data-action` + the singleton document-level delegator below,
 * matching the convention from CLAUDE.md.
 */

import { fetchJSON, escapeHtml, renderApiError, wireApiRetry } from '../api-client.js';
import { KEY_USER_ID } from '../storage-keys.js';

const API = '/api';

const RANGES = [
  { value: 1, label: 'Last hour' },
  { value: 24, label: 'Last 24h' },
  { value: 168, label: 'Last 7d' },
  { value: 720, label: 'Last 30d' },
];

let _activityListenerWired = false;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function getCurrentHash() {
  return (window.location.hash || '').split('?')[0];
}

function getQueryHours() {
  const qs = (window.location.hash || '').split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const raw = parseInt(params.get('hours') || '', 10);
  if (!Number.isFinite(raw)) return 24;
  return RANGES.some((r) => r.value === raw) ? raw : 24;
}

function kindBadgeClass(kind) {
  if (kind === 'decision') return 'badge-success';
  if (kind === 'feedback') return 'badge-warning';
  return 'badge-muted';
}

function kindLabel(kind) {
  if (kind === 'signal') return 'Signal';
  if (kind === 'decision') return 'Decision';
  if (kind === 'feedback') return 'Feedback';
  return kind;
}

function formatRelative(iso) {
  const now = Date.now();
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diffMs = Math.max(0, now - then);
  // Floor (not round) every unit conversion so we never display a
  // time that hasn't actually elapsed yet. Math.round would render
  // "1h ago" at the 31-minute mark, which contradicts the timestamp
  // a user can verify themselves by clicking through to the source.
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function ensureActivityListener() {
  if (_activityListenerWired || typeof document === 'undefined') return;
  _activityListenerWired = true;

  // Hash-gated singleton — the SPA reuses one #page-content container
  // across all routes, so an unguarded listener would fire on every
  // page. CLAUDE.md "Frontend Event Handling" pattern.
  document.addEventListener('click', (e) => {
    if (getCurrentHash() !== '#/activity') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const btn = target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'activity-range') {
      const hours = parseInt(btn.getAttribute('data-hours') || '', 10);
      if (Number.isFinite(hours)) {
        window.location.hash = `#/activity?hours=${hours}`;
      }
    }
  });
}

function renderRangeChips(currentHours) {
  // Toggle-button group rather than tabs: each chip is a button with
  // `aria-pressed`, the container is grouped semantically via
  // `role="group"` + an `aria-label`. We deliberately don't use
  // `role="tablist"` here — that contract requires `role="tab"`
  // children with `aria-selected` and arrow-key navigation managed
  // by the page, neither of which we implement (these are plain
  // toggle buttons that re-route via the hash).
  return `
    <div class="activity-range" role="group" aria-label="Activity time range" style="display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 1rem;">
      ${RANGES.map((r) => {
        const active = r.value === currentHours;
        return `
          <button type="button"
                  class="btn ${active ? 'btn-primary' : 'btn-outline'} btn-sm"
                  data-action="activity-range"
                  data-hours="${r.value}"
                  aria-pressed="${active ? 'true' : 'false'}">
            ${escapeHtml(r.label)}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderEvent(ev) {
  const drillHref = ev.decisionId ? `#/decisions?focus=${encodeURIComponent(ev.decisionId)}` : '';
  const drillLink = drillHref
    ? `<a href="${escapeHtml(drillHref)}" style="margin-left: 0.5rem; font-size: 0.78rem;">Explain →</a>`
    : '';
  return `
    <div class="activity-item card" style="display: flex; flex-direction: column; gap: 0.35rem; padding: 0.75rem 1rem; margin-bottom: 0.5rem;">
      <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
        <span class="badge ${kindBadgeClass(ev.kind)}">${escapeHtml(kindLabel(ev.kind))}</span>
        ${ev.domain ? `<span class="badge badge-info" style="font-size: 0.72rem;">${escapeHtml(ev.domain)}</span>` : ''}
        <span style="color: var(--text-muted); font-size: 0.78rem;">${escapeHtml(formatRelative(ev.at))}</span>
        ${drillLink}
      </div>
      <div style="font-size: 0.9rem; line-height: 1.45;">${escapeHtml(ev.summary || '')}</div>
    </div>
  `;
}

export async function renderActivity(container, userId) {
  ensureActivityListener();
  const uid = userId || getCurrentUserId();
  const hours = getQueryHours();

  if (!uid) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">Activity</span></div>
        <div class="card-subtitle">Sign in to see what your twin has been up to.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="card" style="margin-bottom: 1rem;">
      <div class="card-header">
        <span class="card-title">What's been happening</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Every signal that came in, every decision your twin made, and every yes/no you gave it — newest first.
      </div>
      ${renderRangeChips(hours)}
    </div>
    <div id="activity-list">
      <div style="color: var(--text-muted); font-size: 0.85rem;">Loading activity…</div>
    </div>
  `;

  const list = document.getElementById('activity-list');
  try {
    const res = await fetchJSON(
      `${API}/activity/${encodeURIComponent(uid)}?hours=${hours}`,
    );
    const events = Array.isArray(res?.events) ? res.events : [];
    if (events.length === 0) {
      list.innerHTML = `
        <div class="card" style="text-align: center; padding: 1.5rem;">
          <div style="font-size: 0.9rem; color: var(--text-muted);">
            Nothing in the last ${escapeHtml(String(hours))} hour${hours === 1 ? '' : 's'}.
            ${hours < 720
              ? `Try a longer window above.`
              : `Your twin's been on standby — connect a service from <a href="#/setup">Setup</a> to get going.`}
          </div>
        </div>
      `;
      return;
    }
    list.innerHTML = events.map(renderEvent).join('');
  } catch (err) {
    list.innerHTML = renderApiError(err, {
      context: "Couldn't load your activity.",
      retry: () => renderActivity(container, uid),
    });
    wireApiRetry(list, () => renderActivity(container, uid));
  }
}
