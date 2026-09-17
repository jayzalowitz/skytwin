import {
  parseWatchText,
  fetchWatches,
  createWatch,
  updateWatchStatus,
  updateWatchSpec,
  deleteWatch,
  fetchWatchRuns,
  fetchAdaptiveWorkflowReadiness,
  createAdaptiveSignalDigestDraft,
  fetchAdaptiveWorkflowDetail,
  fetchAdaptiveWorkflowResumableDraft,
  createAdaptiveWorkflowFeedbackRevision,
  activateAdaptiveWorkflow,
  rollbackAdaptiveWorkflow,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { showToast } from '../toast.js';
import { getEffectiveUserId } from '../sample-session.js';
import { adaptiveWatchDraftKey, adaptiveWatchEditKey } from '../storage-keys.js';

let _listenerWired = false;
let _container = null;
let _renderGeneration = 0;
let _interactionRevision = 0;
const _readinessCache = new Map();
const READINESS_CACHE_MS = 5 * 60 * 1000;
let _state = {
  userId: '',
  watches: [],
  draftText: '',
  preview: null,
  previewError: '',
  clarificationQuestion: '',
  warning: '',
  readiness: { state: 'loading' },
  adaptiveCandidate: null,
  adaptiveEdit: null,
  clarificationCount: 0,
  busy: '',
  editingWatchId: null,
  selectedWatchId: null,
  runsByWatchId: new Map(),
  runsLoadingId: null,
  history: { workflowId: null, detail: null, loading: false, error: '' },
  rollbackConfirmation: null,
  rollbackError: '',
  deleteConfirmation: null,
  deleteError: '',
};

function getCurrentUserId() {
  return getEffectiveUserId() || _state.userId || '';
}

function isOnWatchesRoute() {
  return (window.location.hash || '').split('?')[0] === '#/watches';
}

function captureOperation(userId = getCurrentUserId(), includeInteraction = false) {
  return {
    generation: _renderGeneration,
    userId,
    interactionRevision: includeInteraction ? _interactionRevision : null,
  };
}

function isOperationCurrent(operation) {
  return Boolean(operation?.userId)
    && operation.generation === _renderGeneration
    && operation.userId === _state.userId
    && operation.userId === getCurrentUserId()
    && (operation.interactionRevision === null
      || operation.interactionRevision === _interactionRevision)
    && isOnWatchesRoute();
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
    _interactionRevision += 1;
    _state.preview = null;
    _state.adaptiveCandidate = null;
    _state.previewError = '';
    _state.clarificationQuestion = '';
    _state.warning = '';
    persistComposerDraft(getCurrentUserId(), _state.draftText);
  });

  document.addEventListener('click', (e) => {
    if (!isOnWatchesRoute()) return;
    const target = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'watch-create-active' || action === 'watch-create-draft') {
      void handleSave(action === 'watch-create-active' ? 'active' : 'draft');
    } else if (action === 'adaptive-activate') {
      void handleAdaptiveActivate();
    } else if (action === 'adaptive-readiness-retry') {
      void refreshReadiness(captureOperation(), true);
    } else if (action === 'watch-status') {
      const id = target.getAttribute('data-watch-id');
      const status = target.getAttribute('data-status');
      if (id && status) void handleStatus(id, status);
    } else if (action === 'watch-delete') {
      const id = target.getAttribute('data-watch-id');
      if (id) handleDeleteReview(id);
    } else if (action === 'watch-delete-cancel') {
      handleDeleteCancel();
    } else if (action === 'watch-delete-confirm') {
      void handleDeleteConfirm();
    } else if (action === 'watch-runs') {
      const id = target.getAttribute('data-watch-id');
      if (id) void handleRuns(id);
    } else if (action === 'watch-history') {
      const workflowId = target.getAttribute('data-workflow-id');
      if (workflowId) void handleHistory(workflowId);
    } else if (action === 'watch-history-retry') {
      const workflowId = target.getAttribute('data-workflow-id');
      if (workflowId) void loadWorkflowHistory(workflowId);
    } else if (action === 'watch-rollback-review') {
      const workflowId = target.getAttribute('data-workflow-id');
      const versionId = target.getAttribute('data-version-id');
      if (workflowId && versionId) handleRollbackReview(workflowId, versionId);
    } else if (action === 'watch-rollback-cancel') {
      const versionId = _state.rollbackConfirmation?.versionId ?? null;
      _state.rollbackConfirmation = null;
      _state.rollbackError = '';
      paint();
      if (versionId) focusActionIdentity('watch-rollback-review', 'data-version-id', versionId);
    } else if (action === 'watch-rollback-confirm') {
      void handleRollbackConfirm();
    } else if (action === 'watch-edit') {
      const id = target.getAttribute('data-watch-id');
      if (id) void handleEdit(id);
    } else if (action === 'watch-cancel-edit') {
      resetComposer({ preservePrimaryDraft: Boolean(_state.adaptiveEdit) });
      paint();
      focusComposer();
    } else if (action === 'watch-example') {
      const text = target.getAttribute('data-text') || '';
      _state.draftText = text;
      _interactionRevision += 1;
      _state.preview = null;
      _state.adaptiveCandidate = null;
      _state.previewError = '';
      _state.clarificationQuestion = '';
      _state.warning = '';
      persistComposerDraft(getCurrentUserId(), text);
      paint();
      focusComposer();
    }
  });
}

export async function renderWatches(container, userId) {
  const generation = ++_renderGeneration;
  const isCurrentRender = () =>
    generation === _renderGeneration && _state.userId === userId && isOnWatchesRoute();
  ensureListener();
  _container = container;
  const userChanged = _state.userId !== userId;
  _state.userId = userId;
  if (userChanged) {
    const storedEdit = readAdaptiveEdit(userId);
    _state.draftText = storedEdit?.feedback ?? readDraft(userId);
    _state.preview = null;
    _state.adaptiveCandidate = null;
    _state.clarificationQuestion = '';
    _state.adaptiveEdit = storedEdit ? {
      workflowId: storedEdit.workflowId,
      parentVersionId: storedEdit.parentVersionId,
      basePayload: storedEdit.basePayload,
    } : null;
    _state.editingWatchId = null;
    _state.busy = '';
    _state.selectedWatchId = null;
    _state.runsByWatchId = new Map();
    _state.runsLoadingId = null;
    _state.history = { workflowId: null, detail: null, loading: false, error: '' };
    _state.rollbackConfirmation = null;
    _state.rollbackError = '';
    _state.deleteConfirmation = null;
    _state.deleteError = '';
    _interactionRevision += 1;
  }
  // A route re-entry invalidates every earlier generation. Do not carry an
  // abandoned request's transient disabled state into the new render.
  _state.busy = '';
  _state.readiness = { state: 'loading' };
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
    if (!isCurrentRender()) return;
    _state.watches = Array.isArray(data?.watches) ? data.watches : [];
    paint();
    await Promise.all([
      refreshReadiness(captureOperation(userId)),
      resumeAdaptiveCandidate(captureOperation(userId, true)),
    ]);
  } catch (err) {
    if (!isCurrentRender()) return;
    container.innerHTML = `<div role="alert">${renderApiError(err, {
      context: "Couldn't load Watches.",
      retry: () => renderWatches(container, userId),
    })}</div>`;
    wireApiRetry(container, () => renderWatches(container, userId));
  }
}

function focusNode(node) {
  if (!node || typeof node.focus !== 'function') return;
  try { node.focus({ preventScroll: true }); }
  catch { node.focus(); }
}

function focusActionIdentity(action, attribute, value) {
  if (!_container) return;
  const node = [..._container.querySelectorAll(`[data-action="${action}"]`)]
    .find((candidate) => candidate.getAttribute(attribute) === value);
  focusNode(node);
}

function paint({ focusSelector = '' } = {}) {
  if (!_container || !isOnWatchesRoute()) return;
  const active = _state.watches.filter((w) => w.status === 'active').length;
  const paused = _state.watches.filter((w) => w.status === 'paused').length;
  const draft = _state.watches.filter((w) => w.status === 'draft').length;
  _container.innerHTML = `
    <div class="watches-page">
      <section class="watch-composer">
        <div class="watch-composer-intro">
          <div>
            <h2>${_state.adaptiveEdit ? 'Propose a new version' : 'Teach SkyTwin one thing to watch'}</h2>
            <p>${composerDescription()}</p>
          </div>
          ${renderReadinessBadge()}
        </div>
        ${renderReadinessNotice()}
        <form data-action="watch-preview-form">
          <label class="watch-label" for="watch-text">${composerLabel()}</label>
          <textarea
            id="watch-text"
            class="watch-input"
            data-region="watch-input"
            rows="3"
            placeholder="Every morning summarize email from the finance team"
            ${composerDisabled() ? 'disabled' : ''}
          >${escapeHtml(_state.draftText)}</textarea>
          <div class="watch-composer-actions">
            <button class="btn btn-outline btn-sm" type="submit" ${composerDisabled() ? 'disabled' : ''}>
              ${escapeHtml(composerButtonLabel())}
            </button>
            ${_state.editingWatchId || _state.adaptiveEdit ? '<button class="btn btn-ghost btn-sm" type="button" data-action="watch-cancel-edit">Cancel</button>' : ''}
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
  if (focusSelector) focusNode(_container.querySelector(focusSelector));
}

function composerDescription() {
  if (_state.adaptiveEdit) {
    return 'Review the changed schedule and matching scope before activating a new immutable version.';
  }
  if (_state.readiness.state === 'setup_required') {
    return 'No model is configured. You can still create a clearly labeled deterministic Watch.';
  }
  return 'Describe a recurring signal digest. SkyTwin will translate it locally when available, then replay it against recent evidence.';
}

function composerLabel() {
  if (_state.adaptiveEdit) return 'Describe the updated Watch';
  if (_state.editingWatchId) return 'Edit deterministic Watch';
  if (_state.readiness.state === 'setup_required') return 'Deterministic Watch fallback';
  return 'What should SkyTwin keep an eye on?';
}

function composerDisabled() {
  if (_state.busy) return true;
  if (_state.adaptiveEdit) return false;
  return _state.readiness.state !== 'ready' && _state.readiness.state !== 'setup_required';
}

function composerButtonLabel() {
  if (_state.busy === 'authoring') return 'Preparing preview…';
  if (_state.busy === 'editing') return 'Loading version…';
  if (_state.adaptiveEdit) return 'Review new version';
  if (_state.editingWatchId) return 'Preview changes';
  if (_state.readiness.state === 'setup_required') return 'Preview deterministic Watch';
  return 'Preview with AI';
}

function readinessLabel(state) {
  const labels = {
    loading: 'Checking model',
    ready: 'AI ready',
    setup_required: 'Model not configured',
    confirmation_required: 'Confirmation needed',
    policy_blocked: 'Blocked by policy',
    artifact_unavailable: 'Model artifact unavailable',
    runtime_unavailable: 'Runtime unavailable',
    temporarily_unavailable: 'Temporarily unavailable',
    unsupported_model: 'Model unsupported',
    load_error: 'Readiness unavailable',
  };
  return labels[state] || 'AI unavailable';
}

function renderReadinessBadge() {
  const state = _state.readiness.state;
  const tone = state === 'ready' ? 'safe' : state === 'loading' ? 'muted' : 'warning';
  return `<span class="watch-readiness watch-readiness-${tone}">${escapeHtml(readinessLabel(state))}</span>`;
}

function renderReadinessNotice() {
  const readiness = _state.readiness;
  if (readiness.state === 'loading') {
    return '<div class="watch-readiness-note" data-region="watch-readiness-status" tabindex="-1" aria-live="polite">Checking the configured model with a structured test…</div>';
  }
  if (readiness.state === 'ready') {
    const location = readiness.reasoningMode === 'on_device' ? 'On-device' : 'Configured';
    return `<div class="watch-readiness-note" data-region="watch-readiness-status" tabindex="-1">${escapeHtml(location)} model · ${escapeHtml(readiness.provider)} / ${escapeHtml(readiness.model)}</div>`;
  }
  if (readiness.state === 'setup_required') {
    return `
      <div class="watch-readiness-note watch-readiness-setup" data-region="watch-readiness-status" tabindex="-1">
        <span>AI authoring needs a configured model. The fallback below uses fixed parsing and is not AI-authored.</span>
        <a class="btn btn-outline btn-sm watch-setup-link" href="#/settings">Set up a model</a>
        <button class="btn btn-outline btn-sm" type="button" data-action="adaptive-readiness-retry">Check again</button>
      </div>
    `;
  }
  const copy = {
    confirmation_required: 'Confirm the configured provider in Settings before authoring.',
    policy_blocked: 'Your current privacy policy does not allow this authoring mode.',
    artifact_unavailable: 'The managed local model artifact is missing or failed verification. Your draft is saved.',
    runtime_unavailable: 'The model is configured but its runtime is not ready. Your draft is saved.',
    temporarily_unavailable: 'The model could not complete the readiness check. Your draft is saved.',
    unsupported_model: 'This model did not produce the required safe workflow shape.',
    load_error: 'SkyTwin could not check authoring readiness. Your draft is saved.',
  }[readiness.state] || 'AI authoring is unavailable. Your draft is saved.';
  return `
    <div class="watch-readiness-note watch-readiness-blocked" data-region="watch-readiness-status" tabindex="-1" role="status">
      <span>${escapeHtml(copy)}</span>
      ${readiness.retryable ? '<button class="btn btn-outline btn-sm" type="button" data-action="adaptive-readiness-retry">Retry</button>' : '<a class="btn btn-outline btn-sm watch-setup-link" href="#/settings">Open settings</a>'}
    </div>
  `;
}

function renderAdaptiveCandidate(candidate) {
  const preview = candidate.preview || {};
  const spec = preview.routineSpec || candidate.version?.canonicalPayload || {};
  const replay = preview.replay || {};
  const simulation = replay.simulation;
  const examples = Array.isArray(simulation?.examples) ? simulation.examples.slice(0, 3) : [];
  const dataAccess = replay.dataAccess || {};
  const synthesis = replay.synthesis || { available: false, text: 'AI summary unavailable' };
  const timezone = replay.schedule?.timezone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'local time';
  const nextRun = replay.schedule?.nextRunAt
    ? ` · Next ${formatTime(replay.schedule.nextRunAt)}`
    : '';
  const comparison = candidate.comparison;
  const recordsEvaluated = Number(dataAccess.recordsEvaluated ?? 0);
  const recordsFound = Number(dataAccess.recordsFound ?? recordsEvaluated);
  const replayCoverage = dataAccess.truncated
    ? `Newest ${recordsEvaluated.toLocaleString()} of ${recordsFound.toLocaleString()} signals evaluated`
    : `${recordsEvaluated.toLocaleString()} real signal${recordsEvaluated === 1 ? '' : 's'} evaluated`;
  return `
    <section class="watch-preview watch-adaptive-preview" data-region="watch-preview-result"
      tabindex="-1" aria-label="Adaptive Watch preview">
      <div class="watch-preview-state" role="status" aria-live="polite">Proposed version ${escapeHtml(candidate.version?.versionNumber ?? 1)} · Not active</div>
      <div class="watch-preview-title">${escapeHtml(spec.name || 'Signal digest')}</div>
      <div class="watch-preview-meta">${escapeHtml(formatSpec(spec))} · ${escapeHtml(timezone)}${escapeHtml(nextRun)}</div>
      ${_state.warning ? `<div class="watch-preview-warning">${escapeHtml(_state.warning)}</div>` : ''}
      ${preview.summaryInstruction ? `<p class="watch-summary-instruction">${escapeHtml(preview.summaryInstruction)}</p>` : ''}
      ${renderAdaptiveDiff(candidate.diff)}
      <div class="watch-replay-stats" aria-label="Historical replay counts">
        <div><b>${simulation ? escapeHtml(simulation.caughtCount) : '—'}</b><span>Caught</span></div>
        <div><b>${simulation ? escapeHtml(simulation.ignoredCount) : '—'}</b><span>Ignored</span></div>
        <div><b>${escapeHtml(recordsEvaluated)}</b><span>Evaluated</span></div>
      </div>
      ${comparison ? `<div class="watch-replay-comparison">Previous version caught ${escapeHtml(comparison.beforeCaught)} · proposed version catches ${escapeHtml(comparison.afterCaught)}</div>` : ''}
      <div class="watch-replay-disclosure">
        <div><span>Data access</span><strong>${escapeHtml(dataAccess.status === 'available' ? 'Recent real signals' : 'Unavailable')}</strong></div>
        <div><span>Replay window</span><strong>${escapeHtml(formatReplayWindow(replay.window))}</strong></div>
        <div><span>Evidence</span><strong>${dataAccess.synthetic === false ? 'Real, not synthetic' : 'Unavailable'}</strong></div>
        <div><span>Coverage</span><strong>${escapeHtml(replayCoverage)}</strong></div>
      </div>
      ${replay.sourceReady === false ? `
        <div class="watch-readiness-note" role="status">
          Waiting for recent evidence from the requested source. You can review this version now, but its replay is not source-ready yet.
        </div>
      ` : ''}
      <div class="watch-replay-synthesis ${synthesis.available ? '' : 'watch-replay-synthesis-unavailable'}">
        <span>Replay summary</span>
        <p>${escapeHtml(synthesis.available ? synthesis.text : 'AI summary unavailable')}</p>
      </div>
      ${examples.length ? `
        <ol class="watch-replay-citations" aria-label="Replay citations">
          ${examples.map((example) => `
            <li>
              <div>${escapeHtml(example.title || `${example.source || 'Signal'} item`)}</div>
              <span>${escapeHtml([example.from, example.source, formatTime(example.timestamp)].filter(Boolean).join(' · '))}</span>
            </li>
          `).join('')}
        </ol>
      ` : '<p class="watch-muted watch-replay-empty">No matching examples in this replay window.</p>'}
      <div class="watch-preview-actions">
        <button class="btn btn-primary btn-sm" type="button" data-action="adaptive-activate" ${_state.busy ? 'disabled' : ''}>
          ${_state.busy === 'activating' ? 'Activating…' : `Activate version ${escapeHtml(candidate.version?.versionNumber ?? 1)}`}
        </button>
        <span class="watch-activation-note">Nothing runs until you activate this version.</span>
      </div>
    </section>
  `;
}

function renderAdaptiveDiff(diff) {
  if (!diff?.changed) return '';
  const dimensions = ['trigger', 'filter', 'dataScope', 'destination']
    .map((key) => ({ key, value: diff[key] }))
    .filter(({ value }) => value?.changed);
  if (!dimensions.length && !diff.metadataChanged && !diff.summaryInstructionChanged) return '';
  return `
    <div class="watch-version-diff">
      <span>What changed</span>
      ${dimensions.map(({ key, value }) => `
        <div>
          <strong>${escapeHtml(key === 'dataScope' ? 'Data scope' : key)}</strong>
          <span>${escapeHtml(value.classification)}</span>
          ${Array.isArray(value.reasons) && value.reasons.length ? `<small>${escapeHtml(value.reasons.join(' · '))}</small>` : ''}
        </div>
      `).join('')}
      ${diff.metadataChanged ? '<div><strong>Name</strong><span>changed</span><small>The label changed in this version.</small></div>' : ''}
      ${diff.summaryInstructionChanged ? '<div><strong>Summary</strong><span>changed</span><small>The synthesis instruction changed in this version.</small></div>' : ''}
      ${diff.authorityRelevantBroadening ? '<p class="watch-preview-warning">This version broadens what the Watch can match or surface. Review it before activation.</p>' : ''}
    </div>
  `;
}

function formatReplayWindow(window) {
  if (!window?.start || !window?.end) return 'Unavailable';
  const start = new Date(window.start);
  const end = new Date(window.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Unavailable';
  const formatter = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric' });
  return `${formatter.format(start)} to ${formatter.format(end)} · ${window.bounds || '(start, end]'}`;
}

function renderPreview() {
  if (_state.clarificationQuestion) {
    return `<div class="watch-preview watch-preview-clarification" role="status" aria-live="polite">${escapeHtml(_state.clarificationQuestion)}</div>`;
  }
  if (_state.previewError) {
    return `<div class="watch-preview watch-preview-error" role="alert">${escapeHtml(_state.previewError)}</div>`;
  }
  if (_state.adaptiveCandidate) return renderAdaptiveCandidate(_state.adaptiveCandidate);
  if (_state.warning) {
    return `<div class="watch-preview watch-preview-warning" role="alert">${escapeHtml(_state.warning)}</div>`;
  }
  if (!_state.preview?.matched) {
    if (_state.readiness.state !== 'ready' && _state.readiness.state !== 'setup_required') return '';
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
    <div class="watch-preview" role="status" aria-live="polite">
      <div class="watch-preview-title">${escapeHtml(spec.name)}</div>
      <div class="watch-preview-meta">${escapeHtml(formatSpec(spec))}</div>
      ${warnings.length ? `<div class="watch-preview-warning">${escapeHtml(warnings.join(' '))}</div>` : ''}
      <div class="watch-preview-actions">
        ${_state.editingWatchId
          ? '<button class="btn btn-outline btn-sm" type="button" data-action="watch-create-active">Save changes</button>'
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
  const quarantined = watch.workflowProviderKey === 'legacy_watch.quarantine.v1';
  const historyOpen = Boolean(
    !quarantined && watch.workflowId && _state.history.workflowId === watch.workflowId,
  );
  const deleteOpen = _state.deleteConfirmation?.watchId === watch.id;
  const runsPanelId = `watch-runs-${watch.id}`;
  const historyPanelId = watch.workflowId ? `watch-history-${watch.workflowId}` : '';
  const rollbackBusy = _state.busy === 'rolling-back';
  return `
    <article class="watch-row" data-watch-id="${escapeHtml(watch.id)}">
      <div class="watch-row-main">
        <div class="watch-row-head">
          <h3>${escapeHtml(watch.name || 'Watch')}</h3>
          ${renderStatus(watch.status)}
          ${quarantined
            ? '<span class="watch-version-label">Needs replacement</span>'
            : (watch.workflowId
              ? '<span class="watch-version-label">Versioned</span>'
              : '<span class="watch-version-label">Deterministic</span>')}
        </div>
        ${quarantined ? `
          <p class="watch-muted">
            This legacy Watch could not be safely migrated. Delete it and create a replacement.
          </p>
        ` : ''}
        <div class="watch-row-meta">${escapeHtml(formatSpec(watch))}</div>
        <div class="watch-filter">${renderFilter(watch.filter)}</div>
        <div class="watch-times">
          ${watch.lastRunAt ? `<span>Last ran ${escapeHtml(formatTime(watch.lastRunAt))}</span>` : '<span>Never run</span>'}
          ${watch.nextRunAt ? `<span>Next ${escapeHtml(formatTime(watch.nextRunAt))}</span>` : ''}
        </div>
      </div>
      <div class="watch-row-actions">
        <button class="btn btn-outline btn-sm" type="button" data-action="watch-runs" data-watch-id="${escapeHtml(watch.id)}"
          aria-expanded="${selected}" aria-controls="${escapeHtml(runsPanelId)}" ${rollbackBusy ? 'disabled' : ''}>
          ${selected ? 'Hide runs' : 'Runs'}
        </button>
        ${watch.workflowId && !quarantined ? `
          <button class="btn btn-outline btn-sm" type="button" data-action="watch-history"
            data-workflow-id="${escapeHtml(watch.workflowId)}" aria-expanded="${historyOpen}"
            aria-controls="${escapeHtml(historyPanelId)}" ${rollbackBusy ? 'disabled' : ''}>
            ${historyOpen ? 'Hide history' : 'History'}
          </button>
        ` : ''}
        ${quarantined ? '' : `
          <button class="btn btn-outline btn-sm" type="button" data-action="watch-edit" data-watch-id="${escapeHtml(watch.id)}" ${rollbackBusy ? 'disabled' : ''}>${watch.workflowId ? 'New version' : 'Edit'}</button>
          ${watch.status === 'active'
            ? `<button class="btn btn-outline btn-sm" type="button" data-action="watch-status" data-watch-id="${escapeHtml(watch.id)}" data-status="paused" ${rollbackBusy ? 'disabled' : ''}>Pause</button>`
            : `<button class="btn btn-outline btn-sm" type="button" data-action="watch-status" data-watch-id="${escapeHtml(watch.id)}" data-status="active" ${rollbackBusy ? 'disabled' : ''}>Resume</button>`}
        `}
        ${watch.workflowId && !quarantined
          ? ''
          : `<button class="btn btn-ghost btn-sm" type="button" data-action="watch-delete" data-watch-id="${escapeHtml(watch.id)}"
              aria-expanded="${deleteOpen}" aria-controls="watch-delete-${escapeHtml(watch.id)}">Delete</button>`}
      </div>
      ${deleteOpen ? renderDeleteConfirmation(watch) : ''}
      ${selected ? renderRuns(watch.id, runs, loading) : ''}
      ${historyOpen ? renderWorkflowHistory(watch.workflowId) : ''}
    </article>
  `;
}

function renderDeleteConfirmation(watch) {
  const quarantined = watch.workflowProviderKey === 'legacy_watch.quarantine.v1';
  const name = watch.name || 'this Watch';
  const consequence = quarantined
    ? 'This permanently deletes the quarantined Watch and its migration-only version lineage.'
    : 'This permanently deletes the Watch and its saved history.';
  return `
    <div class="watch-delete-confirmation" id="watch-delete-${escapeHtml(watch.id)}"
      data-region="watch-delete-confirmation" tabindex="-1" role="group"
      aria-label="Confirm Watch deletion" aria-busy="${_state.busy === 'deleting'}">
      <p><strong>Delete ${escapeHtml(name)}?</strong></p>
      <p>${escapeHtml(consequence)} This cannot be undone.</p>
      ${_state.deleteError ? `<p class="watch-delete-error" role="alert">${escapeHtml(_state.deleteError)}</p>` : ''}
      <div>
        <button class="btn btn-ghost btn-sm" type="button" data-action="watch-delete-cancel"
          ${_state.busy ? 'disabled' : ''}>Cancel</button>
        <button class="btn btn-danger btn-sm" type="button" data-action="watch-delete-confirm"
          ${_state.busy ? 'disabled' : ''}>${_state.busy === 'deleting' ? 'Deleting…' : 'Delete permanently'}</button>
      </div>
    </div>
  `;
}

function renderRuns(watchId, runs, loading) {
  const id = `watch-runs-${watchId}`;
  if (loading) return `<div class="watch-runs" id="${escapeHtml(id)}" tabindex="-1" role="region" aria-live="polite"><div class="watch-muted">Loading runs…</div></div>`;
  if (!runs.length) return `<div class="watch-runs" id="${escapeHtml(id)}" tabindex="-1" role="region"><div class="watch-muted">No runs yet.</div></div>`;
  return `
    <div class="watch-runs" id="${escapeHtml(id)}" tabindex="-1" role="region" aria-label="Recent Watch runs">
      ${runs.map((run) => {
        const matchedCount = Number(run.matched_count ?? run.matchedCount ?? 0);
        const evidence = Array.isArray(run.evidence_snapshot) ? run.evidence_snapshot : [];
        const retainedCount = Number(run.evidence_retained_count ?? matchedCount);
        const hiddenRetainedCount = Math.max(0, retainedCount - Math.min(5, evidence.length));
        const unretainedCount = run.evidence_truncated
          ? Math.max(0, matchedCount - retainedCount)
          : 0;
        const synthesis = run.synthesis_metadata;
        const synthesisLabel = synthesis?.state === 'generated'
          ? `AI summary · ${synthesis.provider} / ${synthesis.model}`
          : (synthesis?.state === 'unavailable' ? 'Deterministic fallback · AI unavailable' : '');
        const commitment = typeof run.evidence_sha256 === 'string'
          ? run.evidence_sha256.slice(0, 12)
          : '';
        return `
        <div class="watch-run">
          <div class="watch-run-title">${escapeHtml(run.summary || 'Watch fired')}</div>
          <div class="watch-run-meta">
            ${escapeHtml(formatTime(run.ran_at || run.ranAt))}
            · ${escapeHtml(String(matchedCount))} match${matchedCount === 1 ? '' : 'es'}
            ${synthesisLabel ? ` · ${escapeHtml(synthesisLabel)}` : ''}
          </div>
          ${evidence.length ? `<ul class="watch-run-evidence">
            ${evidence.slice(0, 5).map((item) => `<li>
              <span>${escapeHtml(item.title || `${item.source || 'signal'} item`)}</span>
              <small>${escapeHtml(item.signalId || '')}</small>
            </li>`).join('')}
          </ul>` : ''}
          ${hiddenRetainedCount > 0 ? `<div class="watch-muted">${escapeHtml(String(hiddenRetainedCount))} additional matching evidence item${hiddenRetainedCount === 1 ? '' : 's'} retained but not displayed.</div>` : ''}
          ${unretainedCount > 0 ? `<div class="watch-muted">${escapeHtml(String(unretainedCount))} older match${unretainedCount === 1 ? ' was' : 'es were'} counted but omitted by the evidence retention bound.</div>` : ''}
          ${commitment ? `<div class="watch-run-commitment" title="Retained evidence SHA-256">Evidence ${escapeHtml(commitment)}…</div>` : ''}
          ${Array.isArray(run.matched_refs) && run.matched_refs.length
            && evidence.length === 0
            ? `<div class="watch-run-refs">${escapeHtml(run.matched_refs.slice(0, 5).join(', '))}</div>`
            : ''}
        </div>
      `; }).join('')}
    </div>
  `;
}

function renderWorkflowHistory(workflowId) {
  const history = _state.history;
  const panelAttributes = `id="watch-history-${escapeHtml(workflowId)}" data-region="watch-history" tabindex="-1"`;
  if (history.loading) {
    return `<section class="watch-history" ${panelAttributes} aria-live="polite"><p class="watch-muted">Loading immutable history…</p></section>`;
  }
  if (history.error) {
    return `
      <section class="watch-history" ${panelAttributes} aria-live="polite">
        <p class="watch-history-error">${escapeHtml(history.error)}</p>
        <button class="btn btn-outline btn-sm" type="button" data-action="watch-history-retry"
          data-workflow-id="${escapeHtml(workflowId)}">Retry</button>
      </section>
    `;
  }
  const detail = history.detail;
  const versions = Array.isArray(detail?.versions)
    ? [...detail.versions].sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber))
    : [];
  if (!versions.length) {
    return `<section class="watch-history" ${panelAttributes}><p class="watch-muted">No version history is available.</p></section>`;
  }
  const activeVersionId = detail?.workflow?.activeVersionId ?? detail?.activeVersion?.id ?? null;
  const activationEvents = Array.isArray(detail?.activationEvents) ? detail.activationEvents : [];
  const previouslyActive = new Set(activationEvents.map((event) => event.activatedVersionId));
  return `
    <section class="watch-history" ${panelAttributes} aria-label="Immutable version history">
      <div class="watch-history-head">
        <div>
          <h4>Version history</h4>
          <p>Versions stay immutable. A rollback records a new activation event.</p>
        </div>
      </div>
      ${_state.rollbackError ? `
        <div class="watch-history-alert" data-region="watch-rollback-error" tabindex="-1" role="alert">
          <span>${escapeHtml(_state.rollbackError)}</span>
          <button class="btn btn-outline btn-sm" type="button" data-action="watch-history-retry"
            data-workflow-id="${escapeHtml(workflowId)}">Refresh history</button>
        </div>
      ` : ''}
      <ol class="watch-version-history">
        ${versions.map((version) => renderWorkflowVersion({
          workflowId,
          version,
          activeVersionId,
          wasActive: previouslyActive.has(version.id),
        })).join('')}
      </ol>
    </section>
  `;
}

function renderWorkflowVersion({ workflowId, version, activeVersionId, wasActive }) {
  const current = version.id === activeVersionId;
  const payload = version.canonicalPayload && typeof version.canonicalPayload === 'object'
    ? version.canonicalPayload
    : {};
  const confirmation = _state.rollbackConfirmation;
  const confirming = confirmation?.workflowId === workflowId
    && confirmation?.versionId === version.id;
  const status = current ? 'Current' : wasActive ? 'Previously active' : 'Never active';
  return `
    <li class="watch-version-item">
      <div class="watch-version-main">
        <div class="watch-version-title">
          <strong>Version ${escapeHtml(version.versionNumber)}</strong>
          <span>${escapeHtml(status)}</span>
        </div>
        <p>${escapeHtml(payload.name || 'Signal digest')} · ${escapeHtml(formatSpec(payload))}</p>
        <time datetime="${escapeHtml(version.createdAt || '')}">${escapeHtml(formatTime(version.createdAt) || 'Time unavailable')}</time>
      </div>
      ${!current && wasActive ? `
        <button class="btn btn-outline btn-sm" type="button" data-action="watch-rollback-review"
          data-workflow-id="${escapeHtml(workflowId)}" data-version-id="${escapeHtml(version.id)}"
          ${_state.busy ? 'disabled' : ''}>
          Review rollback
        </button>
      ` : ''}
      ${confirming ? `
        <div class="watch-rollback-confirmation" data-region="watch-rollback-confirmation" tabindex="-1"
          role="group" aria-label="Confirm workflow rollback" aria-busy="${_state.busy === 'rolling-back'}">
          <p><strong>Roll back to version ${escapeHtml(version.versionNumber)}?</strong></p>
          <p>This replaces the active Watch projection, while keeping every version and activation event in history.</p>
          <div>
            <button class="btn btn-ghost btn-sm" type="button" data-action="watch-rollback-cancel"
              ${_state.busy ? 'disabled' : ''}>Cancel</button>
            <button class="btn btn-primary btn-sm" type="button" data-action="watch-rollback-confirm"
              ${_state.busy ? 'disabled' : ''}>
              ${_state.busy === 'rolling-back' ? 'Rolling back…' : `Confirm rollback to version ${escapeHtml(version.versionNumber)}`}
            </button>
          </div>
        </div>
      ` : ''}
    </li>
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

function resetComposer({ preservePrimaryDraft = false } = {}) {
  _interactionRevision += 1;
  const userId = getCurrentUserId();
  _state.draftText = preservePrimaryDraft ? readDraft(userId) : '';
  _state.preview = null;
  _state.adaptiveCandidate = null;
  _state.adaptiveEdit = null;
  _state.clarificationCount = 0;
  _state.previewError = '';
  _state.clarificationQuestion = '';
  _state.warning = '';
  _state.editingWatchId = null;
  clearAdaptiveEdit(userId);
  if (!preservePrimaryDraft) writeDraft(userId, '');
}

function focusComposer() {
  const input = _container?.querySelector('[data-region="watch-input"]');
  if (input && 'focus' in input) input.focus();
}

async function handlePreview(text) {
  const operation = captureOperation(getCurrentUserId(), true);
  _state.draftText = text;
  persistComposerDraft(getCurrentUserId(), text);
  _state.preview = null;
  _state.adaptiveCandidate = null;
  _state.previewError = '';
  _state.clarificationQuestion = '';
  _state.warning = '';
  if (!text) {
    _state.previewError = 'Add a watch request first.';
    paint({ focusSelector: '[data-region="watch-input"]' });
    return;
  }
  if (_state.adaptiveEdit) await handleAdaptiveRevision(text);
  else if (_state.readiness.state === 'ready' && !_state.editingWatchId) await handleAdaptiveAuthor(text);
  else await handleDeterministicPreview(text);
  if (isOperationCurrent(operation)) {
    const focusSelector = _state.clarificationQuestion || _state.previewError
      ? '[data-region="watch-input"]'
      : (_state.adaptiveCandidate
        ? '[data-action="adaptive-activate"]'
        : '[data-action="watch-create-active"]');
    paint({ focusSelector });
  }
}

async function handleDeterministicPreview(text) {
  const operation = captureOperation(getCurrentUserId(), true);
  try {
    const result = await parseWatchText(text);
    if (!isOperationCurrent(operation)) return;
    if (!result?.matched) _state.previewError = 'That does not look like a recurring Watch.';
    else _state.preview = result;
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.previewError = err?.message || 'Could not preview that Watch.';
  }
}

async function handleAdaptiveAuthor(text) {
  const userId = getCurrentUserId();
  const operation = captureOperation(userId, true);
  _state.busy = 'authoring';
  paint();
  try {
    const result = await createAdaptiveSignalDigestDraft(
      userId,
      text,
      _state.clarificationCount === 0,
    );
    if (!isOperationCurrent(operation)) return;
    if (!result?.success) {
      const error = new Error('SkyTwin could not prepare this proposal.');
      error.responseBody = result;
      throw error;
    }
    _state.adaptiveCandidate = adaptiveCandidateFromResult(result, 'initial');
    _state.clarificationCount = 0;
    _state.clarificationQuestion = '';
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    const failure = err?.responseBody?.failure;
    const message = adaptiveFailureMessage(failure?.state, err?.message, failure?.question);
    if (failure?.state === 'clarification_required') {
      _state.clarificationCount += 1;
      _state.clarificationQuestion = message;
      _state.previewError = '';
    } else {
      if (failure?.state) _state.readiness = failure;
      _state.clarificationQuestion = '';
      _state.previewError = message;
    }
  } finally {
    if (isOperationCurrent(operation)) _state.busy = '';
  }
}

async function handleAdaptiveRevision(text) {
  const userId = getCurrentUserId();
  const operation = captureOperation(userId, true);
  const edit = _state.adaptiveEdit;
  if (!edit) return;
  _state.busy = 'authoring';
  paint();
  try {
    const result = await createAdaptiveWorkflowFeedbackRevision(
      userId,
      edit.workflowId,
      edit.parentVersionId,
      text,
    );
    if (!isOperationCurrent(operation)) return;
    if (!result?.success) {
      const error = new Error('SkyTwin could not prepare this version.');
      error.responseBody = result;
      throw error;
    }
    _state.adaptiveCandidate = adaptiveCandidateFromResult(result, 'revision');
    _state.clarificationQuestion = '';
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    const failure = err?.responseBody?.failure;
    const message = adaptiveFailureMessage(failure?.state, err?.message, failure?.question)
      || 'Could not prepare that version.';
    if (failure?.state === 'clarification_required') {
      _state.clarificationQuestion = message;
      _state.previewError = '';
    } else {
      if (failure?.state) _state.readiness = failure;
      _state.clarificationQuestion = '';
      _state.previewError = message;
    }
  } finally {
    if (isOperationCurrent(operation)) _state.busy = '';
  }
}

function adaptiveFailureMessage(state, fallback, question) {
  if (state === 'clarification_required') {
    const boundedQuestion = typeof question === 'string' ? question.trim().slice(0, 180) : '';
    return boundedQuestion || 'What should this Watch match or summarize? Your draft is saved.';
  }
  const messages = {
    setup_required: 'Set up a model before using AI authoring. Your draft is saved.',
    confirmation_required: 'Confirm the configured provider before authoring. Your draft is saved.',
    policy_blocked: 'Your privacy policy blocks this authoring mode. Your draft is saved.',
    artifact_unavailable: 'Install or replace the managed local model artifact. Your draft is saved.',
    runtime_unavailable: 'The local model runtime is unavailable. Your draft is saved.',
    temporarily_unavailable: 'The model is temporarily unavailable. Your draft is saved.',
    unsupported_model: 'This model could not produce a safe workflow proposal. Your draft is saved.',
  };
  return messages[state] || fallback || 'Could not prepare that workflow. Your draft is saved.';
}

function adaptiveCandidateFromResult(result, kind = result?.kind || 'initial') {
  if (!result?.workflow || !result?.version || !result?.proposal) return null;
  const candidate = {
    kind,
    ...result,
    activation: {
      workflowId: result.workflow.id,
      versionId: result.version.id,
      proposalId: result.proposal.id,
      expectedActiveVersionId: result.workflow.activeVersionId ?? null,
    },
  };
  if (kind !== 'revision') return candidate;
  return {
    ...candidate,
    preview: result.preview || {
      routineSpec: result.version.canonicalPayload,
      summaryInstruction: result.version.canonicalPayload?.summaryInstruction,
      contentHash: result.version.contentHash,
      replay: result.replay?.after,
    },
    comparison: {
      beforeCaught: result.replay?.before?.simulation?.caughtCount ?? 0,
      afterCaught: result.replay?.after?.simulation?.caughtCount ?? 0,
    },
  };
}

async function resumeAdaptiveCandidate(operation) {
  try {
    const result = await fetchAdaptiveWorkflowResumableDraft(operation.userId);
    if (!isOperationCurrent(operation) || _state.adaptiveCandidate) return;
    const candidate = adaptiveCandidateFromResult(result?.candidate);
    if (candidate) _state.adaptiveCandidate = candidate;
  } catch {
    // A durable proposal remains in the database; a later render retries.
  }
  if (isOperationCurrent(operation)) paint();
}

async function handleAdaptiveActivate() {
  const candidate = _state.adaptiveCandidate;
  const userId = getCurrentUserId();
  const operation = captureOperation(userId);
  if (!candidate?.activation || !userId || _state.busy) return;
  _state.busy = 'activating';
  paint({ focusSelector: '[data-region="watch-preview-result"]' });
  try {
    const activation = candidate.activation;
    await activateAdaptiveWorkflow(userId, activation.workflowId, {
      versionId: activation.versionId,
      proposalId: activation.proposalId,
      expectedActiveVersionId: activation.expectedActiveVersionId,
    });
    if (!isOperationCurrent(operation)) return;
    const versionNumber = candidate.version?.versionNumber ?? 1;
    resetComposer({ preservePrimaryDraft: candidate.kind === 'revision' });
    showToast(`Watch version ${versionNumber} activated.`, { kind: 'success' });
    await refresh(captureOperation(userId));
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.warning = err?.status === 409
      ? 'This workflow changed elsewhere. Review the latest version before activating.'
      : (err?.message || 'Could not activate this version.');
  } finally {
    if (isOperationCurrent(operation)) {
      _state.busy = '';
      paint({
        focusSelector: _state.adaptiveCandidate
          ? '[data-action="adaptive-activate"]'
          : '[data-region="watch-input"]',
      });
    }
  }
}

async function refreshReadiness(operation = captureOperation(), force = false) {
  const userId = operation.userId;
  if (!userId) return;
  const cached = _readinessCache.get(userId);
  if (!force && cached && Date.now() - cached.checkedAt < READINESS_CACHE_MS) {
    if (isOperationCurrent(operation)) {
      _state.readiness = cached.readiness;
      paint();
    }
    return;
  }
  if (isOperationCurrent(operation)) {
    _state.readiness = { state: 'loading' };
    paint({ focusSelector: force ? '[data-region="watch-readiness-status"]' : '' });
  }
  try {
    const result = await fetchAdaptiveWorkflowReadiness(userId);
    if (!isOperationCurrent(operation)) return;
    _state.readiness = result?.readiness ?? { state: 'load_error', retryable: true };
    if (_state.readiness.state === 'ready') {
      _readinessCache.set(userId, { readiness: _state.readiness, checkedAt: Date.now() });
    } else {
      _readinessCache.delete(userId);
    }
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.readiness = err?.responseBody?.readiness ?? {
      state: 'load_error',
      reason: err?.message || 'Could not check readiness.',
      retryable: true,
    };
  }
  if (isOperationCurrent(operation)) {
    paint({
      focusSelector: force
        ? (_state.readiness.retryable
          ? '[data-action="adaptive-readiness-retry"]'
          : '[data-region="watch-input"]')
        : '',
    });
  }
}

async function handleSave(status) {
  const userId = getCurrentUserId();
  const operation = captureOperation(userId, true);
  if (!_state.preview?.matched || !userId) return;
  try {
    if (_state.editingWatchId) {
      await updateWatchSpec(userId, _state.editingWatchId, _state.preview.spec, _state.draftText);
      if (!isOperationCurrent(operation)) return;
      showToast('Watch updated.', { kind: 'success' });
    } else {
      const result = await createWatch(userId, {
        spec: _state.preview.spec,
        sourceText: _state.draftText,
        status,
      });
      if (!isOperationCurrent(operation)) return;
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      showToast(warnings[0] || (status === 'active' ? 'Watch activated.' : 'Watch saved as draft.'), {
        kind: warnings.length ? 'warning' : 'success',
      });
    }
    resetComposer();
    await refresh(captureOperation(userId));
    focusComposer();
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.warning = err?.message || 'Could not save that watch.';
    paint({ focusSelector: '[data-region="watch-input"]' });
  }
}

async function handleStatus(id, status) {
  const userId = getCurrentUserId();
  const operation = captureOperation(userId);
  try {
    await updateWatchStatus(userId, id, status);
    if (!isOperationCurrent(operation)) return;
    showToast(status === 'active' ? 'Watch resumed.' : 'Watch paused.', { kind: 'success' });
    await refresh(operation);
    if (isOperationCurrent(operation)) focusActionIdentity('watch-status', 'data-watch-id', id);
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    showToast(err?.message || 'Could not update that Watch.', { kind: 'error' });
  }
}

function handleDeleteReview(id) {
  if (_state.busy) return;
  const watch = _state.watches.find((candidate) => candidate.id === id);
  if (!watch) return;
  _state.deleteConfirmation = { watchId: id };
  _state.deleteError = '';
  paint({ focusSelector: '[data-region="watch-delete-confirmation"]' });
}

function handleDeleteCancel() {
  const watchId = _state.deleteConfirmation?.watchId ?? null;
  if (!watchId || _state.busy) return;
  _state.deleteConfirmation = null;
  _state.deleteError = '';
  paint();
  focusActionIdentity('watch-delete', 'data-watch-id', watchId);
}

async function handleDeleteConfirm() {
  const id = _state.deleteConfirmation?.watchId;
  const userId = getCurrentUserId();
  if (!id || !userId || _state.busy) return;
  const operation = captureOperation(userId);
  _state.busy = 'deleting';
  _state.deleteError = '';
  paint({ focusSelector: '[data-region="watch-delete-confirmation"]' });
  try {
    await deleteWatch(userId, id);
    if (!isOperationCurrent(operation)) return;
    _state.runsByWatchId.delete(id);
    if (_state.selectedWatchId === id) _state.selectedWatchId = null;
    _state.deleteConfirmation = null;
    _state.watches = _state.watches.filter((watch) => watch.id !== id);
    _state.busy = '';
    showToast('Watch deleted.', { kind: 'success' });
    paint();
    try {
      await refresh(operation);
    } catch {
      if (isOperationCurrent(operation)) {
        showToast('Watch deleted, but the list could not be refreshed.', { kind: 'warning' });
      }
    }
    focusComposer();
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.deleteError = err?.message || 'Could not delete that Watch. Try again.';
  } finally {
    if (isOperationCurrent(operation)) {
      _state.busy = '';
      if (_state.deleteConfirmation) {
        paint({ focusSelector: '[data-region="watch-delete-confirmation"]' });
      }
    }
  }
}

async function handleRuns(id) {
  const userId = getCurrentUserId();
  const operation = captureOperation(userId);
  if (_state.selectedWatchId === id) {
    _state.selectedWatchId = null;
    paint();
    focusActionIdentity('watch-runs', 'data-watch-id', id);
    return;
  }
  _state.selectedWatchId = id;
  if (!_state.runsByWatchId.has(id)) {
    _state.runsLoadingId = id;
    paint({ focusSelector: `#watch-runs-${id}` });
    try {
      const data = await fetchWatchRuns(userId, id, 10);
      if (!isOperationCurrent(operation)) return;
      _state.runsByWatchId.set(id, Array.isArray(data?.runs) ? data.runs : []);
    } catch (err) {
      if (!isOperationCurrent(operation)) return;
      showToast(err?.message || 'Could not load runs.', { kind: 'error' });
      // Do NOT cache on failure: the `!has(id)` guard above would then treat a
      // transient error as "no runs" forever (Copilot review). Leave the cache
      // empty and collapse the row so the next click re-fetches.
      _state.runsByWatchId.delete(id);
      _state.selectedWatchId = null;
    } finally {
      if (isOperationCurrent(operation)) _state.runsLoadingId = null;
    }
  }
  if (isOperationCurrent(operation)) {
    paint({ focusSelector: _state.selectedWatchId === id ? `#watch-runs-${id}` : '' });
  }
}

async function handleHistory(workflowId) {
  if (_state.busy === 'rolling-back') return;
  if (_state.history.workflowId === workflowId) {
    _state.history = { workflowId: null, detail: null, loading: false, error: '' };
    _state.rollbackConfirmation = null;
    _state.rollbackError = '';
    paint();
    focusActionIdentity('watch-history', 'data-workflow-id', workflowId);
    return;
  }
  await loadWorkflowHistory(workflowId);
}

async function loadWorkflowHistory(workflowId) {
  const userId = getCurrentUserId();
  const operation = captureOperation(userId);
  _state.history = { workflowId, detail: null, loading: true, error: '' };
  _state.rollbackConfirmation = null;
  _state.rollbackError = '';
  paint({ focusSelector: '[data-region="watch-history"]' });
  try {
    const detail = await fetchAdaptiveWorkflowDetail(userId, workflowId);
    if (!isOperationCurrent(operation) || _state.history.workflowId !== workflowId) return;
    _state.history = { workflowId, detail, loading: false, error: '' };
  } catch (err) {
    if (!isOperationCurrent(operation) || _state.history.workflowId !== workflowId) return;
    _state.history = {
      workflowId,
      detail: null,
      loading: false,
      error: err?.message || 'Could not load version history.',
    };
  }
  if (isOperationCurrent(operation) && _state.history.workflowId === workflowId) {
    paint({ focusSelector: '[data-region="watch-history"]' });
  }
}

function handleRollbackReview(workflowId, versionId) {
  if (_state.busy) return;
  const detail = _state.history.workflowId === workflowId ? _state.history.detail : null;
  const activeVersionId = detail?.workflow?.activeVersionId ?? detail?.activeVersion?.id ?? null;
  const version = Array.isArray(detail?.versions)
    ? detail.versions.find((entry) => entry.id === versionId)
    : null;
  const wasActive = Array.isArray(detail?.activationEvents)
    && detail.activationEvents.some((event) => event.activatedVersionId === versionId);
  if (!version || !activeVersionId || versionId === activeVersionId || !wasActive) return;
  _state.rollbackError = '';
  _state.rollbackConfirmation = {
    workflowId,
    versionId,
    versionNumber: version.versionNumber,
    expectedActiveVersionId: activeVersionId,
  };
  paint({ focusSelector: '[data-region="watch-rollback-confirmation"]' });
}

async function handleRollbackConfirm() {
  const confirmation = _state.rollbackConfirmation;
  const userId = getCurrentUserId();
  if (!confirmation || !userId || _state.busy) return;
  const operation = captureOperation(userId);
  _state.busy = 'rolling-back';
  _state.rollbackError = '';
  paint({ focusSelector: '[data-region="watch-rollback-confirmation"]' });
  let finalFocusSelector = '[data-region="watch-history"]';
  try {
    await rollbackAdaptiveWorkflow(userId, confirmation.workflowId, {
      versionId: confirmation.versionId,
      expectedActiveVersionId: confirmation.expectedActiveVersionId,
    });
    if (!isOperationCurrent(operation)) return;
    if (_state.adaptiveCandidate?.activation?.workflowId === confirmation.workflowId) {
      _state.adaptiveCandidate = null;
    }
    if (_state.adaptiveEdit?.workflowId === confirmation.workflowId) {
      resetComposer({ preservePrimaryDraft: true });
    }
    _state.rollbackConfirmation = null;
    showToast(`Watch rolled back to version ${confirmation.versionNumber}.`, { kind: 'success' });

    const [watchesResult, detailResult] = await Promise.allSettled([
      fetchWatches(userId),
      fetchAdaptiveWorkflowDetail(userId, confirmation.workflowId),
    ]);
    if (!isOperationCurrent(operation)) return;
    if (watchesResult.status === 'fulfilled') {
      _state.watches = Array.isArray(watchesResult.value?.watches) ? watchesResult.value.watches : [];
    }
    if (detailResult.status === 'fulfilled') {
      _state.history = {
        workflowId: confirmation.workflowId,
        detail: detailResult.value,
        loading: false,
        error: '',
      };
    } else {
      _state.history = {
        workflowId: confirmation.workflowId,
        detail: null,
        loading: false,
        error: 'The rollback succeeded, but version history could not be refreshed.',
      };
    }
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.rollbackConfirmation = null;
    _state.rollbackError = err?.status === 409
      ? 'This workflow changed elsewhere. Refresh history before choosing a rollback version.'
      : (err?.message || 'Could not roll back this Watch.');
    finalFocusSelector = '[data-region="watch-rollback-error"]';
  } finally {
    if (isOperationCurrent(operation)) {
      _state.busy = '';
      paint({ focusSelector: finalFocusSelector });
    }
  }
}

async function handleEdit(id) {
  const watch = _state.watches.find((w) => w.id === id);
  if (!watch) return;
  if (watch.workflowId) {
    await handleAdaptiveEdit(watch);
    return;
  }
  _state.editingWatchId = id;
  _state.adaptiveEdit = null;
  _state.draftText = watch.sourceText || watch.name || '';
  _state.preview = null;
  _state.previewError = '';
  _state.warning = '';
  writeDraft(getCurrentUserId(), _state.draftText);
  paint();
  focusComposer();
}

async function handleAdaptiveEdit(watch) {
  const userId = getCurrentUserId();
  _interactionRevision += 1;
  const operation = captureOperation(userId, true);
  _state.busy = 'editing';
  _state.previewError = '';
  _state.warning = '';
  paint();
  try {
    const detail = await fetchAdaptiveWorkflowDetail(userId, watch.workflowId);
    if (!isOperationCurrent(operation)) return;
    const activeVersion = detail?.activeVersion;
    if (!activeVersion?.canonicalPayload) {
      throw new Error('The active workflow version could not be loaded.');
    }
    _state.editingWatchId = null;
    _state.adaptiveEdit = {
      workflowId: watch.workflowId,
      parentVersionId: activeVersion.id,
      basePayload: activeVersion.canonicalPayload,
    };
    // Corrections are patches against this immutable payload. Starting from a
    // blank instruction prevents a lossy pseudo-description from becoming an
    // accidental full rewrite, while the current state remains visible below.
    _state.draftText = '';
    _state.adaptiveCandidate = null;
    writeAdaptiveEdit(userId, { ..._state.adaptiveEdit, feedback: '' });
  } catch (err) {
    if (!isOperationCurrent(operation)) return;
    _state.previewError = err?.message || 'Could not load that workflow version.';
  } finally {
    if (isOperationCurrent(operation)) {
      _state.busy = '';
      paint();
      focusComposer();
    }
  }
}

async function refresh(operation = captureOperation()) {
  const userId = operation.userId;
  const data = await fetchWatches(userId);
  if (!isOperationCurrent(operation)) return;
  _state.watches = Array.isArray(data?.watches) ? data.watches : [];
  paint();
}

function readDraft(userId) {
  if (!userId) return '';
  try { return localStorage.getItem(adaptiveWatchDraftKey(userId)) || ''; }
  catch { return ''; }
}

function writeDraft(userId, value) {
  if (!userId) return;
  try {
    if (value) localStorage.setItem(adaptiveWatchDraftKey(userId), value);
    else localStorage.removeItem(adaptiveWatchDraftKey(userId));
  } catch { /* private mode */ }
}

function readAdaptiveEdit(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(adaptiveWatchEditKey(userId));
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object'
        || typeof value.workflowId !== 'string'
        || typeof value.parentVersionId !== 'string'
        || !value.basePayload || typeof value.basePayload !== 'object'
        || typeof value.feedback !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function writeAdaptiveEdit(userId, value) {
  if (!userId) return;
  try { localStorage.setItem(adaptiveWatchEditKey(userId), JSON.stringify(value)); }
  catch { /* private mode */ }
}

function clearAdaptiveEdit(userId) {
  if (!userId) return;
  try { localStorage.removeItem(adaptiveWatchEditKey(userId)); }
  catch { /* private mode */ }
}

function persistComposerDraft(userId, value) {
  if (_state.adaptiveEdit) {
    writeAdaptiveEdit(userId, { ..._state.adaptiveEdit, feedback: value });
  } else {
    writeDraft(userId, value);
  }
}
