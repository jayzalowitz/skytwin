import { describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({
  client: Object.freeze({ inert: true }),
  create: vi.fn(),
}));

vi.mock('@skytwin/credential-vault', () => ({
  createProcessSourceKeyBrokerClient: broker.create,
}));

describe('worker source-key broker composition', () => {
  it('constructs exactly one fixed-role worker client', async () => {
    broker.create.mockReturnValue(broker.client);

    const module = await import('../source-key-broker.js');

    expect(broker.create).toHaveBeenCalledOnce();
    expect(broker.create).toHaveBeenCalledWith('worker');
    expect(module.workerSourceKeyBrokerClient).toBe(broker.client);
  });
});
