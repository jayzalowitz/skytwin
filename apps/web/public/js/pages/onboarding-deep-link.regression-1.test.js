// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchDemoInfo: vi.fn(),
  fetchLocalModelRecommendation: vi.fn(),
}));

vi.mock('../api-client.js', () => ({
  createUser: vi.fn(),
  fetchJSON: vi.fn(),
  fetchDemoInfo: api.fetchDemoInfo,
  startDemoSession: vi.fn(),
  previewDemoDecision: vi.fn(),
  fetchOnboardingState: vi.fn(),
  postOnboardingDialogue: vi.fn(),
  postDeterministicPick: vi.fn(),
  postOnboardingComplete: vi.fn(),
  installCapabilityRecipe: vi.fn(),
  fetchCapabilityDependencyGraph: vi.fn(),
  fetchLocalModelRecommendation: api.fetchLocalModelRecommendation,
  escapeHtml: (value) => String(value),
}));

vi.mock('../sample-session.js', () => ({
  getEffectiveUserId: () => '',
  isSampleMode: () => false,
}));

import { invalidateOnboardingRun, renderOnboarding } from './onboarding.js';

describe('onboarding deep-link actions', () => {
  beforeEach(() => {
    localStorage.clear();
    api.fetchDemoInfo.mockResolvedValue({ available: true, userId: 'sample-user' });
    api.fetchLocalModelRecommendation.mockResolvedValue({});
    window.location.hash = '#/watches';
    document.body.innerHTML = `
      <div id="onboarding-overlay" style="display:flex">
        <div id="onboarding-content"></div>
        <div id="onb-wizard-status"></div>
      </div>
    `;
    vi.stubGlobal('requestAnimationFrame', (callback) => callback());
  });

  afterEach(() => {
    invalidateOnboardingRun();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Regression: ISSUE-001 — first-run controls were inert over #/watches
  // Found by /qa on 2026-09-16
  // Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-09-16.md
  it('dismisses the visible onboarding modal without discarding the deep link', async () => {
    const dismiss = vi.fn(() => {
      document.getElementById('onboarding-overlay').style.display = 'none';
    });
    window.skyTwinDismissOnboarding = dismiss;

    await renderOnboarding(document.getElementById('onboarding-content'), vi.fn());
    document.querySelector('[data-action="onb-dismiss-modal"]').click();

    expect(dismiss).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('#/watches');
    expect(document.getElementById('onboarding-overlay').style.display).toBe('none');
  });
});
