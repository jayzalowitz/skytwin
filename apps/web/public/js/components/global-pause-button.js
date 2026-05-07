/**
 * global-pause-button.js
 *
 * Always-visible "Pause everything" / "Resume all" safety-net affordance (#190).
 *
 * Mount by calling renderGlobalPauseButton(targetEl) once on boot. The component:
 *   1. Fetches current pause state on mount (any paused servers → "Resume all").
 *   2. On click: calls the appropriate API endpoint, updates UI state.
 *   3. Subscribes to SSE capability:health events to update state when status changes.
 *
 * Singleton delegator: _pauseButtonWired guards a single document-level click
 * listener so re-renders never stack listeners.
 */

import { fetchCapabilities, pauseAllCapabilities, resumeAllCapabilities, escapeHtml } from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

// Module-level state
let _isPaused = false;
let _pauseButtonTargetEl = null;
let _pauseButtonListenerWired = false;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

/**
 * Render the button into the target element.
 * Safe to call multiple times — re-renders in place without stacking listeners.
 */
export function renderGlobalPauseButton(targetEl) {
  if (!targetEl) return;
  _pauseButtonTargetEl = targetEl;
  ensurePauseButtonListener();
  _renderButton();
  // Fetch current state asynchronously; update button when it resolves.
  _refreshPauseState();
}

function _renderButton() {
  if (!_pauseButtonTargetEl) return;
  if (_isPaused) {
    _pauseButtonTargetEl.innerHTML = `
      <button
        class="btn btn-sm"
        data-action="global-resume"
        style="background: var(--color-warning, #e6a700); color: #000; border: none; font-weight: 600; font-size: 0.8rem; padding: 0.3rem 0.75rem; border-radius: var(--radius-sm); cursor: pointer;"
        title="All capability servers are paused. Click to resume."
      >Resume all</button>
    `;
  } else {
    _pauseButtonTargetEl.innerHTML = `
      <button
        class="btn btn-sm btn-outline"
        data-action="global-pause"
        style="font-size: 0.8rem; padding: 0.3rem 0.75rem; border-radius: var(--radius-sm); cursor: pointer;"
        title="Pause all capability servers immediately."
      >Pause everything</button>
    `;
  }
}

async function _refreshPauseState() {
  const userId = getCurrentUserId();
  if (!userId) return;
  try {
    const data = await fetchCapabilities(userId);
    // If any server has status=paused, treat the global state as paused.
    const hasPaused =
      Array.isArray(data?.dormant) && data.dormant.some((s) => s.status === 'paused') ||
      Array.isArray(data?.installed) && data.installed.some((s) => s.status === 'paused');
    _isPaused = hasPaused;
    _renderButton();
  } catch {
    // Non-critical — leave button in current state
  }
}

function ensurePauseButtonListener() {
  if (_pauseButtonListenerWired || typeof document === 'undefined') return;
  _pauseButtonListenerWired = true;

  document.addEventListener('click', async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const btn = target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action !== 'global-pause' && action !== 'global-resume') return;

    const userId = getCurrentUserId();
    if (!userId) return;

    // Optimistic UI update
    btn.disabled = true;
    btn.textContent = action === 'global-pause' ? 'Pausing…' : 'Resuming…';

    try {
      if (action === 'global-pause') {
        const result = await pauseAllCapabilities(userId);
        _isPaused = true;
        showToast(
          `Paused ${result.pausedCount ?? 0} capability server${(result.pausedCount ?? 0) !== 1 ? 's' : ''}. Your twin is standing by.`,
          { kind: 'success' },
        );
      } else {
        const result = await resumeAllCapabilities(userId);
        _isPaused = false;
        showToast(
          `Resumed ${result.resumedCount ?? 0} capability server${(result.resumedCount ?? 0) !== 1 ? 's' : ''}. Your twin is active again.`,
          { kind: 'success' },
        );
      }
    } catch (err) {
      showToast(`Could not ${action === 'global-pause' ? 'pause' : 'resume'} capabilities: ${escapeHtml(err.message)}`, { kind: 'error' });
    } finally {
      _renderButton();
    }
  });

  // SSE: refresh state when any capability:health event arrives.
  window.addEventListener('sse:capability:health', () => {
    _refreshPauseState();
  });
}
