// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchUser: vi.fn(), fetchOAuthStatus: vi.fn(), fetchSettings: vi.fn(),
  fetchSessions: vi.fn(), fetchRoutines: vi.fn(), saveAIProviders: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  showSavedToast: vi.fn(), showErrorToast: vi.fn(),
}));

vi.mock('../api-client.js', () => ({
  ...api,
  updateTrustTier: vi.fn(), disconnectProvider: vi.fn(),
  escapeHtml: (value) => String(value ?? ''), updateAutonomySettings: vi.fn(),
  updateIronClawChannel: vi.fn(), upsertDomainPolicy: vi.fn(),
  deleteDomainPolicy: vi.fn(), createEscalationTrigger: vi.fn(),
  deleteEscalationTrigger: vi.fn(), createSession: vi.fn(), revokeSession: vi.fn(),
  testAIProvider: vi.fn(), deleteRoutine: vi.fn(), startFederationPairing: vi.fn(),
  completeFederationPairing: vi.fn(), listFederationPeers: vi.fn().mockResolvedValue({ peers: [] }),
  unpairFederationPeer: vi.fn(),
}));
vi.mock('../theme-switcher.js', () => ({ mountThemeSwitcher: vi.fn() }));
vi.mock('../components/embedded-llm-card.js', () => ({
  mountEmbeddedLlmCard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../toast.js', () => toast);
vi.mock('../a11y.js', () => ({
  getTextScale: () => '100', setTextScale: vi.fn(), getReducedMotion: () => false,
  setReducedMotion: vi.fn(), isVoiceFirstEnabled: () => false, setVoiceFirst: vi.fn(),
}));

import { renderSettings } from './settings.js';

describe('settings provider mutation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<main id="page-content"></main>';
    window.location.hash = '#/settings';
    api.fetchUser.mockResolvedValue({ user: {} });
    api.fetchOAuthStatus.mockResolvedValue({ connected: false });
    api.fetchSessions.mockResolvedValue({ sessions: [] });
    api.fetchRoutines.mockResolvedValue({ routines: [] });
  });

  it('disables Save and does not call the mutation API when settings fail to load', async () => {
    api.fetchSettings.mockRejectedValue(new Error('offline'));
    const container = document.getElementById('page-content');
    await renderSettings(container, 'aaaaaaaa-bbbb-cccc-dddd-000000000001');

    const save = document.getElementById('save-ai-btn');
    expect(save.disabled).toBe(true);
    await window.saveAIProvidersHandler('aaaaaaaa-bbbb-cccc-dddd-000000000001');
    expect(api.saveAIProviders).not.toHaveBeenCalled();
  });

  it('removes persisted privacy claims immediately when an endpoint draft changes', async () => {
    api.fetchSettings.mockResolvedValue({
      aiProviders: [{
        provider: 'ollama', model: 'qwen', baseUrl: 'http://localhost:11434',
        priority: 0, enabled: true,
        privacy: {
          executionLocation: 'on_device', networkScope: 'loopback',
          retention: { summary: 'Persisted boundary disclosure.' },
          pricing: { kind: 'zero' },
        },
      }],
      reasoningMode: { mode: 'on_device', requiresConfirmation: false },
    });
    const container = document.getElementById('page-content');
    await renderSettings(container, 'aaaaaaaa-bbbb-cccc-dddd-000000000001');
    const before = document.querySelector('[data-region="provider-boundary"]');
    expect(before?.textContent).toContain('Persisted boundary disclosure.');

    window.aiUpdateField(0, 'baseUrl', 'https://remote.example');

    const after = document.querySelector('[data-region="provider-boundary"]');
    expect(after?.textContent).toContain('after this endpoint is validated and saved');
    expect(after?.textContent).not.toContain('Persisted boundary disclosure.');
  });

  it('requires an explicit location choice before changing legacy provider priority', async () => {
    api.fetchSettings.mockResolvedValue({
      aiProviders: [
        { provider: 'openai', model: 'gpt', priority: 0, enabled: true },
        { provider: 'embedded', model: 'auto', priority: 1, enabled: true },
      ],
      reasoningMode: { mode: null, requiresConfirmation: true },
    });
    const container = document.getElementById('page-content');
    await renderSettings(container, 'aaaaaaaa-bbbb-cccc-dddd-000000000001');

    await window.switchAIBrainMode('aaaaaaaa-bbbb-cccc-dddd-000000000001', 'smart');

    expect(api.saveAIProviders).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('ai-reasoning-mode');
    expect(toast.showErrorToast).toHaveBeenCalledWith(
      'Choose where reasoning runs before changing provider priority.',
    );
  });
});
