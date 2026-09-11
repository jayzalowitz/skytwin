import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileAuthenticatedOwners = vi.fn();
vi.mock('@skytwin/credential-vault', () => ({
  VaultBrokerClient: class { reconcileAuthenticatedOwners = reconcileAuthenticatedOwners; },
}));

const { grantWorkerOwners } = await import('../vault-broker-client.js');

describe('worker vault owner reconciliation', () => {
  beforeEach(() => reconcileAuthenticatedOwners.mockReset().mockResolvedValue(undefined));

  it('passes the complete discovered owner set so removed users are revoked', async () => {
    await grantWorkerOwners(['user-0001', 'user-0002']);
    expect(reconcileAuthenticatedOwners).toHaveBeenCalledWith(['user-0001', 'user-0002']);
    await grantWorkerOwners(['user-0002']);
    expect(reconcileAuthenticatedOwners).toHaveBeenLastCalledWith(['user-0002']);
  });
});
