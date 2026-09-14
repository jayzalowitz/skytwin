// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  fetchDownload: vi.fn(),
  list: vi.fn(),
  pause: vi.fn(),
  registry: vi.fn(),
  localRecommendation: vi.fn(),
  recommend: vi.fn(),
  resume: vi.fn(),
  start: vi.fn(),
  errorToast: vi.fn(),
  savedToast: vi.fn(),
  userId: vi.fn(),
}));

vi.mock('../../api-client.js', () => ({
  cancelModelDownload: mocks.cancel,
  escapeHtml: (value) => String(value),
  fetchEmbeddedLlmRegistry: mocks.registry,
  fetchModelDownload: mocks.fetchDownload,
  listUserModelDownloads: mocks.list,
  pauseModelDownload: mocks.pause,
  recommendEmbeddedDefault: mocks.recommend,
  fetchLocalModelRecommendation: mocks.localRecommendation,
  resumeModelDownload: mocks.resume,
  startModelDownload: mocks.start,
}));
vi.mock('../../sample-session.js', () => ({
  getEffectiveUserId: mocks.userId,
}));
vi.mock('../../toast.js', () => ({
  showErrorToast: mocks.errorToast,
  showSavedToast: mocks.savedToast,
}));

import { mountEmbeddedLlmCard } from '../embedded-llm-card.js';

const model = {
  id: 'local-model',
  displayName: 'Local model',
  approxBytes: 4,
  ramBracket: '8gb',
};
const downloading = {
  id: 'download-id',
  modelId: model.id,
  status: 'downloading',
  percent: 50,
  bytesDownloaded: 2,
  totalBytes: 4,
  error: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="embedded-llm-card-target"></main>';
  window.location.hash = '#/settings';
  vi.stubGlobal('confirm', vi.fn(() => true));
  mocks.userId.mockReturnValue('user-id');
  mocks.registry.mockResolvedValue({ models: [model] });
  mocks.list.mockResolvedValue({ downloads: [downloading] });
  mocks.localRecommendation.mockResolvedValue({ model: null });
  mocks.recommend.mockResolvedValue({ model: null });
});

afterEach(async () => {
  window.location.hash = '#/elsewhere';
  await vi.advanceTimersByTimeAsync(1_000);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('local model download controls', () => {
  it('does not treat a legacy completion for a removed model as installed', async () => {
    mocks.list.mockResolvedValue({
      downloads: [{
        ...downloading,
        modelId: 'removed-model',
        status: 'complete',
        percent: 100,
        bytesDownloaded: 4,
      }],
    });
    const container = document.getElementById('embedded-llm-card-target');

    await mountEmbeddedLlmCard(container, 'user-id');

    expect(container.textContent).not.toContain('Local model artifact verified');
    expect(container.querySelector('[data-action="embedded-start-download"]')).not.toBeNull();
    expect(container.querySelector('#embedded-model-select')?.value).toBe(model.id);
  });

  it.each([
    ['pause', 'embedded-pause-download', mocks.pause, "Couldn't pause"],
    ['cancel', 'embedded-cancel-download', mocks.cancel, "Couldn't cancel"],
  ])('does not report %s success when the API returns ok=false', async (
    _label,
    action,
    request,
    message,
  ) => {
    request.mockResolvedValue({ ok: false });
    const container = document.getElementById('embedded-llm-card-target');
    await mountEmbeddedLlmCard(container, 'user-id');

    container.querySelector(`[data-action="${action}"]`).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith(downloading.id);
    expect(mocks.savedToast).not.toHaveBeenCalled();
    expect(mocks.errorToast).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it('fully rerenders controls when polling crosses active download phases', async () => {
    let current = downloading;
    mocks.list.mockImplementation(async () => ({ downloads: [current] }));
    mocks.fetchDownload.mockImplementation(async () => ({ download: current }));
    const container = document.getElementById('embedded-llm-card-target');
    await mountEmbeddedLlmCard(container, 'user-id');
    expect(container.querySelector('[data-action="embedded-pause-download"]')).not.toBeNull();

    current = { ...downloading, status: 'verifying' };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(container.querySelector('[data-role="embedded-llm-status"]')?.textContent)
      .toBe('Verifying integrity…');
    expect(container.querySelector('[data-action="embedded-pause-download"]')).toBeNull();
    expect(container.querySelector('[data-action="embedded-cancel-download"]')).not.toBeNull();

    current = { ...downloading, status: 'installing' };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(container.querySelector('[data-role="embedded-llm-status"]')?.textContent)
      .toBe('Installing…');
    expect(container.querySelector('[data-action="embedded-cancel-download"]')).toBeNull();
  });
});
