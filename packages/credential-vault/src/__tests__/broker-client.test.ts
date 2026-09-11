import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { VaultBrokerClient, type VaultBrokerContext } from '../broker-client.js';

class FakeIpc extends EventEmitter {
  connected = true;
  sent: Array<Record<string, unknown>> = [];
  send(message: unknown): boolean { this.sent.push(message as Record<string, unknown>); return true; }
}

const capability = Buffer.alloc(32, 7).toString('base64');
const context: VaultBrokerContext = { userId: 'user-0001', purpose: 'oauth', table: 'oauth_tokens', column: 'access_token', rowId: 'row-1' };

describe('VaultBrokerClient', () => {
  it('stays fail closed until capability and authenticated owner grant arrive', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const grant = client.grantAuthenticatedOwner(context.userId, new Date(Date.now() + 60_000));
    const request = ipc.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'skytwin:vault:grant', role: 'api', authentication: 'session', userId: context.userId });
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: request['requestId'], contextUserId: context.userId, generation: 4, result: { success: true, state: 'unlocked' } });
    expect(await grant).toBe(true);
    const state = client.state(context);
    expect(ipc.sent.at(-1)).toMatchObject({ type: 'skytwin:vault:request', generation: 4, operation: 'state' });
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: ipc.sent.at(-1)!['requestId'], contextUserId: context.userId, generation: 4, result: { success: true, state: 'unlocked' } });
    expect(await state).toEqual({ success: true, state: 'unlocked' });
    client.close();
  });

  it('acknowledges lock, advances generation, and rejects pending plaintext work', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    const grant = client.grantAuthenticatedOwner(context.userId), grantMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: grantMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
    await grant;
    const pending = client.decrypt(context, { magic: 'skytwin-envelope', version: 2, algorithm: 'aes-256-gcm', ownerKind: 'user', purpose: 'oauth', keyVersion: 1, iv: '', tag: '', ciphertext: '' });
    ipc.emit('message', { type: 'skytwin:vault:lock', lockId: 'lock-1', userId: context.userId, generation: 2 });
    expect(await pending).toEqual({ success: false, error: 'vault_locked' });
    expect(ipc.sent.at(-1)).toMatchObject({ type: 'skytwin:vault:lock-ack', lockId: 'lock-1', userId: context.userId, generation: 2 });
    client.close();
  });

  it('clears grants and fails pending calls when IPC disconnects', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const pending = client.grantAuthenticatedOwner(context.userId, new Date(Date.now() + 60_000));
    ipc.emit('disconnect');
    expect(await pending).toBe(false);
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    client.close();
  });

  it('revokes removed owners and rejects malformed or wrong-owner responses', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 20);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    const grant = client.grantAuthenticatedOwner(context.userId), grantMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: grantMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } }); await grant;
    const pending = client.state(context), request = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: request['requestId'], contextUserId: 'user-0002', generation: 2, result: { success: true } });
    expect(await pending).toEqual({ success: false, error: 'vault_broker_unavailable' });
    const reconcile = client.reconcileAuthenticatedOwners([]), replacement = ipc.sent.at(-1)!;
    expect(replacement).toMatchObject({ type: 'skytwin:vault:reconcile', userIds: [] });
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: replacement['requestId'], contextUserId: 'worker-set', generation: 0, result: { success: true, state: 'locked' } }); await reconcile;
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' }); client.close();
  });

  it('accepts generation synchronization before the first operation after unlock', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const grant = client.grantAuthenticatedOwner(context.userId, new Date(Date.now() + 60_000)), message = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: message['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'locked' } }); await grant;
    ipc.emit('message', { type: 'skytwin:vault:generation', userId: context.userId, generation: 3 });
    void client.state(context); expect(ipc.sent.at(-1)).toMatchObject({ generation: 3 }); client.close();
  });

  it('tears down local authority when an owner revoke is not acknowledged', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 10);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    const grant = client.grantAuthenticatedOwner(context.userId), message = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: message['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } }); await grant;
    expect(await client.revokeAuthenticatedOwner(context.userId)).toBe(false);
    expect(client.isAvailable()).toBe(false); expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' }); client.close();
  });

  it('propagates a lost worker reconciliation and clears all local authority', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 10);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    await expect(client.reconcileAuthenticatedOwners([context.userId])).rejects.toThrow('reconciliation failed');
    expect(client.isAvailable()).toBe(false); expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' }); client.close();
  });
});
