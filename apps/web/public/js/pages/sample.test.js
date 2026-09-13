// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  KEY_DEMO_SESSION_EXPIRES_AT,
  KEY_ONBOARDED,
  KEY_SESSION_TOKEN,
  KEY_TOUR_MODE,
  KEY_USER_ID,
} from '../storage-keys.js';
import { setTourExitPending, skyTwinExitTour } from './dashboard-view.js';
import { cancelDemoSessionExit, startDemoSession } from '../api-client.js';
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

  it('announces and disables the dashboard exit while discard is pending', () => {
    const attributes = new Map();
    const button = { disabled: false };
    let operationStatus = null;
    const region = {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
      querySelector: (selector) =>
        selector === '[data-action="exit-tour"]' ? button : operationStatus,
      append: (node) => {
        operationStatus = node;
      },
    };
    const trigger = { closest: () => region };
    const statusAttributes = new Map();
    const statusNode = {
      className: '',
      textContent: '',
      setAttribute: (key, value) => statusAttributes.set(key, value),
      remove: () => {
        operationStatus = null;
      },
    };
    vi.spyOn(document, 'createElement').mockReturnValue(statusNode);

    setTourExitPending(trigger, true);

    expect(attributes.get('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    expect(statusAttributes.get('role')).toBe('status');
    expect(statusAttributes.get('aria-live')).toBe('polite');
    expect(statusNode.textContent).toMatch(/discarding/i);

    setTourExitPending(trigger, false);
    expect(attributes.has('aria-busy')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(operationStatus).toBeNull();
  });

  it('discards server state before removing all sample credentials on exit', async () => {
    const values = new Map();
    const sampleValues = new Map();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (key) => sampleValues.get(key) ?? null,
      setItem: (key, value) => sampleValues.set(key, String(value)),
      removeItem: (key) => sampleValues.delete(key),
    });
    sessionStorage.setItem(KEY_SESSION_TOKEN, 'sample-token');
    sessionStorage.setItem(
      KEY_DEMO_SESSION_EXPIRES_AT,
      '2030-01-01T00:00:00.000Z',
    );
    sessionStorage.setItem(KEY_TOUR_MODE, '1');
    sessionStorage.setItem(KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    window.location.reload = vi.fn();

    await expect(skyTwinExitTour()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/demo/simulation',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer sample-token',
        }),
      }),
    );
    expect(sessionStorage.getItem(KEY_SESSION_TOKEN)).toBeNull();
    expect(sessionStorage.getItem(KEY_DEMO_SESSION_EXPIRES_AT)).toBeNull();
    expect(sessionStorage.getItem(KEY_TOUR_MODE)).toBeNull();
    expect(sessionStorage.getItem(KEY_USER_ID)).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('preserves a newer real login that wins while sample discard is pending', async () => {
    const demoUserId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const realUserId = '11111111-2222-4333-8444-555555555555';
    const values = new Map();
    const sampleValues = new Map();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (key) => sampleValues.get(key) ?? null,
      setItem: (key, value) => sampleValues.set(key, String(value)),
      removeItem: (key) => sampleValues.delete(key),
    });
    sessionStorage.setItem(KEY_SESSION_TOKEN, 'sample-token');
    sessionStorage.setItem(
      KEY_DEMO_SESSION_EXPIRES_AT,
      '2030-01-01T00:00:00.000Z',
    );
    sessionStorage.setItem(KEY_TOUR_MODE, '1');
    sessionStorage.setItem(KEY_USER_ID, demoUserId);
    localStorage.setItem(`skytwin_last_visit_${demoUserId}`, 'sample-only');

    let resolveDiscard;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveDiscard = resolve;
          }),
      ),
    );
    window.location.reload = vi.fn();
    const exiting = skyTwinExitTour();

    localStorage.setItem(KEY_SESSION_TOKEN, 'real-session-token');
    localStorage.setItem(KEY_USER_ID, realUserId);
    localStorage.setItem(KEY_ONBOARDED, 'true');
    localStorage.setItem(`skytwin_last_visit_${realUserId}`, 'real-state');
    resolveDiscard(new Response(null, { status: 204 }));

    await expect(exiting).resolves.toBe(true);
    expect(localStorage.getItem(KEY_SESSION_TOKEN)).toBe('real-session-token');
    expect(localStorage.getItem(KEY_USER_ID)).toBe(realUserId);
    expect(localStorage.getItem(KEY_ONBOARDED)).toBe('true');
    expect(sessionStorage.getItem(KEY_SESSION_TOKEN)).toBeNull();
    expect(localStorage.getItem(`skytwin_last_visit_${realUserId}`)).toBe(
      'real-state',
    );
    expect(localStorage.getItem(`skytwin_last_visit_${demoUserId}`)).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  for (const winner of ['exit', 'renewal']) {
    it(`does not recreate sample state when ${winner} resolves first during renewal and exit`, async () => {
      const demoUserId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
      const values = new Map();
      const sampleValues = new Map([
        [KEY_SESSION_TOKEN, 'old-sample-token'],
        [KEY_DEMO_SESSION_EXPIRES_AT, '2020-01-01T00:00:00.000Z'],
        [KEY_TOUR_MODE, '1'],
        [KEY_USER_ID, demoUserId],
      ]);
      vi.stubGlobal('localStorage', {
        get length() { return values.size; },
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
        key: (index) => [...values.keys()][index] ?? null,
      });
      vi.stubGlobal('sessionStorage', {
        getItem: (key) => sampleValues.get(key) ?? null,
        setItem: (key, value) => sampleValues.set(key, String(value)),
        removeItem: (key) => sampleValues.delete(key),
      });
      let resolveRenewal;
      let resolveOldDiscard;
      const fetchMock = vi.fn((url, options = {}) => {
        if (options.method === 'POST') {
          return new Promise((resolve) => { resolveRenewal = resolve; });
        }
        if (options.headers?.Authorization === 'Bearer old-sample-token') {
          if (winner === 'exit') return Promise.resolve(new Response(null, { status: 204 }));
          return new Promise((resolve) => { resolveOldDiscard = resolve; });
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      window.location.reload = vi.fn();

      cancelDemoSessionExit();
      const renewing = startDemoSession();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const exiting = skyTwinExitTour();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      if (winner === 'exit') await exiting;
      resolveRenewal(new Response(JSON.stringify({
        token: 'late-sample-token',
        userId: demoUserId,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
      await expect(renewing).rejects.toThrow(/changed/i);
      if (winner === 'renewal') {
        resolveOldDiscard(new Response(null, { status: 204 }));
        await exiting;
      }
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      expect(sampleValues.has(KEY_SESSION_TOKEN)).toBe(false);
      expect(sampleValues.has(KEY_TOUR_MODE)).toBe(false);
      expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(
        'Bearer late-sample-token',
      );
      cancelDemoSessionExit();
      vi.unstubAllGlobals();
    });
  }

  it('keeps the sample credential and browser state when disposal is unconfirmed', async () => {
    const demoUserId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const values = new Map();
    const sampleValues = new Map();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (key) => sampleValues.get(key) ?? null,
      setItem: (key, value) => sampleValues.set(key, String(value)),
      removeItem: (key) => sampleValues.delete(key),
    });
    sessionStorage.setItem(KEY_SESSION_TOKEN, 'sample-token');
    sessionStorage.setItem(
      KEY_DEMO_SESSION_EXPIRES_AT,
      '2030-01-01T00:00:00.000Z',
    );
    sessionStorage.setItem(KEY_TOUR_MODE, '1');
    sessionStorage.setItem(KEY_USER_ID, demoUserId);
    localStorage.setItem(`skytwin_last_visit_${demoUserId}`, 'sample-state');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    window.location.reload = vi.fn();

    await expect(skyTwinExitTour()).resolves.toBe(false);

    expect(sessionStorage.getItem(KEY_SESSION_TOKEN)).toBe('sample-token');
    expect(sessionStorage.getItem(KEY_USER_ID)).toBe(demoUserId);
    expect(sessionStorage.getItem(KEY_TOUR_MODE)).toBe('1');
    expect(localStorage.getItem(`skytwin_last_visit_${demoUserId}`)).toBe(
      'sample-state',
    );
    expect(window.location.reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('leaves sample mode when its disposable credential is already absent', async () => {
    const values = new Map();
    const sampleValues = new Map([
      [KEY_TOUR_MODE, '1'],
      [KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
    ]);
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (key) => sampleValues.get(key) ?? null,
      setItem: (key, value) => sampleValues.set(key, String(value)),
      removeItem: (key) => sampleValues.delete(key),
    });
    vi.stubGlobal('fetch', vi.fn());
    window.location.reload = vi.fn();

    await expect(skyTwinExitTour()).resolves.toBe(true);

    expect(fetch).not.toHaveBeenCalled();
    expect(sampleValues.size).toBe(0);
    expect(window.location.reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('leaves sample mode when the server proves its credential is unusable', async () => {
    const values = new Map();
    const sampleValues = new Map([
      [KEY_SESSION_TOKEN, 'invalid-sample-token'],
      [KEY_DEMO_SESSION_EXPIRES_AT, '2030-01-01T00:00:00.000Z'],
      [KEY_TOUR_MODE, '1'],
      [KEY_USER_ID, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
    ]);
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (key) => sampleValues.get(key) ?? null,
      setItem: (key, value) => sampleValues.set(key, String(value)),
      removeItem: (key) => sampleValues.delete(key),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sample session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    window.location.reload = vi.fn();

    await expect(skyTwinExitTour()).resolves.toBe(true);

    expect(sampleValues.size).toBe(0);
    expect(window.location.reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
