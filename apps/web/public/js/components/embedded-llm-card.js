/**
 * Settings → Local AI brain card (#187 AC#2).
 *
 * Shows detected runtime, currently-installed model (or "no model yet"),
 * recommends a default for the user's RAM bracket, and surfaces an
 * in-progress download with progress bar + pause/resume/cancel.
 *
 * Polling cadence: while a download is active (status in
 * downloading/verifying/installing), poll every 1s. Otherwise no
 * polling — the card re-fetches on every settings render.
 */

import {
  cancelModelDownload,
  escapeHtml,
  fetchEmbeddedLlmModelDir,
  fetchEmbeddedLlmRegistry,
  fetchModelDownload,
  listUserModelDownloads,
  pauseModelDownload,
  recommendEmbeddedDefault,
  resumeModelDownload,
  startModelDownload,
} from '../api-client.js';
import { KEY_USER_ID } from '../storage-keys.js';
import { showErrorToast, showSavedToast } from '../toast.js';

const CARD_TARGET_ID = 'embedded-llm-card-target';

function getCurrentUserId() {
  try {
    return localStorage.getItem(KEY_USER_ID) || '';
  } catch {
    return '';
  }
}

// Statuses that mean "something is in flight" — drives the polling
// loop and keeps the card showing a progress UI rather than the picker.
const ACTIVE_STATUSES = new Set(['pending', 'downloading', 'verifying', 'installing']);
// Subset where the backend can actually pause. pauseDownload() returns
// ok:false for verifying/installing, so we hide the Pause button there.
// Cancel still works through verify/install — the runner checks the
// cancelled flag at phase boundaries.
const PAUSABLE_STATUSES = new Set(['pending', 'downloading']);

const POLL_INTERVAL_MS = 1000;

let _pollTimer = null;
let _activeDownloadId = null;

/**
 * Estimate the user's RAM bracket. Browsers don't expose system RAM
 * directly; `navigator.deviceMemory` reports a coarse Gigabyte value
 * (4, 8, 16, 32) but is missing on Safari. Fall back to '8gb' — the
 * most common bucket for a 2024-era laptop.
 */
function detectBracket() {
  const dm = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  if (typeof dm !== 'number') return '8gb';
  if (dm <= 4) return '4gb';
  if (dm <= 8) return '8gb';
  if (dm <= 16) return '16gb';
  return '32gb-plus';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function statusLabel(status) {
  switch (status) {
    case 'pending': return 'Starting…';
    case 'downloading': return 'Downloading';
    case 'paused': return 'Paused';
    case 'verifying': return 'Verifying integrity…';
    case 'installing': return 'Installing…';
    case 'complete': return 'Ready';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return status;
  }
}

function progressBarHtml(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return `
    <div class="confidence-bar" role="progressbar" aria-valuenow="${clamped}" aria-valuemin="0" aria-valuemax="100" aria-label="Download progress">
      <div class="confidence-fill high" style="width: ${clamped}%;"></div>
    </div>
  `;
}

function downloadCardHtml(download, modelName) {
  const status = download.status;
  const percent = download.percent ?? 0;
  const bytesSoFar = formatBytes(download.bytesDownloaded);
  const totalSize = formatBytes(download.totalBytes);
  const isActive = ACTIVE_STATUSES.has(status);
  const isPausable = PAUSABLE_STATUSES.has(status);
  const isPaused = status === 'paused';
  const isError = status === 'failed';

  const actionButtons = (() => {
    if (isActive) {
      const pauseBtn = isPausable
        ? `<button class="btn btn-outline btn-sm" data-action="embedded-pause-download" data-download-id="${escapeHtml(download.id)}">Pause</button>`
        : '';
      return `${pauseBtn}
              <button class="btn btn-outline btn-sm" data-action="embedded-cancel-download" data-download-id="${escapeHtml(download.id)}">Cancel</button>`;
    }
    if (isPaused) {
      return `<button class="btn btn-primary btn-sm" data-action="embedded-resume-download" data-download-id="${escapeHtml(download.id)}">Resume</button>
              <button class="btn btn-outline btn-sm" data-action="embedded-cancel-download" data-download-id="${escapeHtml(download.id)}">Cancel</button>`;
    }
    if (isError) {
      return `<button class="btn btn-primary btn-sm" data-action="embedded-resume-download" data-download-id="${escapeHtml(download.id)}">Retry</button>`;
    }
    return '';
  })();

  return `
    <div style="margin-top: 0.75rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
        <span style="font-weight: 500;">${escapeHtml(modelName)}</span>
        <span data-role="embedded-llm-status" style="font-size: 0.8rem; color: ${isError ? 'var(--danger)' : 'var(--text-muted)'};">${escapeHtml(statusLabel(status))}</span>
      </div>
      ${progressBarHtml(percent)}
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.4rem; font-size: 0.75rem; color: var(--text-muted);">
        <span data-role="embedded-llm-progress-text">${bytesSoFar} / ${totalSize} · ${percent}%</span>
        <span style="display: flex; gap: 0.4rem;">${actionButtons}</span>
      </div>
      ${isError && download.error ? `<div style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--danger);">${escapeHtml(download.error)}</div>` : ''}
    </div>
  `;
}

/**
 * Render the entire card. Idempotent — call again any time state
 * changes and the DOM gets replaced atomically.
 */
async function renderCardInto(container, userId) {
  const [registryRes, dirRes, listRes] = await Promise.allSettled([
    fetchEmbeddedLlmRegistry(),
    fetchEmbeddedLlmModelDir(),
    listUserModelDownloads(userId),
  ]);
  const models = registryRes.status === 'fulfilled' && Array.isArray(registryRes.value?.models)
    ? registryRes.value.models
    : [];
  const modelDir = dirRes.status === 'fulfilled' ? dirRes.value?.modelDir ?? '' : '';
  const downloads = listRes.status === 'fulfilled' && Array.isArray(listRes.value?.downloads)
    ? listRes.value.downloads
    : [];

  const active = downloads.find((d) => ACTIVE_STATUSES.has(d.status))
    ?? downloads.find((d) => d.status === 'paused' || d.status === 'failed');
  const completed = downloads.find((d) => d.status === 'complete');

  const bracket = detectBracket();
  let recommended = null;
  try {
    const rec = await recommendEmbeddedDefault(bracket);
    recommended = rec?.model ?? null;
  } catch { /* leave null */ }

  const recommendedSize = recommended
    ? `${(recommended.approxBytes / (1024 ** 3)).toFixed(1)} GB`
    : '';
  const modelOptionsHtml = models.map((m) => {
    const sizeGb = (m.approxBytes / (1024 ** 3)).toFixed(1);
    const isRec = recommended && m.id === recommended.id;
    return `<option value="${escapeHtml(m.id)}" ${isRec ? 'selected' : ''}>${escapeHtml(m.displayName)} · ${sizeGb} GB · ${escapeHtml(m.ramBracket)}${isRec ? ' (recommended)' : ''}</option>`;
  }).join('');

  let body = '';
  if (completed && !active) {
    body = `
      <div style="padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">
        <div style="font-weight: 500; color: var(--success);">✓ Your twin's brain is installed</div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
          ${escapeHtml(completed.modelId)} · saved to <code>${escapeHtml(completed.targetPath)}</code>
        </div>
      </div>
    `;
  } else if (active) {
    const modelMeta = models.find((m) => m.id === active.modelId);
    body = downloadCardHtml(active, modelMeta?.displayName ?? active.modelId);
  } else {
    body = `
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        Your twin works fully offline once a brain is installed. We'll download it once and save it to <code>${escapeHtml(modelDir)}</code>. No API keys, no per-message costs.
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: stretch;">
        <select class="form-input" id="embedded-model-select" style="flex: 1;">
          ${modelOptionsHtml}
        </select>
        <button class="btn btn-primary btn-sm" data-action="embedded-start-download">Download</button>
      </div>
      ${recommended ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">Recommended for your machine: <strong>${escapeHtml(recommended.displayName)}</strong> (${recommendedSize}).</div>` : ''}
    `;
  }

  container.innerHTML = `
    <div class="card" id="embedded-llm-card">
      <div class="card-header">
        <span class="card-title">Local AI brain</span>
      </div>
      ${body}
    </div>
  `;

  // Manage polling: poll while we have an active download.
  if (active && ACTIVE_STATUSES.has(active.status)) {
    startPolling(container, userId, active.id);
  } else {
    stopPolling();
  }
}

function startPolling(container, userId, downloadId) {
  if (_activeDownloadId === downloadId && _pollTimer !== null) return;
  stopPolling();
  _activeDownloadId = downloadId;
  _pollTimer = setInterval(async () => {
    try {
      const data = await fetchModelDownload(downloadId);
      const dl = data?.download;
      if (!dl || !ACTIVE_STATUSES.has(dl.status)) {
        // Status changed — re-render entire card (transitions to
        // verifying / installing / complete / failed).
        await renderCardInto(container, userId);
        return;
      }
      // Active mid-download: just update the visible progress without
      // re-fetching the registry. Targeted updates via data-role
      // selectors so the action-button span isn't disturbed.
      const fillEl = container.querySelector('.confidence-fill');
      if (fillEl instanceof HTMLElement) {
        fillEl.style.width = `${dl.percent}%`;
      }
      const bar = container.querySelector('[role="progressbar"]');
      if (bar) bar.setAttribute('aria-valuenow', String(dl.percent));
      const progressText = container.querySelector('[data-role="embedded-llm-progress-text"]');
      if (progressText) {
        progressText.textContent = `${formatBytes(dl.bytesDownloaded)} / ${formatBytes(dl.totalBytes)} · ${dl.percent}%`;
      }
    } catch {
      // Best-effort poll. The next render will pick up state.
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (_pollTimer !== null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _activeDownloadId = null;
}

let _listenerWired = false;
function ensureListener() {
  if (_listenerWired) return;
  _listenerWired = true;

  // Singleton document-level delegator. We deliberately don't close
  // over `container` or `userId` — `renderSettings()` creates a new
  // `#embedded-llm-card-target` element on every navigation, and a
  // captured reference would point at a detached DOM node. Both are
  // re-derived inside the handler from the current document state.
  document.addEventListener('click', async (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const el = target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');

    const container = document.getElementById(CARD_TARGET_ID);
    if (!container) return;
    const userId = getCurrentUserId();
    if (!userId) return;

    if (action === 'embedded-start-download') {
      const sel = container.querySelector('#embedded-model-select');
      const modelId = sel instanceof HTMLSelectElement ? sel.value : '';
      if (!modelId) return;
      try {
        await startModelDownload(userId, modelId);
        showSavedToast('Download started');
        await renderCardInto(container, userId);
      } catch (err) {
        showErrorToast(`Couldn't start download: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
      }
      return;
    }
    if (action === 'embedded-pause-download') {
      const id = el.getAttribute('data-download-id');
      if (!id) return;
      try {
        await pauseModelDownload(id);
        showSavedToast('Paused');
        await renderCardInto(container, userId);
      } catch (err) {
        showErrorToast(`Couldn't pause: ${err?.message ?? 'unknown error'}`);
      }
      return;
    }
    if (action === 'embedded-resume-download') {
      const id = el.getAttribute('data-download-id');
      if (!id) return;
      try {
        await resumeModelDownload(id);
        showSavedToast('Resumed');
        await renderCardInto(container, userId);
      } catch (err) {
        showErrorToast(`Couldn't resume: ${err?.message ?? 'unknown error'}`);
      }
      return;
    }
    if (action === 'embedded-cancel-download') {
      const id = el.getAttribute('data-download-id');
      if (!id) return;
      if (!confirm('Cancel the download? The partial file will be deleted.')) return;
      try {
        await cancelModelDownload(id);
        showSavedToast('Cancelled');
        await renderCardInto(container, userId);
      } catch (err) {
        showErrorToast(`Couldn't cancel: ${err?.message ?? 'unknown error'}`);
      }
      return;
    }
  });
}

/**
 * Mount the card into a container. Settings page calls this once per
 * render. Idempotent listener wiring + replaceable polling.
 */
export async function mountEmbeddedLlmCard(container, userId) {
  if (!container) return;
  ensureListener();
  await renderCardInto(container, userId);
}
