import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileAuthenticatedOwners = vi.fn();
vi.mock('@skytwin/credential-vault', () => ({
  VaultBrokerClient: class { reconcileAuthenticatedOwners = reconcileAuthenticatedOwners; },
}));

const { grantWorkerOwners } = await import('../vault-broker-client.js');

describe('worker vault owner reconciliation', () => {
  beforeEach(() => reconcileAuthenticatedOwners.mockReset().mockResolvedValue({ success: true }));

  it('passes the complete discovered owner set so removed users are revoked', async () => {
    await grantWorkerOwners(['user-0001', 'user-0002']);
    expect(reconcileAuthenticatedOwners).toHaveBeenCalledWith(['user-0001', 'user-0002']);
    await grantWorkerOwners(['user-0002']);
    expect(reconcileAuthenticatedOwners).toHaveBeenLastCalledWith(['user-0002']);
  });

  it('continues brokerless standalone work with secret operations unavailable', async () => {
    const { VaultBrokerClient: RealVaultBrokerClient } = await vi.importActual<
      typeof import('@skytwin/credential-vault')
    >('@skytwin/credential-vault');
    const ipc = new EventEmitter() as EventEmitter & { connected: boolean };
    ipc.connected = false;
    const client = new RealVaultBrokerClient(ipc);
    await expect(grantWorkerOwners(['user-0001'], client)).resolves.toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(await client.state({
      userId: 'user-0001', purpose: 'oauth', table: 'oauth_tokens',
      column: 'access_token', rowId: 'row-1',
    })).toEqual({ success: false, error: 'vault_broker_unavailable' });
    client.close();
  });

  it('continues in a desktop headless child whose IPC has no parent capability', async () => {
    const { VaultBrokerClient: RealVaultBrokerClient } = await vi.importActual<
      typeof import('@skytwin/credential-vault')
    >('@skytwin/credential-vault');
    const sent: unknown[] = [];
    const ipc = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send(message: unknown): boolean;
    };
    ipc.connected = true;
    ipc.send = (message: unknown) => { sent.push(message); return true; };
    const client = new RealVaultBrokerClient(ipc);

    await expect(grantWorkerOwners(['user-0001'], client)).resolves.toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(sent).toEqual([]);
    client.close();
  });
});
