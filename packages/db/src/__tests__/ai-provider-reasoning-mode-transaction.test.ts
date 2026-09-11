import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientQueryMock, withTransactionMock } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  query: vi.fn(),
  withTransaction: withTransactionMock,
}));

import { aiProviderRepository } from '../repositories/ai-provider-repository.js';

describe('atomic reasoning-mode provider replacement', () => {
  beforeEach(() => {
    clientQueryMock.mockReset();
    withTransactionMock.mockReset().mockImplementation(
      async (operation: (client: { query: typeof clientQueryMock }) => Promise<unknown>) =>
        operation({ query: clientQueryMock }),
    );
  });

  it('reads mode and providers through one transaction snapshot', async () => {
    const mode = { user_id: 'user-1', mode: 'on_device', requires_confirmation: false };
    const provider = { provider: 'embedded', enabled: true, priority: 0 };
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [mode] })
      .mockResolvedValueOnce({ rows: [provider] });

    await expect(aiProviderRepository.getReasoningSnapshotForUser('user-1'))
      .resolves.toEqual({ providers: [provider], reasoningMode: mode });
    expect(withTransactionMock).toHaveBeenCalledOnce();
    expect(clientQueryMock).toHaveBeenCalledTimes(3);
    expect(clientQueryMock.mock.calls[2]![0]).not.toContain('enabled = true');
  });

  it('writes the mode and complete provider chain through one transaction client', async () => {
    const inserted = {
      provider: 'openai', api_key: 'preserved', model: 'gpt', base_url: null,
      priority: 0, enabled: true,
    };
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ provider: 'openai', api_key: 'preserved' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [inserted] });

    await expect(aiProviderRepository.replaceAllWithReasoningMode(
      'user-1',
      'bring_your_own_provider',
      [{ provider: 'openai', model: 'gpt', priority: 0 }],
    )).resolves.toEqual([inserted]);

    expect(withTransactionMock).toHaveBeenCalledOnce();
    expect(clientQueryMock).toHaveBeenCalledTimes(4);
    expect(clientQueryMock.mock.calls[0]![0]).toContain('reasoning_mode_settings');
    expect(clientQueryMock.mock.calls[0]![1]).toEqual(['user-1', 'bring_your_own_provider']);
    expect(clientQueryMock.mock.calls[2]![0]).toContain('DELETE FROM ai_provider_settings');
    expect(clientQueryMock.mock.calls[3]![1]).toEqual([
      'user-1', 'openai', 'preserved', 'gpt', null, 0, true,
    ]);
  });

  it('rejects the whole transaction result when a provider insert fails', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('serialization failure'));

    await expect(aiProviderRepository.replaceAllWithReasoningMode(
      'user-1',
      'on_device',
      [{ provider: 'embedded', model: 'managed', priority: 0 }],
    )).rejects.toThrow('serialization failure');
    expect(withTransactionMock).toHaveBeenCalledOnce();
  });
});
