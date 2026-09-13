import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { VaultBrokerClient, type VaultBrokerContext } from '../broker-client.js';

class FakeIpc extends EventEmitter {
  connected = true;
  sent: Array<Record<string, unknown>> = [];
  send(message: unknown): boolean { this.sent.push(message as Record<string, unknown>); return true; }
}

const capability = Buffer.alloc(32, 7).toString('base64');
const context: VaultBrokerContext = { userId: 'user-0001', purpose: 'oauth', table: 'oauth_tokens', column: 'access_token', rowId: 'row-1' };
const sessionId = 'session-0001';

describe('VaultBrokerClient', () => {
  it('stays fail closed until capability and authenticated owner grant arrive', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const grant = client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() + 60_000));
    const request = ipc.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'skytwin:vault:grant', role: 'api', authentication: 'session', userId: context.userId, sessionId });
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: request['requestId'], contextUserId: context.userId, generation: 4, result: { success: true, state: 'unlocked' } });
    expect(await grant).toEqual({ success: true });
    const state = client.state(context);
    expect(ipc.sent.at(-1)).toMatchObject({ type: 'skytwin:vault:request', generation: 4, operation: 'state' });
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: ipc.sent.at(-1)!['requestId'], contextUserId: context.userId, generation: 4, result: { success: true, state: 'unlocked' } });
    expect(await state).toEqual({ success: true, state: 'unlocked' });
    client.close();
  });

  it('acknowledges lock, advances generation, and rejects pending plaintext work', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    const grant = client.reconcileAuthenticatedOwners([context.userId]), grantMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: grantMessage['requestId'], contextUserId: 'worker-set', generation: 0, result: { success: true, state: 'locked' } });
    expect(await grant).toEqual({ success: true });
    const pending = client.decrypt(context, { magic: 'skytwin-envelope', version: 2, algorithm: 'aes-256-gcm', ownerKind: 'user', purpose: 'oauth', keyVersion: 1, iv: '', tag: '', ciphertext: '' });
    ipc.emit('message', { type: 'skytwin:vault:lock', lockId: 'lock-1', userId: context.userId, generation: 2 });
    expect(await pending).toEqual({ success: false, error: 'vault_locked' });
    expect(ipc.sent.at(-1)).toMatchObject({ type: 'skytwin:vault:lock-ack', lockId: 'lock-1', userId: context.userId, generation: 2 });
    client.close();
  });

  it('clears grants and fails pending calls when IPC disconnects', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const pending = client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() + 60_000));
    ipc.emit('disconnect');
    expect(await pending).toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    client.close();
  });

  it('revokes removed owners and rejects malformed or wrong-owner responses', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 20);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    const grant = client.reconcileAuthenticatedOwners([context.userId]), grantMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: grantMessage['requestId'], contextUserId: 'worker-set', generation: 0, result: { success: true, state: 'locked' } });
    expect(await grant).toEqual({ success: true });
    const pending = client.state(context), request = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: request['requestId'], contextUserId: 'user-0002', generation: 2, result: { success: true } });
    expect(await pending).toEqual({ success: false, error: 'vault_broker_unavailable' });
    const reconcile = client.reconcileAuthenticatedOwners([]), replacement = ipc.sent.at(-1)!;
    expect(replacement).toMatchObject({ type: 'skytwin:vault:reconcile', userIds: [] });
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: replacement['requestId'], contextUserId: 'worker-set', generation: 0, result: { success: true, state: 'locked' } }); expect(await reconcile).toEqual({ success: true });
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' }); client.close();
  });

  it('accepts generation synchronization before the first operation after unlock', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const grant = client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() + 60_000)), message = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: message['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'locked' } }); await grant;
    ipc.emit('message', { type: 'skytwin:vault:generation', userId: context.userId, generation: 3 });
    void client.state(context); expect(ipc.sent.at(-1)).toMatchObject({ generation: 3 }); client.close();
  });

  it('clears local owner authority but retains the bootstrap capability after a transient revoke failure', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 10);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const expiry = new Date(Date.now() + 60_000);
    const grant = client.grantAuthenticatedSession(context.userId, sessionId, expiry), message = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: message['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } }); await grant;
    expect(await client.revokeAuthenticatedSession(context.userId, sessionId, expiry))
      .toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(client.isAvailable()).toBe(true); expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' }); client.close();
  });

  it('does not carry a revoked session deadline into a replacement grant', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const later = new Date(Date.now() + 120_000);
    const first = client.grantAuthenticatedSession(context.userId, sessionId, later);
    const firstMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: firstMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
    await first;
    const revoke = client.revokeAuthenticatedSession(context.userId, sessionId, later);
    const revokeMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: revokeMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'locked' } });
    expect(await revoke).toEqual({ success: true });
    const earlier = new Date(Date.now() + 60_000);
    void client.grantAuthenticatedSession(context.userId, 'session-0002', earlier);
    expect(ipc.sent.at(-1)).toMatchObject({ expiresAt: earlier.getTime() });
    client.close();
  });

  it('keeps overlapping session expiries exact and never lends a live deadline to an expired nonce', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const later = new Date(Date.now() + 120_000);
    const first = client.grantAuthenticatedSession(context.userId, 'session-long', later);
    const firstMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: firstMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
    await first;

    const earlier = new Date(Date.now() + 60_000);
    void client.grantAuthenticatedSession(context.userId, 'session-short', earlier);
    expect(ipc.sent.at(-1)).toMatchObject({ sessionId: 'session-short', expiresAt: earlier.getTime() });
    const sentBeforeExpired = ipc.sent.length;
    await expect(client.grantAuthenticatedSession(context.userId, 'session-expired', new Date(Date.now() - 1)))
      .resolves.toEqual({ success: false, error: 'grant_expired' });
    expect(ipc.sent).toHaveLength(sentBeforeExpired);
    client.close();
  });

  it('keeps another session locally admitted when one overlapping session is revoked', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    for (const id of ['session-a', 'session-b']) {
      const grant = client.grantAuthenticatedSession(context.userId, id, new Date(Date.now() + 60_000));
      const message = ipc.sent.at(-1)!;
      ipc.emit('message', { type: 'skytwin:vault:response', requestId: message['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
      await grant;
    }
    const revoke = client.revokeAuthenticatedSession(context.userId, 'session-a', new Date(Date.now() + 60_000));
    const revokeMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: revokeMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
    await revoke;
    void client.state(context);
    expect(ipc.sent.at(-1)).toMatchObject({ type: 'skytwin:vault:request', operation: 'state' });
    client.close();
  });

  it('expires overlapping session timers independently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
      ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
      for (const [id, expiry] of [['session-short', 1_100], ['session-long', 1_200]] as const) {
        const grant = client.grantAuthenticatedSession(context.userId, id, new Date(expiry));
        const message = ipc.sent.at(-1)!;
        ipc.emit('message', { type: 'skytwin:vault:response', requestId: message['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
        await grant;
      }
      await vi.advanceTimersByTimeAsync(101);
      expect(ipc.sent.some(message => message['type'] === 'skytwin:vault:revoke' && message['sessionId'] === 'session-short')).toBe(true);
      void client.state(context);
      expect(ipc.sent.at(-1)).toMatchObject({ type: 'skytwin:vault:request', operation: 'state' });
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore local authority when a grant response arrives after revoke began', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const expiry = new Date(Date.now() + 60_000);
    const grant = client.grantAuthenticatedSession(context.userId, sessionId, expiry);
    const grantMessage = ipc.sent.at(-1)!;
    const revoke = client.revokeAuthenticatedSession(context.userId, sessionId, expiry);
    const revokeMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: revokeMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'locked' } });
    await revoke;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: grantMessage['requestId'], contextUserId: context.userId, generation: 1, result: { success: true, state: 'unlocked' } });
    expect(await grant).toEqual({ success: false, error: 'grant_revoked' });
    expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    client.close();
  });

  it('keeps standalone account deletion available but requires acknowledgement after capability issuance', async () => {
    const standalone = new VaultBrokerClient(new EventEmitter() as FakeIpc, 20);
    await expect(standalone.purgeOwner(context.userId)).resolves.toEqual({ success: true });
    standalone.close();

    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 50);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const purge = client.purgeOwner(context.userId);
    const message = ipc.sent.at(-1)!;
    expect(message).toMatchObject({
      type: 'skytwin:vault:purge-owner', role: 'api', authentication: 'session',
      userId: context.userId,
    });
    ipc.emit('message', {
      type: 'skytwin:vault:response', requestId: message['requestId'],
      contextUserId: context.userId, generation: 2,
      result: { success: true, state: 'locked' },
    });
    await expect(purge).resolves.toEqual({ success: true });
    client.close();
  });

  it('propagates a lost worker reconciliation and clears all local authority', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 10);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'worker' });
    await expect(client.reconcileAuthenticatedOwners([context.userId])).resolves.toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(client.isAvailable()).toBe(true); expect(await client.state(context)).toEqual({ success: false, error: 'vault_broker_unavailable' }); client.close();
  });

  it('distinguishes local expiry, transient rejection, and authoritative capability mismatch', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 20);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    expect(await client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() - 1)))
      .toEqual({ success: false, error: 'grant_expired' });
    expect(ipc.sent).toEqual([]);
    const transient = client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() + 60_000));
    const transientMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: transientMessage['requestId'], contextUserId: context.userId, generation: 0, result: { success: false, error: 'vault_broker_unavailable' } });
    expect(await transient).toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(client.isAvailable()).toBe(true);
    const retry = client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() + 60_000));
    const retryMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: retryMessage['requestId'], contextUserId: context.userId, generation: 0, result: { success: true, state: 'locked' } });
    expect(await retry).toEqual({ success: true });
    const mismatch = client.grantAuthenticatedSession(context.userId, sessionId, new Date(Date.now() + 60_000));
    const mismatchMessage = ipc.sent.at(-1)!;
    ipc.emit('message', { type: 'skytwin:vault:response', requestId: mismatchMessage['requestId'], contextUserId: context.userId, generation: 0, result: { success: false, error: 'capability_mismatch' } });
    expect(await mismatch).toEqual({ success: false, error: 'capability_mismatch' });
    expect(client.isAvailable()).toBe(false);
    client.close();
  });

  it('bounds an ambiguous control response to one exchange without consuming capability', async () => {
    const ipc = new FakeIpc(), client = new VaultBrokerClient(ipc, 10);
    ipc.emit('message', { type: 'skytwin:vault:capability', capability, role: 'api' });
    const grant = client.grantAuthenticatedSession(
      context.userId,
      sessionId,
      new Date(Date.now() + 60_000),
    );
    const message = ipc.sent.at(-1)!;
    ipc.emit('message', {
      type: 'skytwin:vault:response', requestId: message['requestId'],
      contextUserId: 'different-owner', generation: 0,
      result: { success: true, state: 'unlocked' },
    });

    expect(await grant).toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(ipc.sent).toHaveLength(1);
    expect(client.isAvailable()).toBe(true);
    client.close();
  });
});
