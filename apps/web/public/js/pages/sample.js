import {
  escapeHtml,
  fetchSampleSimulation,
  renderApiError,
  sendSampleSimulationCommand,
  startDemoSession,
} from '../api-client.js';
import { KEY_TOUR_MODE } from '../storage-keys.js';
import { skyTwinExitTour } from './dashboard-view.js';

let _sampleGlobalsWired = false;
let _sampleBusy = false;
let _sampleRenderGeneration = 0;
let _sampleOperationGeneration = 0;
let _sampleExitPending = false;

function beginSampleOperation() {
  if (_sampleBusy) return null;
  _sampleBusy = true;
  _sampleOperationGeneration += 1;
  return _sampleOperationGeneration;
}

function finishSampleOperation(operationGeneration) {
  if (operationGeneration === _sampleOperationGeneration) {
    _sampleBusy = false;
    return true;
  }
  return false;
}

function invalidateSampleOperations() {
  _sampleOperationGeneration += 1;
  _sampleBusy = false;
}

export function isSampleRenderCurrent(container, generation) {
  return (
    generation === _sampleRenderGeneration &&
    (window.location.hash || '').split('?')[0] === '#/sample' &&
    document.getElementById('page-content') === container
  );
}

function statusLabel(status) {
  return (
    {
      pending: 'Needs your decision',
      simulated_approved: 'Approved · simulated',
      simulated_rejected: 'Rejected · simulated',
      simulated_corrected: 'Corrected · learned locally',
      contained: 'Contained',
    }[status] || 'Simulation'
  );
}

function provenanceLabel(provenance) {
  return (
    {
      user_originated: 'From the fictional user',
      trusted_context: 'From sample preferences',
      untrusted_external: 'External and untrusted',
    }[provenance] || 'External and untrusted'
  );
}

function renderExplanation(explanation) {
  const evidence = Array.isArray(explanation?.evidence)
    ? explanation.evidence
    : [];
  const preferences = Array.isArray(explanation?.preferences)
    ? explanation.preferences
    : [];
  return `
    <details class="sample-explanation">
      <summary>Why this decision</summary>
      <div class="sample-explanation-body">
        <p>${escapeHtml(explanation?.summary || '')}</p>
        <dl class="sample-facts">
          <div><dt>Action reasoning</dt><dd>${escapeHtml(explanation?.actionRationale || '')}</dd></div>
          <div><dt>Confidence</dt><dd>${escapeHtml(explanation?.confidenceReasoning || '')}</dd></div>
          <div><dt>Risk</dt><dd>${escapeHtml(explanation?.riskTier || 'unknown')}</dd></div>
          ${explanation?.escalationRationale ? `<div><dt>Why approval</dt><dd>${escapeHtml(explanation.escalationRationale)}</dd></div>` : ''}
          <div><dt>How to correct</dt><dd class="sample-preline">${escapeHtml(explanation?.correctionGuidance || '')}</dd></div>
        </dl>
        ${evidence.length > 0 ? `<div class="sample-detail-group"><strong>Evidence</strong><ul>${evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
        ${preferences.length > 0 ? `<div class="sample-detail-group"><strong>Preferences applied</strong><ul>${preferences.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      </div>
    </details>
  `;
}

function renderActions(proposal) {
  const commands = Array.isArray(proposal.allowedCommands)
    ? proposal.allowedCommands
    : [];
  if (commands.length === 0) return '';
  return `
    <div class="sample-actions" aria-label="Simulation controls">
      ${commands.includes('approve') ? `<button class="btn btn-primary btn-sm" type="button" data-action="sample-command" data-command="approve" data-proposal-id="${escapeHtml(proposal.id)}">Approve in simulation</button>` : ''}
      ${commands.includes('reject') ? `<button class="btn btn-outline btn-sm" type="button" data-action="sample-command" data-command="reject" data-proposal-id="${escapeHtml(proposal.id)}">Reject</button>` : ''}
      ${commands.includes('correct') ? `<button class="btn btn-outline btn-sm" type="button" data-action="sample-command" data-command="correct" data-proposal-id="${escapeHtml(proposal.id)}" data-correction-id="prefer-afternoons">I prefer afternoons</button>` : ''}
    </div>
  `;
}

function renderProposal(proposal) {
  const contained = proposal.status === 'contained';
  const classes = ['sample-proposal'];
  if (contained) classes.push('sample-proposal-danger');
  if (proposal.status !== 'pending' && !contained)
    classes.push('sample-proposal-complete');
  return `
    <article class="${classes.join(' ')}" data-proposal-id="${escapeHtml(proposal.id)}" tabindex="-1">
      <div class="sample-proposal-head">
        <div>
          <div class="sample-eyebrow">Fictional proposal · simulation only</div>
          <h2>${escapeHtml(proposal.title)}</h2>
        </div>
        <span class="sample-status${contained ? ' sample-status-danger' : ''}">${escapeHtml(statusLabel(proposal.status))}</span>
      </div>
      <p class="sample-situation">${escapeHtml(proposal.situation)}</p>
      <div class="sample-recommendation">
        <span>Proposed</span>
        <strong>${escapeHtml(proposal.proposedAction)}</strong>
      </div>
      <dl class="sample-facts sample-facts-grid">
        <div><dt>Origin</dt><dd>${escapeHtml(provenanceLabel(proposal.provenance))}</dd></div>
        <div><dt>Cost</dt><dd>${proposal.estimatedCostCents === 0 ? '$0.00' : escapeHtml(String(proposal.estimatedCostCents)) + '¢'}</dd></div>
        <div><dt>Reversible</dt><dd>${proposal.reversible ? 'Yes' : 'No'}</dd></div>
        <div><dt>Confirmation</dt><dd>${escapeHtml(proposal.policy?.confirmationLevel || 'none')}</dd></div>
      </dl>
      <div class="sample-policy${contained ? ' sample-policy-danger' : ''}">
        <strong>${contained ? 'Safety boundary' : 'Policy outcome'}</strong>
        <span>${escapeHtml(proposal.policy?.reason || '')}</span>
        <small>${escapeHtml(proposal.provenanceNote || '')}</small>
      </div>
      ${proposal.resultMessage ? `<p class="sample-result" role="status">${escapeHtml(proposal.resultMessage)}</p>` : ''}
      ${renderActions(proposal)}
      ${renderExplanation(proposal.explanation)}
    </article>
  `;
}

export function renderSampleLoading() {
  return `
    <div class="sample-shell" data-sample-state="loading" aria-busy="true" aria-label="Loading sample decisions">
      <div class="sample-skeleton sample-skeleton-title"></div>
      <div class="sample-skeleton sample-skeleton-row"></div>
      <div class="sample-skeleton sample-skeleton-row"></div>
    </div>
  `;
}

export function renderSampleExpired() {
  return `
    <div class="sample-shell" data-sample-state="expired">
      <div class="card sample-state-card">
        <div class="sample-eyebrow">Sample session ended</div>
        <h2>This disposable sample has expired.</h2>
        <p>No learning was kept. Start a fresh sample to explore the decision loop again.</p>
        <button class="btn btn-primary" type="button" data-action="sample-restart">Start fresh sample</button>
      </div>
    </div>
  `;
}

export function renderSampleEmpty() {
  return `
    <div class="card sample-state-card" data-sample-state="cold-start">
      <div class="sample-eyebrow">Sample catalog unavailable</div>
      <h2>No fictional proposals are ready yet.</h2>
      <p>Reset the disposable sample to load its fixed decision catalog.</p>
      <button class="btn btn-outline" type="button" data-action="sample-reset">Reset sample</button>
    </div>
  `;
}

export function renderSampleState(state, notice = '') {
  const proposals = Array.isArray(state?.proposals) ? state.proposals : [];
  const learned = Array.isArray(state?.learning) && state.learning.length > 0;
  return `
    <main class="sample-shell" data-sample-state="populated">
      <header class="sample-hero">
        <div class="sample-eyebrow">Interactive sample · no external effects</div>
        <h1>Make the call. See what changes.</h1>
        <p>Review fictional proposals, correct one, and watch the next prediction adapt. Every command stays inside this disposable session.</p>
        <div class="sample-hero-actions">
          <button class="btn btn-outline btn-sm" type="button" data-action="sample-reset">Reset sample</button>
          <button class="btn btn-outline btn-sm" type="button" data-action="exit-tour">Start my own setup</button>
        </div>
      </header>
      ${notice ? `<p class="sample-reset-notice" role="status" tabindex="-1" data-sample-focus="reset">${escapeHtml(notice)}</p>` : ''}
      <section class="sample-prediction${learned ? ' sample-prediction-learned' : ''}" aria-live="polite">
        <div class="sample-eyebrow">${escapeHtml(state?.nextPrediction?.label || 'Next fictional prediction')}</div>
        <strong>${escapeHtml(state?.nextPrediction?.proposedAction || '')}</strong>
        <span>${learned ? 'Changed by your session-local correction.' : 'Correct the focus-time proposal to teach this sample.'}</span>
      </section>
      ${
        proposals.length > 0
          ? `<section class="sample-proposals" aria-label="Fictional proposals">${proposals.map(renderProposal).join('')}</section>`
          : renderSampleEmpty()
      }
    </main>
  `;
}

export function renderSampleError(error) {
  if (error?.kind === 'auth' || error?.kind === 'not-found') {
    return renderSampleExpired();
  }
  return `
    <div class="sample-shell" data-sample-state="error">
      ${renderApiError(error, { retry: true, context: 'The disposable sample could not be loaded.' })}
    </div>
  `;
}

function renderSampleFailure(container, error) {
  container.innerHTML = renderSampleError(error);
}

/** Announce asynchronous sample work and expose its busy state to AT. */
export function setSampleOperationPending(
  container,
  pending,
  message = 'Updating the disposable simulation…',
) {
  const shell = container?.querySelector?.('.sample-shell');
  if (!shell) return;
  if (!pending) {
    shell.removeAttribute('aria-busy');
    shell.querySelector('[data-sample-operation-status]')?.remove();
    shell
      .querySelectorAll(
        '[data-action="sample-command"], [data-action="sample-reset"], [data-action="sample-restart"], [data-action="api-retry"]',
      )
      .forEach((button) => {
        button.disabled = false;
      });
    return;
  }
  shell.setAttribute('aria-busy', 'true');
  shell
    .querySelectorAll(
      '[data-action="sample-command"], [data-action="sample-reset"], [data-action="sample-restart"], [data-action="api-retry"]',
    )
    .forEach((button) => {
      button.disabled = true;
    });
  let status = shell.querySelector('[data-sample-operation-status]');
  if (!status) {
    status = document.createElement('p');
    status.className = 'sample-operation-status';
    status.setAttribute('data-sample-operation-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    shell.prepend(status);
  }
  status.textContent = message;
}

/** Restore keyboard context after the sample replaces its page markup. */
export function focusSampleResult(container, proposalId = null) {
  let target = null;
  if (proposalId) {
    target = Array.from(
      container.querySelectorAll('.sample-proposal[data-proposal-id]'),
    ).find(
      (candidate) => candidate.getAttribute('data-proposal-id') === proposalId,
    );
  } else {
    target = container.querySelector('[data-sample-focus="reset"]');
  }
  if (!target || typeof target.focus !== 'function') return false;
  target.focus({ preventScroll: true });
  return true;
}

async function loadInto(container, generation) {
  container.innerHTML = renderSampleLoading();
  try {
    const state = await fetchSampleSimulation();
    if (isSampleRenderCurrent(container, generation)) {
      container.innerHTML = renderSampleState(state);
    }
  } catch (error) {
    if (isSampleRenderCurrent(container, generation)) {
      renderSampleFailure(container, error);
    }
  }
}

export async function renderSample(container) {
  const generation = ++_sampleRenderGeneration;
  invalidateSampleOperations();
  _sampleExitPending = false;
  if (localStorage.getItem(KEY_TOUR_MODE) !== '1') {
    container.innerHTML = `
      <div class="sample-shell"><div class="card sample-state-card">
        <h2>This sample is available in tour mode.</h2>
        <p>Start from the welcome screen to create a disposable sample session.</p>
        <a class="btn btn-primary" href="#/setup">Open setup</a>
      </div></div>
    `;
    return;
  }
  await loadInto(container, generation);
}

async function runCommand(element) {
  const container = document.getElementById('page-content');
  if (!container) return;
  const generation = _sampleRenderGeneration;
  const command = element.getAttribute('data-command');
  const proposalId = element.getAttribute('data-proposal-id');
  if (!command || !proposalId) return;
  const payload = { type: command, proposalId };
  const correctionId = element.getAttribute('data-correction-id');
  if (correctionId) payload.correctionId = correctionId;
  const operationGeneration = beginSampleOperation();
  if (operationGeneration === null) return;
  setSampleOperationPending(
    container,
    true,
    'Applying this choice in the disposable simulation…',
  );
  try {
    const state = await sendSampleSimulationCommand(payload);
    if (isSampleRenderCurrent(container, generation)) {
      container.innerHTML = renderSampleState(state);
      focusSampleResult(container, proposalId);
    }
  } catch (error) {
    if (isSampleRenderCurrent(container, generation)) {
      renderSampleFailure(container, error);
    }
  } finally {
    if (
      finishSampleOperation(operationGeneration) &&
      isSampleRenderCurrent(container, generation)
    ) {
      setSampleOperationPending(container, false);
    }
  }
}

export function initSampleGlobals() {
  if (typeof document === 'undefined' || _sampleGlobalsWired) return;
  _sampleGlobalsWired = true;
  document.addEventListener('click', async (event) => {
    if ((window.location.hash || '').split('?')[0] !== '#/sample') return;
    const target =
      event.target instanceof Element
        ? event.target.closest('[data-action]')
        : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'sample-command') {
      await runCommand(target);
    } else if (action === 'sample-reset') {
      const operationGeneration = beginSampleOperation();
      if (operationGeneration === null) return;
      const container = document.getElementById('page-content');
      const generation = _sampleRenderGeneration;
      if (container) {
        setSampleOperationPending(
          container,
          true,
          'Resetting the disposable simulation…',
        );
      }
      try {
        const state = await sendSampleSimulationCommand({ type: 'reset' });
        if (container && isSampleRenderCurrent(container, generation)) {
          container.innerHTML = renderSampleState(
            state,
            'Sample reset. Session-local learning was removed.',
          );
          focusSampleResult(container);
        }
      } catch (error) {
        if (container && isSampleRenderCurrent(container, generation)) {
          renderSampleFailure(container, error);
        }
      } finally {
        if (
          container &&
          finishSampleOperation(operationGeneration) &&
          isSampleRenderCurrent(container, generation)
        ) {
          setSampleOperationPending(container, false);
        }
      }
    } else if (action === 'sample-restart') {
      const operationGeneration = beginSampleOperation();
      if (operationGeneration === null) return;
      const container = document.getElementById('page-content');
      if (!container) {
        finishSampleOperation(operationGeneration);
        return;
      }
      const generation = ++_sampleRenderGeneration;
      container.innerHTML = renderSampleLoading();
      setSampleOperationPending(
        container,
        true,
        'Starting a fresh disposable sample…',
      );
      try {
        await startDemoSession();
        if (isSampleRenderCurrent(container, generation)) {
          await loadInto(container, generation);
        }
      } catch (error) {
        if (isSampleRenderCurrent(container, generation)) {
          renderSampleFailure(container, error);
        }
      } finally {
        if (
          finishSampleOperation(operationGeneration) &&
          isSampleRenderCurrent(container, generation)
        ) {
          setSampleOperationPending(container, false);
        }
      }
    } else if (action === 'api-retry') {
      const operationGeneration = beginSampleOperation();
      if (operationGeneration === null) return;
      const container = document.getElementById('page-content');
      try {
        if (container) {
          const generation = ++_sampleRenderGeneration;
          await loadInto(container, generation);
        }
      } finally {
        if (
          container &&
          finishSampleOperation(operationGeneration) &&
          isSampleRenderCurrent(container, _sampleRenderGeneration)
        ) {
          setSampleOperationPending(container, false);
        }
      }
    } else if (action === 'exit-tour') {
      if (
        !_sampleExitPending &&
        localStorage.getItem(KEY_TOUR_MODE) === '1'
      ) {
        _sampleExitPending = true;
        _sampleRenderGeneration += 1;
        invalidateSampleOperations();
        _sampleBusy = true;
        await skyTwinExitTour();
      }
    }
  });
}
