import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshotMock } = vi.hoisted(() => ({
  snapshotMock: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  aiProviderRepository: { getReasoningSnapshotForUser: snapshotMock },
}));

import { resolveUserLlmClient } from '../user-llm-client.js';

const localRow = {
  id: 'provider-1', user_id: 'user-1', provider: 'embedded', api_key: '',
  model: 'managed', base_url: null, priority: 0, enabled: true,
  created_at: new Date(), updated_at: new Date(),
};

describe('per-user LLM composition root', () => {
  beforeEach(() => {
    snapshotMock.mockReset().mockResolvedValue({
      providers: [localRow],
      reasoningMode: {
        user_id: 'user-1', mode: 'on_device', requires_confirmation: false,
        created_at: new Date(), updated_at: new Date(),
      },
    });
  });

  it('builds a mode-scoped client from enabled settings', async () => {
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'ready', client: { hasProviders: true }, mode: 'on_device',
    });
  });

  it('does not route while a legacy mixed chain awaits confirmation', async () => {
    snapshotMock.mockResolvedValue({
      providers: [localRow], reasoningMode: { mode: null, requires_confirmation: true },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'confirmation_required', client: null,
    });
  });

  it('fails closed on removal, unknown adapters and cross-mode fallback attempts', async () => {
    snapshotMock.mockResolvedValueOnce({
      providers: [], reasoningMode: { mode: 'on_device', requires_confirmation: false },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'no_provider', client: null,
    });

    snapshotMock.mockResolvedValueOnce({
      providers: [{ ...localRow, provider: 'removed-provider' }],
      reasoningMode: { mode: 'on_device', requires_confirmation: false },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'policy_blocked', client: null,
    });

    snapshotMock.mockResolvedValueOnce({
      providers: [{ ...localRow, provider: 'openai', api_key: 'secret' }],
      reasoningMode: { mode: 'on_device', requires_confirmation: false },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'policy_blocked', client: null,
    });
  });

  it('does not treat a conventional provider as verified private cloud', async () => {
    snapshotMock.mockResolvedValue({
      providers: [{ ...localRow, provider: 'openai', api_key: 'secret' }],
      reasoningMode: { mode: 'verified_private_cloud', requires_confirmation: false },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'policy_blocked', client: null,
      reason: expect.stringMatching(/verifier-owned/i),
    });
  });
});
