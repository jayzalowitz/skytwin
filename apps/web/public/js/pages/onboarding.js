/**
 * Briefing-first onboarding.
 *
 * The first run asks only three questions: which data to begin with, where
 * reasoning may run, and the initial authority. Choices are kept in a small,
 * versioned local resume record until this flow completes. API keys, tokens,
 * source contents, and provider endpoints are never written to that record.
 */

import {
  escapeHtml,
  fetchDemoInfo,
  startDemoSession,
  updateReasoningMode,
} from '../api-client.js';
import {
  KEY_ONBOARDED,
  KEY_ONBOARDING_REASONING_CHOICE,
  KEY_ONBOARDING_RETURN_HASH,
  KEY_ONBOARDING_STATE,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
  ONBOARDING_STATE_VERSION,
} from '../storage-keys.js';
import { startGoogleSignIn } from '../google-signin.js';

export const ONBOARDING_SCREENS = Object.freeze([
  'data_source',
  'reasoning',
  'autonomy',
  'complete',
  'connecting',
  'error',
]);

const RESUMABLE_SCREENS = new Set(['data_source', 'reasoning', 'autonomy']);
const DATA_SOURCES = new Set(['sample', 'connect']);
const REASONING_CHOICES = new Set(['not_configured', 'bring_your_own_provider']);

let _listenerWired = false;
let _onComplete = null;
let _state = null;

export function initialOnboardingState(userId = '') {
  return {
    screen: 'data_source',
    dataSource: null,
    reasoningMode: null,
    autonomy: 'observer',
    userId,
    retryScreen: 'data_source',
    errorMessage: '',
  };
}

/** Validate persisted data field-by-field; unknown or stale shapes reset safely. */
export function parseOnboardingResumeState(raw, userId = '') {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || value.v !== ONBOARDING_STATE_VERSION) return null;
    if (!RESUMABLE_SCREENS.has(value.screen)) return null;
    const dataSource = DATA_SOURCES.has(value.dataSource) ? value.dataSource : null;
    const reasoningMode = dataSource === 'connect' && REASONING_CHOICES.has(value.reasoningMode)
      ? value.reasoningMode
      : null;
    if (value.screen !== 'data_source' && !dataSource) return null;
    if (value.screen === 'autonomy' && dataSource === 'connect' && !reasoningMode) return null;
    return {
      ...initialOnboardingState(userId),
      screen: value.screen,
      dataSource,
      reasoningMode,
    };
  } catch {
    return null;
  }
}

function readResumeState(userId) {
  try {
    return parseOnboardingResumeState(localStorage.getItem(KEY_ONBOARDING_STATE), userId);
  } catch {
    return null;
  }
}

function saveResumeState() {
  if (!_state || !RESUMABLE_SCREENS.has(_state.screen)) return;
  try {
    localStorage.setItem(KEY_ONBOARDING_STATE, JSON.stringify({
      v: ONBOARDING_STATE_VERSION,
      screen: _state.screen,
      dataSource: _state.dataSource,
      reasoningMode: _state.reasoningMode,
    }));
  } catch { /* Storage may be unavailable; the in-memory flow still works. */ }
}

function clearResumeState() {
  try { localStorage.removeItem(KEY_ONBOARDING_STATE); } catch { /* noop */ }
}

function currentUserId() {
  try { return localStorage.getItem(KEY_USER_ID) || ''; } catch { return ''; }
}

const SAFE_RETURN_HASH = /^#\/(?:[a-z0-9][a-z0-9/-]*)?(?:\?[^\s#]*)?$/i;

export function rememberOnboardingReturnHash(hash) {
  if (typeof hash !== 'string' || hash === '#/' || !SAFE_RETURN_HASH.test(hash)) return false;
  try {
    localStorage.setItem(KEY_ONBOARDING_RETURN_HASH, hash);
    return true;
  } catch {
    return false;
  }
}

export function consumeOnboardingReturnHash(fallback = '#/connect-gmail') {
  try {
    const value = localStorage.getItem(KEY_ONBOARDING_RETURN_HASH);
    localStorage.removeItem(KEY_ONBOARDING_RETURN_HASH);
    return value && SAFE_RETURN_HASH.test(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function savePendingReasoningChoice(choice) {
  try {
    if (choice === 'bring_your_own_provider') {
      localStorage.setItem(KEY_ONBOARDING_REASONING_CHOICE, choice);
    } else {
      localStorage.removeItem(KEY_ONBOARDING_REASONING_CHOICE);
    }
    return true;
  } catch {
    return false;
  }
}

/** Apply the only canonical active choice after a session exists. */
export async function applyPendingReasoningChoice(userId) {
  let choice = null;
  try { choice = localStorage.getItem(KEY_ONBOARDING_REASONING_CHOICE); } catch {
    throw new Error('Reasoning preference storage is unavailable.');
  }
  if (choice !== 'bring_your_own_provider') return true;
  await updateReasoningMode(userId, choice);
  try { localStorage.removeItem(KEY_ONBOARDING_REASONING_CHOICE); } catch { /* applied server-side */ }
  return true;
}

/**
 * Finalize the browser OAuth handoff in the only safe order: establish the
 * authenticated identity, durably apply the chosen reasoning boundary, then
 * mark onboarding complete. A failed boundary write intentionally leaves the
 * session and pending choice in place for an authenticated retry.
 */
export async function completePendingGoogleOnboarding(completion) {
  if (!completion?.sessionToken || !completion?.userId) {
    throw new Error('The secure sign-in handoff was incomplete.');
  }
  localStorage.setItem(KEY_SESSION_TOKEN, completion.sessionToken);
  localStorage.setItem(KEY_USER_ID, completion.userId);
  await applyPendingReasoningChoice(completion.userId);
  localStorage.setItem(KEY_ONBOARDED, 'true');
  return completion.userId;
}

function isOnOnboardingRoute() {
  const hash = (window.location.hash || '').split('?')[0];
  return hash === '' || hash === '#' || hash === '#/';
}

function overlayIsVisible() {
  const overlay = document.getElementById('onboarding-overlay');
  return !!overlay && overlay.style.display !== 'none';
}

export function focusOnboardingContent(container) {
  const target = container?.querySelector?.('[data-onboarding-focus]');
  if (!target || typeof target.focus !== 'function') return false;
  target.focus({ preventScroll: true });
  return true;
}

function renderContent(html) {
  const container = document.getElementById('onboarding-content');
  if (!container) return;
  container.innerHTML = html;
  queueMicrotask(() => focusOnboardingContent(container));
}

function progress(step) {
  return `<p class="onboarding-step" aria-label="Step ${step} of 3">Step ${step} of 3</p>`;
}

function closeButton() {
  return '<button class="onb-close-x" data-action="onb-dismiss" type="button" aria-label="Dismiss onboarding">×</button>';
}

export function renderDataSourceScreen(state = initialOnboardingState()) {
  const sampleSelected = state.dataSource === 'sample';
  const connectSelected = state.dataSource === 'connect';
  return `
    ${closeButton()}
    ${progress(1)}
    <h1 id="onboarding-title" class="onboarding-title onboarding-voice" tabindex="-1" data-onboarding-focus>Start with a briefing</h1>
    <p class="onboarding-desc">Choose fictional sample data or sign in before connecting your own source.</p>
    <fieldset class="onboarding-options">
      <legend>What data should this briefing use?</legend>
      <label class="onboarding-option${sampleSelected ? ' is-selected' : ''}">
        <input type="radio" name="data-source" value="sample" ${sampleSelected ? 'checked' : ''}>
        <span><strong>Use the sample</strong><small>Fictional packaged data in a disposable, read-only session.</small></span>
      </label>
      <label class="onboarding-option${connectSelected ? ' is-selected' : ''}">
        <input type="radio" name="data-source" value="connect" ${connectSelected ? 'checked' : ''}>
        <span><strong>Connect my data</strong><small>${state.userId ? 'Continue with your signed-in profile, then choose a source.' : 'Sign in with Google first. New profiles begin in Just watch; returning profiles keep their current authority.'}</small></span>
      </label>
    </fieldset>
    <div class="onboarding-actions">
      <button class="btn btn-primary" type="button" data-action="onb-next" ${state.dataSource ? '' : 'disabled'}>Continue</button>
    </div>`;
}

function statusItem(label, value, detail) {
  return `<li><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></li>`;
}

export function renderReasoningScreen(state) {
  const sample = state.dataSource === 'sample';
  const notConfigured = state.reasoningMode === 'not_configured';
  const conventional = state.reasoningMode === 'bring_your_own_provider';
  return `
    ${closeButton()}
    ${progress(2)}
    <h1 id="onboarding-title" class="onboarding-title onboarding-voice" tabindex="-1" data-onboarding-focus>Choose where reasoning may run</h1>
    ${sample ? `
      <p class="onboarding-desc">The sample uses fixed deterministic results. It does not call a model provider.</p>
      <ul class="onboarding-status-list" aria-label="Sample reasoning status">
        ${statusItem('Reasoning', 'Deterministic sample', 'No provider request')}
        ${statusItem('External inference', 'None', 'The packaged sample uses fixed results through the local app service')}
      </ul>` : `
      <p class="onboarding-desc">This is a setup preference, not permission to send a prompt. Provider mode is saved only after sign-in; deciding later leaves your current settings unchanged.</p>
      <fieldset class="onboarding-options">
        <legend>Reasoning mode</legend>
        <label class="onboarding-option is-unavailable" aria-disabled="true">
          <input type="radio" name="reasoning-mode" value="on_device" disabled>
          <span><strong>On this device — unavailable</strong><small>No verified local model is installed by this setup flow yet.</small></span>
        </label>
        <label class="onboarding-option${conventional ? ' is-selected' : ''}">
          <input type="radio" name="reasoning-mode" value="bring_your_own_provider" ${conventional ? 'checked' : ''}>
          <span><strong>A provider I configure</strong><small>After sign-in, save provider mode. Prompts are sent only after you configure a provider; an external network connection and that provider's retention terms then apply. No confidential-computing guarantee is made.</small></span>
        </label>
        <label class="onboarding-option is-unavailable" aria-disabled="true">
          <input type="radio" name="reasoning-mode" value="verified_private_cloud" disabled>
          <span><strong>Verified private cloud — unavailable</strong><small>This requires a verifier-owned confidential adapter that is not available in this build.</small></span>
        </label>
        <label class="onboarding-option${notConfigured ? ' is-selected' : ''}">
          <input type="radio" name="reasoning-mode" value="not_configured" ${notConfigured ? 'checked' : ''}>
          <span><strong>Decide after connecting</strong><small>This preview makes no settings change. No model provider is configured or contacted during onboarding.</small></span>
        </label>
      </fieldset>`}
    <div class="onboarding-actions">
      <button class="btn btn-outline" type="button" data-action="onb-back">Back</button>
      <button class="btn btn-primary" type="button" data-action="onb-next" ${!sample && !state.reasoningMode ? 'disabled' : ''}>Continue</button>
    </div>`;
}

export function renderAutonomyScreen(state) {
  const sample = state.dataSource === 'sample';
  const signedIn = !!state.userId;
  return `
    ${closeButton()}
    ${progress(3)}
    <h1 id="onboarding-title" class="onboarding-title onboarding-voice" tabindex="-1" data-onboarding-focus>Choose the starting authority</h1>
    <p class="onboarding-desc">Every new profile starts in Just watch. Returning profiles keep their current authority after sign-in.</p>
    <fieldset class="onboarding-options">
      <legend>Initial autonomy</legend>
      <label class="onboarding-option is-selected">
        <input type="radio" name="autonomy" value="observer" checked>
        <span><strong>${sample || !signedIn ? 'Just watch for a new profile' : 'Current profile unchanged'}</strong><small>${sample ? 'The sample cannot write or execute anything.' : signedIn ? 'Onboarding does not change the authority of an existing signed-in profile.' : 'A new profile may observe and explain, but cannot write or execute actions.'}</small></span>
      </label>
    </fieldset>
    <div class="onboarding-authority" role="status">
      <span>${sample || !signedIn ? 'New-profile authority' : 'Authority change'}</span><strong>${sample || !signedIn ? 'Just watch' : 'None'}</strong><small>${sample || !signedIn ? 'Writes allowed: no' : 'Your current authority remains in effect'}</small>
    </div>
    <div class="onboarding-actions">
      <button class="btn btn-outline" type="button" data-action="onb-back">Back</button>
      <button class="btn btn-primary" type="button" data-action="onb-next">Review</button>
    </div>`;
}

export function renderCompleteScreen(state) {
  const sample = state.dataSource === 'sample';
  const reasoning = sample
    ? ['Deterministic sample', 'No external inference or provider request']
    : state.reasoningMode === 'bring_your_own_provider'
      ? ['Provider-mode preference', 'Saved only after authenticated sign-in; no provider or prompt is configured here']
      : ['Decide later', 'Preview only; onboarding will not change reasoning settings'];
  return `
    ${closeButton()}
    <h1 id="onboarding-title" class="onboarding-title onboarding-voice" tabindex="-1" data-onboarding-focus>Your starting boundaries</h1>
    <p class="onboarding-desc">Review these before continuing. You can revisit reasoning settings later.</p>
    <dl class="onboarding-summary">
      <div><dt>Data</dt><dd>${sample ? 'Fictional packaged sample' : 'Verified Google sign-in first; source connection next'}</dd></div>
      <div><dt>Reasoning</dt><dd>${escapeHtml(reasoning[0])}<small>${escapeHtml(reasoning[1])}</small></dd></div>
      <div><dt>Autonomy</dt><dd>${sample || !state.userId ? 'New profiles: Just watch' : 'Existing authority unchanged'}<small>${sample || !state.userId ? 'No write or execution authority' : 'Onboarding does not change your current tier'}</small></dd></div>
    </dl>
    <div class="onboarding-actions">
      <button class="btn btn-outline" type="button" data-action="onb-back">Back</button>
      <button class="btn btn-primary" type="button" data-action="onb-finish">${sample ? 'Open sample briefing' : state.userId ? 'Continue to connect' : 'Sign in with Google'}</button>
    </div>`;
}

export function renderErrorScreen(message) {
  return `
    ${closeButton()}
    <section class="onboarding-error-card" role="alert">
      <h1 id="onboarding-title" class="onboarding-title" tabindex="-1" data-onboarding-focus>Setup paused</h1>
      <p>${escapeHtml(message || 'This step could not be completed.')}</p>
      <button class="btn btn-outline" type="button" data-action="onb-retry">Retry</button>
    </section>`;
}

function renderConnectingScreen() {
  return `
    ${closeButton()}
    <section class="onboarding-connecting" role="status" aria-live="polite">
      <h1 id="onboarding-title" class="onboarding-title" tabindex="-1" data-onboarding-focus>Finish sign-in in your browser</h1>
      <p>SkyTwin is waiting for the verified sign-in. Your choices remain a preview until the authenticated handoff completes.</p>
    </section>`;
}

function renderScreen() {
  if (!_state) return;
  if (_state.screen === 'data_source') renderContent(renderDataSourceScreen(_state));
  else if (_state.screen === 'reasoning') renderContent(renderReasoningScreen(_state));
  else if (_state.screen === 'autonomy') renderContent(renderAutonomyScreen(_state));
  else if (_state.screen === 'complete') renderContent(renderCompleteScreen(_state));
  else if (_state.screen === 'connecting') renderContent(renderConnectingScreen());
  else renderContent(renderErrorScreen(_state.errorMessage));
}

function transition(screen) {
  if (!_state || !ONBOARDING_SCREENS.includes(screen)) return;
  _state.screen = screen;
  saveResumeState();
  renderScreen();
}

function fail(message, retryScreen) {
  if (!_state) return;
  _state.errorMessage = message;
  _state.retryScreen = retryScreen;
  transition('error');
}

function closeWizard() {
  clearResumeState();
  window.skyTwinHideOnboarding?.();
}

async function advance() {
  if (!_state) return;
  if (_state.screen === 'data_source') {
    if (!_state.dataSource) return;
    if (_state.dataSource === 'sample') _state.reasoningMode = null;
    transition('reasoning');
  } else if (_state.screen === 'reasoning') {
    if (_state.dataSource !== 'sample' && !_state.reasoningMode) return;
    transition('autonomy');
  } else if (_state.screen === 'autonomy') {
    _state.autonomy = 'observer';
    transition('complete');
  }
}

function goBack() {
  if (!_state) return;
  if (_state.screen === 'reasoning') transition('data_source');
  else if (_state.screen === 'autonomy') transition('reasoning');
  else if (_state.screen === 'complete') transition('autonomy');
}

async function finish() {
  if (!_state) return;
  if (_state.dataSource === 'sample') {
    try {
      const info = await fetchDemoInfo();
      if (!info?.available || !info.userId) throw new Error('The packaged sample is not ready.');
      const session = await startDemoSession();
      if (!session?.token || session.userId !== info.userId) throw new Error('The sample session could not be verified.');
      localStorage.setItem(KEY_TOUR_MODE, '1');
      localStorage.setItem(KEY_USER_ID, info.userId);
      localStorage.setItem(KEY_ONBOARDED, 'sample');
      try { localStorage.removeItem(KEY_ONBOARDING_RETURN_HASH); } catch { /* noop */ }
      closeWizard();
      _onComplete?.(info.userId);
      window.location.hash = '#/briefing';
    } catch (error) {
      fail(error?.friendlyMessage || error?.message || 'The packaged sample is not available.', 'complete');
    }
    return;
  }

  if (!savePendingReasoningChoice(_state.reasoningMode)) {
    fail('This browser could not preserve your reasoning preference for the authenticated handoff.', 'complete');
    return;
  }

  const finishAuthenticated = async (userId, sessionToken = null) => {
    if (sessionToken) localStorage.setItem(KEY_SESSION_TOKEN, sessionToken);
    localStorage.setItem(KEY_USER_ID, userId);
    _state.userId = userId;
    try {
      await applyPendingReasoningChoice(userId);
    } catch (error) {
      fail(
        error?.friendlyMessage || error?.message ||
          'You are signed in, but the reasoning preference could not be saved. Try again.',
        'complete',
      );
      return;
    }
    localStorage.setItem(KEY_ONBOARDED, 'true');
    const destination = consumeOnboardingReturnHash('#/connect-gmail');
    closeWizard();
    _onComplete?.(userId);
    window.location.hash = destination;
  };

  // A user who already has a verified local session can apply the preference
  // directly. Never infer identity from a typed email or a public user lookup.
  const existingUserId = currentUserId();
  let existingToken = '';
  try { existingToken = localStorage.getItem(KEY_SESSION_TOKEN) || ''; } catch { /* noop */ }
  if (existingUserId && existingToken) {
    await finishAuthenticated(existingUserId);
    return;
  }

  try {
    const result = await startGoogleSignIn({
      newUser: true,
      next: 'connect-gmail',
      onComplete: async (completion) => {
        if (!completion?.connected || !completion.userId || !completion.sessionToken) {
          fail('The verified sign-in did not complete. Try again.', 'complete');
          return;
        }
        await finishAuthenticated(completion.userId, completion.sessionToken);
      },
    });
    if (result.status === 'polling') {
      transition('connecting');
      return;
    }
    if (result.status === 'redirecting') return;
    fail(result.error || 'Google sign-in could not be started.', 'complete');
  } catch (error) {
    fail(error?.friendlyMessage || error?.message || 'Google sign-in could not be started.', 'complete');
  }
}

function handleChoice(event) {
  if (!_state || !isOnOnboardingRoute() || !overlayIsVisible()) return;
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  if (!input || input.type !== 'radio') return;
  if (input.name === 'data-source' && DATA_SOURCES.has(input.value)) {
    _state.dataSource = input.value;
    if (input.value === 'sample') {
      _state.reasoningMode = null;
    }
    saveResumeState();
    document.querySelectorAll('input[name="data-source"]').forEach((radio) => {
      radio.closest('.onboarding-option')?.classList.toggle('is-selected', radio === input);
    });
    const next = document.querySelector('[data-action="onb-next"]');
    if (next instanceof HTMLButtonElement) next.disabled = false;
  } else if (input.name === 'reasoning-mode' && REASONING_CHOICES.has(input.value)) {
    _state.reasoningMode = input.value;
    saveResumeState();
    document.querySelectorAll('input[name="reasoning-mode"]').forEach((radio) => {
      radio.closest('.onboarding-option')?.classList.toggle('is-selected', radio === input);
    });
    const next = document.querySelector('[data-action="onb-next"]');
    if (next instanceof HTMLButtonElement) next.disabled = false;
  }
}

async function handleClick(event) {
  if (!isOnOnboardingRoute() || !overlayIsVisible()) return;
  const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!target) return;
  const action = target.getAttribute('data-action');
  if (action === 'onb-next') await advance();
  else if (action === 'onb-back') goBack();
  else if (action === 'onb-finish') await finish();
  else if (action === 'onb-retry') transition(_state?.retryScreen || 'data_source');
  else if (action === 'onb-dismiss') window.skyTwinDismissOnboarding?.();
}

function ensureListeners() {
  if (_listenerWired || typeof document === 'undefined') return;
  _listenerWired = true;
  document.addEventListener('click', handleClick);
  document.addEventListener('change', handleChoice);
}

/** Entry point used by app.js. */
export async function renderOnboarding(_container, onComplete) {
  ensureListeners();
  _onComplete = onComplete;
  _state = readResumeState(currentUserId()) || initialOnboardingState(currentUserId());
  renderScreen();
}
