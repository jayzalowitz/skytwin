// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchHealth: vi.fn(),
  fetchDecisions: vi.fn(),
  fetchAccuracy: vi.fn(),
  fetchConfidence: vi.fn(),
  fetchLearning: vi.fn(),
  fetchPendingApprovals: vi.fn(),
  fetchSkillGaps: vi.fn(),
  fetchTrustProgress: vi.fn(),
  fetchLearned: vi.fn(),
  fetchUnmetCredentials: vi.fn(),
  fetchOAuthStatus: vi.fn(),
  fetchCredentialsStatus: vi.fn(),
  fetchBriefing: vi.fn(),
  fetchLatestTwinBriefing: vi.fn(),
  fetchLifebooks: vi.fn(),
  fetchSettings: vi.fn(),
}));

const sample = vi.hoisted(() => ({
  isSampleMode: vi.fn(),
}));

const view = vi.hoisted(() => ({
  renderUnmetCredentials: vi.fn(() => ''),
}));

vi.mock('../api-client.js', () => ({
  ...api,
  escapeHtml: (value) => String(value ?? ''),
}));

vi.mock('../sample-session.js', () => ({
  getEffectiveUserId: () => '',
  isSampleMode: sample.isSampleMode,
}));

vi.mock('../components/progress-bar.js', () => ({
  renderTrustProgress: () => '',
}));

vi.mock('../components/tier-ladder-intro.js', () => ({
  renderTierLadderIntro: () => '',
}));

vi.mock('./dashboard-view.js', () => ({
  renderNotificationOptIn: () => '',
  renderBriefingCard: () => '',
  renderSinceLastVisit: () => '',
  renderEmptyDashboardPreview: () => '',
  renderAskTwinWidget: () => '',
  hydrateRecipeLibrary: vi.fn().mockResolvedValue(undefined),
  renderTourBanner: () => '',
  renderJustConnectedCelebration: () => '',
  renderConnectGoogleHero: () => '',
  renderConnectGmailHero: () => '',
  renderUnmetCredentials: view.renderUnmetCredentials,
  renderSkillGaps: () => '',
  situationLabel: (value) => String(value ?? ''),
  domainLabel: (value) => String(value ?? ''),
  domainIcon: () => '',
  traitLabel: (value) => String(value ?? ''),
  traitIcon: () => '',
  formatTime: () => '',
}));

import { invalidateDashboardCache, renderDashboard } from './dashboard.js';

function arrangeDashboardResponses() {
  api.fetchHealth.mockResolvedValue({ status: 'ok' });
  api.fetchAccuracy.mockResolvedValue({ totalDecisions: 0 });
  api.fetchConfidence.mockResolvedValue({ overallConfidence: 0, domains: {} });
  api.fetchLearning.mockResolvedValue({ totalPreferences: 0, totalPatterns: 0, traits: [] });
  api.fetchPendingApprovals.mockResolvedValue({ approvals: [] });
  api.fetchDecisions.mockResolvedValue({ decisions: [] });
  api.fetchSkillGaps.mockResolvedValue({ skillGaps: [] });
  api.fetchTrustProgress.mockResolvedValue(null);
  api.fetchLearned.mockResolvedValue({ summaries: [] });
  api.fetchUnmetCredentials.mockResolvedValue({ unmet: [] });
  api.fetchOAuthStatus.mockResolvedValue({ connected: false, scopes: [] });
  api.fetchCredentialsStatus.mockResolvedValue({ google: { configured: false } });
  api.fetchBriefing.mockResolvedValue({ briefing: null });
  api.fetchLatestTwinBriefing.mockResolvedValue({ briefing: null });
  api.fetchLifebooks.mockResolvedValue({ lifebooks: [] });
  api.fetchSettings.mockResolvedValue({ aiProviders: [{ provider: 'embedded', enabled: true }] });
}

describe('dashboard sample credential boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateDashboardCache();
    arrangeDashboardResponses();
    document.body.innerHTML = '<main id="page-content"></main>';
    window.location.hash = '#/';
    localStorage.clear();
  });

  it('does not request account credential state for the isolated sample', async () => {
    sample.isSampleMode.mockReturnValue(true);

    await renderDashboard(document.getElementById('page-content'), 'sample-user');

    expect(api.fetchUnmetCredentials).not.toHaveBeenCalled();
    expect(api.fetchOAuthStatus).not.toHaveBeenCalled();
    expect(api.fetchCredentialsStatus).not.toHaveBeenCalled();
    expect(view.renderUnmetCredentials).toHaveBeenCalledWith({
      status: 'fulfilled',
      value: { unmet: [] },
    });
  });

  it('continues requesting credential state for a real user', async () => {
    sample.isSampleMode.mockReturnValue(false);
    const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await renderDashboard(document.getElementById('page-content'), userId);

    expect(api.fetchUnmetCredentials).toHaveBeenCalledOnce();
    expect(api.fetchOAuthStatus).toHaveBeenCalledWith(userId, 'google');
    expect(api.fetchCredentialsStatus).toHaveBeenCalledOnce();
  });
});
