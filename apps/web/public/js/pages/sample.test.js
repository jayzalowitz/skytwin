// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
} from '../storage-keys.js';
import { skyTwinExitTour } from './dashboard-view.js';
import {
  renderSampleEmpty,
  renderSampleError,
  renderSampleExpired,
  renderSampleLoading,
  renderSampleState,
  isSampleRenderCurrent,
  focusSampleResult,
  setSampleOperationPending,
} from './sample.js';

function proposal(overrides = {}) {
  return {
    id: 'calendar-focus',
    title: 'Protect a focus block',
    situation: 'A fictional conflict.',
    proposedAction: 'Decline and suggest another time.',
    status: 'pending',
    provenance: 'user_originated',
    provenanceNote: 'Fixed fictional source.',
    estimatedCostCents: 0,
    reversible: false,
    policy: {
      reason: 'Observer mode requires approval.',
      confirmationLevel: 'single',
    },
    explanation: {
      summary: 'A complete fictional explanation.',
      evidence: ['Original sample signal — primary trigger.'],
      preferences: [],
      confidenceReasoning: 'High confidence from fixed evidence.',
      actionRationale: 'Selected from the fixed catalog.',
      escalationRationale: 'Observer mode requires approval.',
      correctionGuidance: 'Approve, reject, or correct.',
      riskTier: 'moderate',
    },
    allowedCommands: ['approve', 'reject'],
    resultMessage: null,
    simulationOnly: true,
    externalEffects: false,
    ...overrides,
  };
}

function state(proposals = [proposal()], overrides = {}) {
  return {
    mode: 'simulation',
    sessionIsolated: true,
    revision: 0,
    proposals,
    learning: [],
    nextPrediction: {
      label: 'Next fictional prediction',
      proposedAction: 'Suggest 9:00–10:30 AM.',
      changedByLearning: false,
    },
    ...overrides,
  };
}

describe('interactive sample page states', () => {
  it('renders a reduced-motion-safe loading skeleton', () => {
    const html = renderSampleLoading();
    expect(html).toContain('data-sample-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('sample-skeleton');
  });

  it('renders the simulation label and complete decision facts', () => {
    const html = renderSampleState(state());
    expect(html).toContain('Interactive sample · no external effects');
    expect(html).toContain('Fictional proposal · simulation only');
    expect(html).toContain('Origin');
    expect(html).toContain('Cost');
    expect(html).toContain('Reversible');
    expect(html).toContain('Confirmation');
    expect(html).toContain('Policy outcome');
    expect(html).toContain('Why this decision');
    expect(html).toContain('Approve in simulation');
    expect(html).toContain('Reject');
  });

  it('shows learned prediction changes and the correction control', () => {
    const html = renderSampleState(
      state(
        [
          proposal({
            id: 'focus-time-preference',
            allowedCommands: ['approve', 'reject', 'correct'],
          }),
        ],
        {
          learning: [
            {
              key: 'preferred_focus_window',
              value: 'afternoon',
              source: 'corrected',
            },
          ],
          nextPrediction: {
            label: 'Next fictional prediction',
            proposedAction: 'Suggest 2:00–3:30 PM.',
            changedByLearning: true,
          },
        },
      ),
    );
    expect(html).toContain('I prefer afternoons');
    expect(html).toContain('Changed by your session-local correction');
    expect(html).toContain('2:00–3:30 PM');
  });

  it('renders untrusted containment as danger with no command', () => {
    const html = renderSampleState(
      state([
        proposal({
          id: 'untrusted-document',
          title: 'External instruction contained',
          status: 'contained',
          provenance: 'untrusted_external',
          provenanceNote: 'Provenance was missing and failed safe.',
          policy: {
            reason: 'Injection guard requires two confirmations.',
            confirmationLevel: 'dual',
          },
          allowedCommands: [],
          resultMessage: 'Contained. No approval path.',
        }),
      ]),
    );
    expect(html).toContain('sample-proposal-danger');
    expect(html).toContain('External and untrusted');
    expect(html).toContain('Safety boundary');
    expect(html).toContain('Contained. No approval path.');
    expect(html).not.toContain('data-action="sample-command"');
  });

  it('renders explicit cold-start and expired-session recovery states', () => {
    expect(renderSampleState(state([]))).toContain(
      'data-sample-state="cold-start"',
    );
    expect(renderSampleEmpty()).toContain('Reset sample');
    expect(renderSampleExpired()).toContain('No learning was kept');
    expect(renderSampleExpired()).toContain('Start fresh sample');
    expect(renderSampleExpired()).toContain('data-sample-state="expired"');
  });

  it('renders a contained error card with retry and a reset confirmation state', () => {
    const error = renderSampleError({
      kind: 'server',
      friendlyMessage: 'Something went wrong on our end. Please try again.',
    });
    expect(error).toContain('data-sample-state="error"');
    expect(error).toContain('data-action="api-retry"');
    const reset = renderSampleState(
      state(),
      'Sample reset. Session-local learning was removed.',
    );
    expect(reset).toContain('role="status"');
    expect(reset).toContain('Session-local learning was removed');
  });

  it('escapes catalog content and never emits inline event handlers', () => {
    const html = renderSampleState(
      state([proposal({ title: '<img src=x onerror=alert(1)>' })]),
    );
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    for (const tag of html.match(/<[^>]+>/g) || []) {
      expect(tag).not.toMatch(/\son(?:click|keydown|error)=/i);
    }
  });

  it('uses one hash-gated delegated listener and designed error/reset paths', () => {
    const source = readFileSync(
      new URL('./sample.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("!== '#/sample'");
    expect(source).toContain('_sampleGlobalsWired');
    expect(source).toContain('_sampleOperationGeneration');
    expect(source).toContain('finishSampleOperation(operationGeneration)');
    expect(source).toContain('renderApiError');
    expect(source).toContain("{ type: 'reset' }");
    expect(
      source.match(/isSampleRenderCurrent/g)?.length,
    ).toBeGreaterThanOrEqual(7);
    expect(source).not.toMatch(/onclick\s*=/i);
  });

  it('refuses post-await writes after navigation leaves the sample route', () => {
    window.location.hash = '#/settings';
    expect(isSampleRenderCurrent({}, 0)).toBe(false);
  });

  it('restores keyboard focus to the decided proposal or reset notice', () => {
    const proposalFocus = vi.fn();
    const resetFocus = vi.fn();
    const proposalNode = {
      getAttribute: (name) =>
        name === 'data-proposal-id' ? 'calendar-focus' : null,
      focus: proposalFocus,
    };
    const container = {
      querySelectorAll: () => [proposalNode],
      querySelector: () => ({ focus: resetFocus }),
    };

    expect(focusSampleResult(container, 'calendar-focus')).toBe(true);
    expect(proposalFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusSampleResult(container)).toBe(true);
    expect(resetFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('announces pending operations and exposes the page busy state', () => {
    const attributes = new Map();
    const buttons = [{ disabled: false }, { disabled: false }];
    let operationStatus = null;
    const shell = {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
      getAttribute: (key) => attributes.get(key) ?? null,
      hasAttribute: (key) => attributes.has(key),
      querySelector: () => operationStatus,
      querySelectorAll: () => buttons,
      prepend: (node) => {
        operationStatus = node;
      },
    };
    const container = {
      querySelector: (selector) =>
        selector === '.sample-shell' ? shell : operationStatus,
      querySelectorAll: () => buttons,
    };
    const statusAttributes = new Map();
    const statusNode = {
      className: '',
      textContent: '',
      setAttribute: (key, value) => statusAttributes.set(key, value),
      getAttribute: (key) => statusAttributes.get(key) ?? null,
      remove: () => {
        operationStatus = null;
      },
    };
    vi.spyOn(document, 'createElement').mockReturnValue(statusNode);

    setSampleOperationPending(container, true, 'Applying sample choice…');

    expect(shell.getAttribute('aria-busy')).toBe('true');
    expect(statusNode.getAttribute('role')).toBe('status');
    expect(statusNode.getAttribute('aria-live')).toBe('polite');
    expect(statusNode.textContent).toBe('Applying sample choice…');
    expect(buttons.every((button) => button.disabled)).toBe(true);

    setSampleOperationPending(container, false);
    expect(shell.hasAttribute('aria-busy')).toBe(false);
    expect(operationStatus).toBeNull();
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it('discards server state before removing all sample credentials on exit', async () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
    });
    localStorage.setItem(KEY_SESSION_TOKEN, 'sample-token');
    localStorage.setItem(
      KEY_DEMO_SESSION_EXPIRES_AT,
      '2030-01-01T00:00:00.000Z',
    );
    localStorage.setItem(KEY_TOUR_MODE, '1');
    localStorage.setItem(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    window.location.reload = vi.fn();

    await skyTwinExitTour();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/demo/simulation',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer sample-token',
        }),
      }),
    );
    expect(localStorage.getItem(KEY_SESSION_TOKEN)).toBeNull();
    expect(localStorage.getItem(KEY_DEMO_SESSION_EXPIRES_AT)).toBeNull();
    expect(localStorage.getItem(KEY_TOUR_MODE)).toBeNull();
    expect(localStorage.getItem(KEY_USER_ID)).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
