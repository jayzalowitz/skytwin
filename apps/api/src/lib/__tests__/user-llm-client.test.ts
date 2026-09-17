import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshotMock, readinessMock } = vi.hoisted(() => ({
  snapshotMock: vi.fn(),
  readinessMock: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  aiProviderRepository: { getReasoningSnapshotForUser: snapshotMock },
}));
vi.mock('@skytwin/llm-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skytwin/llm-client')>()),
  probeEmbeddedProviderReadiness: readinessMock,
}));

import { resolveUserLlmClient } from '../user-llm-client.js';

const localRow = {
  id: 'provider-1', user_id: 'user-1', provider: 'embedded', api_key: '',
  model: 'managed', base_url: null, priority: 0, enabled: true,
  created_at: new Date(), updated_at: new Date(),
};

describe('per-user LLM composition root', () => {
  beforeEach(() => {
    readinessMock.mockReset().mockResolvedValue({ state: 'ready' });
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
      localReadiness: { state: 'ready' },
    });
    expect(readinessMock).toHaveBeenCalledWith('managed');
  });

  it.each([
    ['artifact_missing', 'artifact_unavailable'],
    ['artifact_invalid', 'artifact_unavailable'],
    ['runtime_binary_missing', 'runtime_unavailable'],
    ['runtime_incompatible', 'runtime_unavailable'],
  ] as const)('preserves embedded %s readiness as %s', async (reason, state) => {
    readinessMock.mockResolvedValue({ state, reason });

    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'ready',
      localReadiness: { state, reason },
    });
  });

  it('does not let an unavailable embedded provider mask an Ollama fallback canary', async () => {
    snapshotMock.mockResolvedValue({
      providers: [
        localRow,
        { ...localRow, id: 'provider-2', provider: 'ollama', model: 'qwen2.5', base_url: 'http://127.0.0.1:11434' },
      ],
      reasoningMode: {
        user_id: 'user-1', mode: 'on_device', requires_confirmation: false,
        created_at: new Date(), updated_at: new Date(),
      },
    });

    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'ready', client: { hasProviders: true }, mode: 'on_device',
    });
    expect(readinessMock).not.toHaveBeenCalled();
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
      reason: expect.stringMatching(/no verifier-owned/i),
    });
  });

  it('composes the verifier-owned TrustedRouter provider in private-cloud mode', async () => {
    snapshotMock.mockResolvedValue({
      providers: [{
        ...localRow,
        provider: 'trustedrouter',
        api_key: 'secret',
        model: 'trustedrouter/confidential',
      }],
      reasoningMode: { mode: 'verified_private_cloud', requires_confirmation: false },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'ready', client: { hasProviders: true }, mode: 'verified_private_cloud',
    });
  });

  it('fails closed for a stored NEAR AI provider until dynamic workload verification ships', async () => {
    snapshotMock.mockResolvedValue({
      providers: [{
        ...localRow,
        provider: 'nearai',
        api_key: 'secret',
        model: 'deepseek-ai/DeepSeek-V4-Flash',
      }],
      reasoningMode: { mode: 'verified_private_cloud', requires_confirmation: false },
    });
    await expect(resolveUserLlmClient('user-1')).resolves.toMatchObject({
      state: 'policy_blocked',
      client: null,
      reason: expect.stringMatching(/dynamically selected inference workload/i),
    });
  });
});
