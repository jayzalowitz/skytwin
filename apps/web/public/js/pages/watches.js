import {
  parseWatchText,
  fetchWatches,
  createWatch,
  updateWatchStatus,
  updateWatchSpec,
  deleteWatch,
  fetchWatchRuns,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

let _listenerWired = false;
let _container = null;
let _state = {
  userId: '',
  watches: [],
  draftText: '',
  preview: null,
  previewError: '',
  warning: '',
  editingWatchId: null,
  selectedWatchId: null,
  runsByWatchId: new Map(),
  runsLoadingId: null,
};

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || _state.userId || '';
}

function isOnWatchesRoute() {
  return (window.location.hash || '').split('?')[0] === '#/watches';
}

function ensureListener() {
  if (_listenerWired || typeof document === 'undefined') return;
  _listenerWired = true;

  document.addEventListener('submit', (e) => {
    if (!isOnWatchesRoute()) return;
    const form = e.target instanceof Element ? e.target.closest('[data-action="watch-preview-form"]') : null;
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('[data-region="watch-input"]');
    const text = input && 'value' in input ? String(input.value).trim() : '';
    void handlePreview(text);
  });

  document.addEventListener('input', (e) => {
    if (!isOnWatchesRoute()) return;
    const input = e.target instanceof Element ? e.target : null;
    if (!input || input.getAttribute('data-region') !== 'watch-input') return;
    _state.draftText = 'value' in input ? String(input.value) : '';
    _state.preview = null;
    _state.previewError = '';
    _state.warning = '';
  });

  document.addEventListener('click', (e) => {
    if (!isOnWatchesRoute()) return;
    const target = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'watch-create-active' || action === 'watch-create-draft') {
      void handleSave(action === 'watch-create-active' ? 'active' : 'draft');
    } else if (action === 'watch-status') {
      const id = target.getAttribute('data-watch-id');
      const status = target.getAttribute('data-status');
      if (id && status) void handleStatus(id, status);
    } else if (action === 'watch-delete') {
      const id = target.getAttribute('data-watch-id');
      if (id) void handleDelete(id);
    } else if (action === 'watch-runs') {
      const id = target.getAttribute('data-watch-id');
      if (id) void handleRuns(id);
    } else if (action === 'watch-edit') {
      const id = target.getAttribute('data-watch-id');
      if (id) handleEdit(id);
    } else if (action === 'watch-cancel-edit') {
      resetComposer();
      paint();
    } else if (action === 'watch-example') {
      const text = target.getAttribute('data-text') || '';
      _state.draftText = text;
      _state.preview = null;
      _state.previewError = '';
      _state.warning = '';
      paint();
      focusComposer();
    }
  });
}

export async function renderWatches(container, userId) {
  ensureListener();
  _container = container;
  _state.userId = userId;
  container.innerHTML = `
    <div class="watches-page">
      <div class="digest-skel" aria-busy="true" aria-label="Loading watches">
        <div class="sk voice"></div>
        <div class="sk row"></div><div class="sk row"></div><div class="sk row"></div>
      </div>
    </div>
  `;

  try {
    const data = await fetchWatches(userId);
    _state.watches = Array.isArray(data?.watches) ? data.watches : [];
    paint();
  } catch (err) {
    container.innerHTML = renderApiError(err, {
      context: "Couldn't load Watches.",
      retry: () => renderWatches(container, userId),
    });
    wireApiRetry(container, () => renderWatches(container, userId));
  }
}

function paint() {
  if (!_container) return;
  const active = _state.watches.filter((w) => w.status === 'active').length;
  const paused = _state.watches.filter((w) => w.status === 'paused').length;
  const draft = _state.watches.filter((w) => w.status === 'draft').length;
  _container.innerHTML = `
    <div class="watches-page">
      <section class="watch-composer">
        <form data-action="watch-preview-form">
          <label class="watch-label" for="watch-text">${_state.editingWatchId ? 'Edit Watch' : 'New Watch'}</label>
          <textarea
            id="watch-text"
            class="watch-input"
            data-region="watch-input"
            rows="3"
            placeholder="Every morning summarize email from the finance team"
          >${escapeHtml(_state.draftText)}</textarea>
          <div class="watch-composer-actions">
            <button class="btn btn-outline btn-sm" type="submit">Preview</button>
            ${_state.editingWatchId ? '<button class="btn btn-ghost btn-sm" type="button" data-action="watch-cancel-edit">Cancel</button>' : ''}
          </div>
        </form>
        ${renderPreview()}
      </section>

      <section class="watch-summary" aria-label="Watch summary">
        <div><b>${_state.watches.length}</b><span>Total</span></div>
        <div><b>${active}</b><span>Active</span></div>
        <div><b>${paused}</b><span>Paused</span></div>
        <div><b>${draft}</b><span>Draft</span></div>
      </section>

      ${_state.watches.length ? renderWatchList() : renderEmpty()}
    </div>
  `;
}

function renderPreview() {
  if (_state.previewError) {
    return `<div class="watch-preview watch-preview-error">${escapeHtml(_state.previewError)}</div>`;
  }
  if (_state.warning) {
    return `<div class="watch-preview watch-preview-warning">${escapeHtml(_state.warning)}</div>`;
  }
  if (!_state.preview?.matched) {
    return `
      <div class="watch-examples" aria-label="Examples">
        ${[
          'Every morning summarize calendar conflicts',
          'Every weekday notify me about security email',
          'Every Friday digest email from the finance team',
        ].map((text) => `
          <button type="button" class="watch-example" data-action="watch-example" data-text="${escapeHtml(text)}">
            ${escapeHtml(text)}
          </button>
        `).join('')}
      </div>
    `;
  }
  const spec = _state.preview.spec;
  const warnings = Array.isArray(_state.preview.warnings) ? _state.preview.warnings : [];
  return `
    <div class="watch-preview">
      <div class="watch-preview-title">${escapeHtml(spec.name)}</div>
      <div class="watch-preview-meta">${escapeHtml(formatSpec(spec))}</div>
      ${warnings.length ? `<div class="watch-preview-warning">${escapeHtml(warnings.join(' '))}</div>` : ''}
      <div class="watch-preview-actions">
        ${_state.editingWatchId
          ? '<button class="btn btn-primary btn-sm" type="button" data-action="watch-create-active">Save changes</button>'
          : '<button class="btn btn-primary btn-sm" type="button" data-action="watch-create-active">Activate</button><button class="btn btn-outline btn-sm" type="button" data-action="watch-create-draft">Save draft</button>'}
      </div>
    </div>
  `;
}

function renderEmpty() {
  return `
    <section class="watch-empty">
      <p class="digest-voice">No Watches yet.</p>
      <p class="watch-muted">Create one from chat or here.</p>
    </section>
  `;
}

function renderWatchList() {
  return `
    <section class="watch-list" aria-label="Watches">
      ${_state.watches.map(renderWatch).join('')}
    </section>
  `;
}

function renderWatch(watch) {
  const selected = _state.selectedWatchId === watch.id;
  const runs = _state.runsByWatchId.get(watch.id) || [];
  const loading = _state.runsLoadingId === watch.id;
  return `
    <article class="watch-row" data-watch-id="${escapeHtml(watch.id)}">
      <div class="watch-row-main">
        <div class="watch-row-head">
          <h3>${escapeHtml(watch.name || 'Watch')}</h3>
          ${renderStatus(watch.status)}
        </div>
        <div class="watch-row-meta">${escapeHtml(formatSpec(watch))}</div>
        <div class="watch-filter">${renderFilter(watch.filter)}</div>
        <div class="watch-times">
          ${watch.lastRunAt ? `<span>Last ran ${escapeHtml(formatTime(watch.lastRunAt))}</span>` : '<span>Never run</span>'}
          ${watch.nextRunAt ? `<span>Next ${escapeHtml(formatTime(watch.nextRunAt))}</span>` : ''}
        </div>
      </div>
      <div class="watch-row-actions">
        <button class="btn btn-outline btn-sm" type="button" data-action="watch-runs" data-watch-id="${escapeHtml(watch.id)}">
          ${selected ? 'Hide runs' : 'Runs'}
        </button>
        <button class="btn btn-outline btn-sm" type="button" data-action="watch-edit" data-watch-id="${escapeHtml(watch.id)}">Edit</button>
        ${watch.status === 'active'
          ? `<button class="btn btn-outline btn-sm" type="button" data-action="watch-status" data-watch-id="${escapeHtml(watch.id)}" data-status="paused">Pause</button>`
          : `<button class="btn btn-primary btn-sm" type="button" data-action="watch-status" data-watch-id="${escapeHtml(watch.id)}" data-status="active">Resume</button>`}
        <button class="btn btn-ghost btn-sm" type="button" data-action="watch-delete" data-watch-id="${escapeHtml(watch.id)}">Delete</button>
      </div>
      ${selected ? renderRuns(runs, loading) : ''}
    </article>
  `;
}

function renderRuns(runs, loading) {
  if (loading) return '<div class="watch-runs"><div class="watch-muted">Loading runs…</div></div>';
  if (!runs.length) return '<div class="watch-runs"><div class="watch-muted">No runs yet.</div></div>';
  return `
    <div class="watch-runs">
      ${runs.map((run) => `
        <div class="watch-run">
          <div class="watch-run-title">${escapeHtml(run.summary || 'Watch fired')}</div>
          <div class="watch-run-meta">
            ${escapeHtml(formatTime(run.ran_at || run.ranAt))}
            · ${escapeHtml(String(run.matched_count ?? run.matchedCount ?? 0))} match${Number(run.matched_count ?? run.matchedCount ?? 0) === 1 ? '' : 'es'}
          </div>
          ${Array.isArray(run.matched_refs) && run.matched_refs.length
            ? `<div class="watch-run-refs">${escapeHtml(run.matched_refs.slice(0, 5).join(', '))}</div>`
            : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderStatus(status) {
  const cls = status === 'active' ? 'success' : status === 'paused' ? 'muted' : 'warning';
  return `<span class="badge badge-${cls}">${escapeHtml(status || 'draft')}</span>`;
}

function renderFilter(filter) {
  const parts = [];
  const f = filter && typeof filter === 'object' ? filter : {};
  for (const key of ['sources', 'fromContains', 'keywords', 'domains']) {
    const values = Array.isArray(f[key]) ? f[key].filter((v) => typeof v === 'string' && v.trim()) : [];
    for (const value of values.slice(0, 4)) parts.push(`${labelFilterKey(key)}: ${value}`);
  }
  if (!parts.length) return '<span class="watch-filter-pill muted">all signals</span>';
  return parts.map((p) => `<span class="watch-filter-pill">${escapeHtml(p)}</span>`).join('');
}

function labelFilterKey(key) {
  if (key === 'fromContains') return 'from';
  if (key === 'sources') return 'source';
  if (key === 'domains') return 'domain';
  return 'keyword';
}

function formatSpec(spec) {
  const cadence = spec.cadence || 'daily';
  const action = spec.action === 'notify' ? 'notify' : 'digest';
  const day = typeof spec.dayOfWeek === 'number' ? `${dayName(spec.dayOfWeek)} ` : '';
  const hour = typeof spec.hourOfDay === 'number' ? ` at ${formatHour(spec.hourOfDay)}` : '';
  return `${action} · ${cadence}${cadence === 'weekly' ? ` · ${day.trim()}` : ''}${hour}`;
}

function dayName(n) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n] || '';
}

function formatHour(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:00 ${suffix}`;
}

function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0) {
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function resetComposer() {
  _state.draftText = '';
  _state.preview = null;
  _state.previewError = '';
  _state.warning = '';
  _state.editingWatchId = null;
}

function focusComposer() {
  const input = _container?.querySelector('[data-region="watch-input"]');
  if (input && 'focus' in input) input.focus();
}

async function handlePreview(text) {
  _state.draftText = text;
  _state.preview = null;
  _state.previewError = '';
  _state.warning = '';
  if (!text) {
    _state.previewError = 'Add a watch request first.';
    paint();
    return;
  }
  try {
    const result = await parseWatchText(text);
    if (!result?.matched) {
      _state.previewError = 'That does not look like a recurring watch.';
    } else {
      _state.preview = result;
    }
  } catch (err) {
    _state.previewError = err?.message || 'Could not preview that watch.';
  }
  paint();
}

async function handleSave(status) {
  const userId = getCurrentUserId();
  if (!_state.preview?.matched || !userId) return;
  try {
    if (_state.editingWatchId) {
      await updateWatchSpec(userId, _state.editingWatchId, _state.preview.spec, _state.draftText);
      showToast('Watch updated.', { kind: 'success' });
    } else {
      const result = await createWatch(userId, {
        spec: _state.preview.spec,
        sourceText: _state.draftText,
        status,
      });
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      showToast(warnings[0] || (status === 'active' ? 'Watch activated.' : 'Watch saved as draft.'), {
        kind: warnings.length ? 'warning' : 'success',
      });
    }
    resetComposer();
    await refresh();
  } catch (err) {
    _state.warning = err?.message || 'Could not save that watch.';
    paint();
  }
}

async function handleStatus(id, status) {
  const userId = getCurrentUserId();
  try {
    await updateWatchStatus(userId, id, status);
    showToast(status === 'active' ? 'Watch resumed.' : 'Watch paused.', { kind: 'success' });
    await refresh();
  } catch (err) {
    showToast(err?.message || 'Could not update that Watch.', { kind: 'error' });
  }
}

async function handleDelete(id) {
  const userId = getCurrentUserId();
  try {
    await deleteWatch(userId, id);
    _state.runsByWatchId.delete(id);
    if (_state.selectedWatchId === id) _state.selectedWatchId = null;
    showToast('Watch deleted.', { kind: 'success' });
    await refresh();
  } catch (err) {
    showToast(err?.message || 'Could not delete that Watch.', { kind: 'error' });
  }
}

async function handleRuns(id) {
  const userId = getCurrentUserId();
  if (_state.selectedWatchId === id) {
    _state.selectedWatchId = null;
    paint();
    return;
  }
  _state.selectedWatchId = id;
  if (!_state.runsByWatchId.has(id)) {
    _state.runsLoadingId = id;
    paint();
    try {
      const data = await fetchWatchRuns(userId, id, 10);
      _state.runsByWatchId.set(id, Array.isArray(data?.runs) ? data.runs : []);
    } catch (err) {
      showToast(err?.message || 'Could not load runs.', { kind: 'error' });
      // Do NOT cache on failure: the `!has(id)` guard above would then treat a
      // transient error as "no runs" forever (Copilot review). Leave the cache
      // empty and collapse the row so the next click re-fetches.
      _state.runsByWatchId.delete(id);
      _state.selectedWatchId = null;
    } finally {
      _state.runsLoadingId = null;
    }
  }
  paint();
}

function handleEdit(id) {
  const watch = _state.watches.find((w) => w.id === id);
  if (!watch) return;
  _state.editingWatchId = id;
  _state.draftText = watch.sourceText || watch.name || '';
  _state.preview = null;
  _state.previewError = '';
  _state.warning = '';
  paint();
  focusComposer();
}

async function refresh() {
  const userId = getCurrentUserId();
  const data = await fetchWatches(userId);
  _state.watches = Array.isArray(data?.watches) ? data.watches : [];
  paint();
}
