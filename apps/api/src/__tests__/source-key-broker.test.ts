import { describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({
  client: Object.freeze({ inert: true }),
  create: vi.fn(),
}));

vi.mock('@skytwin/credential-vault', async (importOriginal) => ({
  ...await importOriginal<typeof import('@skytwin/credential-vault')>(),
  createProcessSourceKeyBrokerClient: broker.create,
}));

describe('API source-key broker composition', () => {
  it('constructs exactly one fixed-role API client', async () => {
    broker.create.mockReturnValue(broker.client);

    const module = await import('../source-key-broker.js');

    expect(broker.create).toHaveBeenCalledOnce();
    expect(broker.create).toHaveBeenCalledWith('api', undefined, {
      sessionAuthorityProvider: expect.any(Function),
    });
    expect(module.apiSourceKeyBrokerClient).toBe(broker.client);
  });
});
