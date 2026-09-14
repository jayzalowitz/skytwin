// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchAssistantThreads: vi.fn(),
  fetchAssistantThread: vi.fn(),
}));

vi.mock('../api-client.js', () => ({
  ...api,
  deleteAssistantThread: vi.fn(),
  sendAssistantMessageStream: vi.fn(),
  resolveAssistantRequestIdentity: vi.fn(),
  shouldRetireAssistantRequestIdentity: vi.fn(),
  searchCapabilityRegistry: vi.fn(),
  installCapability: vi.fn(),
  requestInstallSuggestion: vi.fn(),
  parseWatchText: vi.fn(),
  createWatch: vi.fn(),
  escapeHtml: (value) => String(value ?? ''),
  renderApiError: () => 'error',
  wireApiRetry: vi.fn(),
}));
vi.mock('../storage-keys.js', () => ({ assistantDraftKey: () => 'draft' }));
vi.mock('../assistant-request-store.js', () => ({
  clearPendingAssistantRequest: vi.fn(),
  readPendingAssistantRequest: vi.fn(() => null),
  writePendingAssistantRequest: vi.fn(() => true),
}));
vi.mock('../sample-session.js', () => ({ getEffectiveUserId: () => '' }));
vi.mock('../toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../components/tier-promotion-modal.js', () => ({ renderTierPromotionModal: vi.fn() }));

import { renderAssistant } from './assistant.js';

describe('assistant render generation', () => {
  it('does not let an older user fetch paint over a newer user render', async () => {
    let resolveOlder;
    const olderThreads = new Promise((resolve) => { resolveOlder = resolve; });
    api.fetchAssistantThreads.mockImplementation((userId) =>
      userId === 'user-a'
        ? olderThreads
        : Promise.resolve({ threads: [{ id: 'thread-b', title: 'B conversation' }] }),
    );
    api.fetchAssistantThread.mockResolvedValue({
      messages: [{ id: 'message-b', role: 'assistant', content: 'B private reply' }],
    });
    document.body.innerHTML = '<main id="page-content"></main>';
    window.location.hash = '#/assistant';
    const container = document.getElementById('page-content');

    const olderRender = renderAssistant(container, 'user-a');
    await renderAssistant(container, 'user-b');
    expect(container.textContent).toContain('B private reply');

    resolveOlder({ threads: [{ id: 'thread-a', title: 'A conversation' }] });
    await olderRender;

    expect(container.textContent).toContain('B private reply');
    expect(container.textContent).not.toContain('A conversation');
    expect(api.fetchAssistantThread).toHaveBeenCalledTimes(1);
  });
});
