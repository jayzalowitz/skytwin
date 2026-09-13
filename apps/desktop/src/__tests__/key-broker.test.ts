import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'child_process';
import { DesktopKeyBroker, PersistentWrappedKeyStore, type BrokerContext, type WrappedKeyStore, type WrappedUserKey } from '../key-broker.js';

class MemoryStore implements WrappedKeyStore {
  rows = new Map<string, WrappedUserKey>();
  get(id: string) { return this.rows.get(id); }
  create(id: string, row: WrappedUserKey) {
    if (this.rows.has(id)) return false;
    this.rows.set(id, structuredClone(row));
    return true;
  }
  deleteIfMatch(id: string, row: WrappedUserKey) {
    if (JSON.stringify(this.rows.get(id)) !== JSON.stringify(row)) return false;
    this.rows.delete(id);
    return true;
  }
}
class DeferredGetStore extends MemoryStore {
  private releaseFirst!: () => void;
  private first = new Promise<void>(resolve => { this.releaseFirst = resolve; });
  getCalls = 0;
  override async get(id: string) {
    this.getCalls++;
    if (this.getCalls === 1) await this.first;
    return super.get(id);
  }
  release() { this.releaseFirst(); }
}
class PausableGetStore extends MemoryStore {
  private releaseNext: (() => void) | null = null;
  private next: Promise<void> | null = null;
  pauseNextGet(): void { this.next = new Promise<void>(resolve => { this.releaseNext = resolve; }); }
  release(): void { this.releaseNext?.(); this.releaseNext = null; }
  override async get(id: string) {
    const pending = this.next;
    this.next = null;
    if (pending) await pending;
    return super.get(id);
  }
}
class FakeChild extends EventEmitter {
  sent: unknown[] = [];
  connected = true;
  killed = false;
  autoAck = true;
  send(value: unknown) {
    this.sent.push(value);
    const message = value as Record<string, unknown>;
    if (this.autoAck && message['type'] === 'skytwin:vault:lock') {
      const capability = (this.sent[0] as { capability: string }).capability;
      queueMicrotask(() => this.emit('message', {
        type: 'skytwin:vault:lock-ack',
        capability,
        lockId: message['lockId'],
        userId: message['userId'],
        generation: message['generation'],
      }));
    }
    return true;
  }
  kill() { this.killed = true; this.connected = false; this.emit('exit'); return true; }
}
class DeviceStore {
  rows = new Map<string, string>();
  get(id: string) { return this.rows.get(id); }
  set(id: string, value: string) { this.rows.set(id, value); }
  delete(id: string) { this.rows.delete(id); }
  keys() { return [...this.rows.keys()]; }
}
const deviceProtection = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString(), getSelectedStorageBackend: () => 'keychain' };
const context: BrokerContext = { userId: 'user-0001', purpose: 'oauth', table: 'oauth_tokens', column: 'access_token', rowId: 'row-1' };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('DesktopKeyBroker', () => {
  it('round-trips wrapped keys through the persistent key-value adapter', async () => {
    const rows = new Map<string, WrappedUserKey>();
    const persistent = new PersistentWrappedKeyStore({ get: key => rows.get(key), set: (key, value) => { rows.set(key, structuredClone(value)); }, delete: key => { rows.delete(key); } });
    const broker = new DesktopKeyBroker(persistent);
    expect(await broker.initialize(context.userId, 'correct horse battery staple')).toEqual({ success: true });
    expect(rows.has(`source-key:${context.userId}`)).toBe(true);
    await broker.lock(context.userId);
    expect(await broker.unlock(context.userId, 'correct horse battery staple')).toMatchObject({ success: true });
  });
  it('persists a versioned recovery wrapper, self-tests it, and fails closed', async () => {
    const store = new MemoryStore(), broker = new DesktopKeyBroker(store);
    expect(await broker.initialize(context.userId, 'correct horse battery staple')).toEqual({ success: true });
    const row = store.rows.get(context.userId)!;
    expect(row.kdf).toMatchObject({ algorithm: 'scrypt', N: 32768, r: 8, p: 1 });
    expect(JSON.stringify(row)).not.toContain('correct horse battery staple');
    await broker.lock(context.userId);
    expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
    expect(await broker.unlock(context.userId, 'wrong passphrase')).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(await broker.unlock(context.userId, 'correct horse battery staple')).toMatchObject({ success: true });
  });

  it('admits only one initializer before the persistence lookup resolves', async () => {
    const store = new DeferredGetStore(), broker = new DesktopKeyBroker(store);
    const first = broker.initialize(context.userId, 'correct horse battery staple');
    const second = await broker.initialize(context.userId, 'another correct battery staple');
    expect(second).toEqual({ success: false, error: 'already_initialized' });
    store.release();
    expect(await first).toEqual({ success: true });
    expect(store.rows.size).toBe(1);
  });

  it('never deletes a different persistence winner during ambiguous rollback', async () => {
    let winner: WrappedUserKey | undefined;
    const store: WrappedKeyStore = {
      get: () => { throw new Error('ambiguous reread'); },
      create: (_id, row) => {
        winner = { ...structuredClone(row), ciphertext: Buffer.alloc(32, 7).toString('base64') };
        return true;
      },
      deleteIfMatch: (_id, row) => {
        if (JSON.stringify(winner) !== JSON.stringify(row)) return false;
        winner = undefined;
        return true;
      },
    };
    const broker = new DesktopKeyBroker(store);
    expect(await broker.initialize(context.userId, 'correct horse battery staple'))
      .toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(winner).toBeDefined();
  });

  it('does not reopen when lock completes during initialization', async () => {
    const store = new DeferredGetStore(), broker = new DesktopKeyBroker(store);
    const initialize = broker.initialize(context.userId, 'correct horse battery staple');
    await broker.lock(context.userId);
    store.release();
    expect(await initialize).toEqual({ success: true });
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' });
  });

  it('does not reopen when lock completes during passphrase unlock', async () => {
    const store = new PausableGetStore(), broker = new DesktopKeyBroker(store);
    await broker.initialize(context.userId, 'correct horse battery staple');
    await broker.lock(context.userId);
    store.pauseNextGet();
    const unlock = broker.unlock(context.userId, 'correct horse battery staple');
    await broker.lock(context.userId);
    store.release();
    expect(await unlock).toEqual({ success: false, error: 'vault_locked' });
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' });
  });

  it('does not reopen from a device wrapper when lock completes during its registry read', async () => {
    const store = new PausableGetStore(), devices = new DeviceStore();
    const broker = new DesktopKeyBroker(store, { deviceProtection, deviceStore: devices });
    await broker.initialize(context.userId, 'correct horse battery staple');
    expect(broker.rememberDevice(context.userId)).toEqual({ success: true });
    await broker.lock(context.userId);
    store.pauseNextGet();
    const unlock = broker.unlockFromDevice(context.userId);
    await broker.lock(context.userId);
    store.release();
    expect(await unlock).toEqual({ success: false, error: 'vault_locked' });
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' });
    expect(devices.get(context.userId)).toBeDefined();
  });

  it('uses a self-describing purpose and row-bound envelope', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const encrypted = broker.encrypt(context, 'fixture-secret'); expect(encrypted.success).toBe(true); if (!encrypted.success) return;
    expect(encrypted.envelope).toMatchObject({ magic: 'skytwin-envelope', algorithm: 'aes-256-gcm', ownerKind: 'user', purpose: 'oauth' });
    expect(broker.decrypt(context, encrypted.envelope)).toEqual({ success: true, plaintext: 'fixture-secret' });
    expect(broker.decrypt({ ...context, rowId: 'row-2' }, encrypted.envelope)).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(broker.decrypt({ ...context, purpose: 'provider_credentials' }, encrypted.envelope)).toMatchObject({ success: false });
  });

  it('rejects malformed and oversized ciphertext without permissive base64 decoding', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const encrypted = broker.encrypt(context, 'fixture-secret'); if (!encrypted.success) throw new Error('setup');
    expect(broker.decrypt(context, { ...encrypted.envelope, iv: '!!!!' })).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(broker.decrypt(context, { ...encrypted.envelope, tag: 'YQ==' })).toEqual({ success: false, error: 'ciphertext_invalid' });
  });

  it('binds capability, role, exact field tuple, and owner to one child', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    child.emit('message', { type: 'skytwin:vault:request', requestId: 'ok', capability, generation: 1, operation: 'encrypt', context, plaintext: 'secret' }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: true } });
    child.emit('message', { type: 'skytwin:vault:request', requestId: 'other-user', capability, generation: 1, operation: 'state', context: { ...context, userId: 'user-0002' } }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    child.emit('message', { type: 'skytwin:vault:request', requestId: 'tuple-smuggle', capability, generation: 1, operation: 'encrypt', context: { ...context, purpose: 'oauth', table: 'oauth_tokens:access', column: 'token' }, plaintext: 'secret' }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: false } });
  });

  it('denies every request when a child has no owner grants', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); broker.attachChild(child as unknown as ChildProcess, 'api', new Set());
    const capability = (child.sent[0] as { capability: string }).capability;
    child.emit('message', { type: 'skytwin:vault:request', requestId: 'no-grant', capability, generation: 1, operation: 'encrypt', context, plaintext: 'secret' }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
  });

  it('keeps admission closed until overlapping locks for that user finish', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    const first = broker.lock(context.userId), second = broker.lock(context.userId);
    child.emit('message', { type: 'skytwin:vault:request', requestId: 'during-second-lock', capability, generation: 1, operation: 'state', context }); await tick();
    expect(child.sent.find(value => (value as { requestId?: string }).requestId === 'during-second-lock'))
      .toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    await Promise.all([first, second]);
  });

  it('refuses to create a device wrapper while a lock is draining child work', async () => {
    const store = new PausableGetStore(), devices = new DeviceStore();
    const broker = new DesktopKeyBroker(store, { deviceProtection, deviceStore: devices });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    store.pauseNextGet();
    child.emit('message', { type: 'skytwin:vault:request', requestId: 'state-in-flight', capability, generation: 1, operation: 'state', context });
    await tick();
    const locking = broker.lock(context.userId);
    expect(broker.rememberDevice(context.userId)).toEqual({ success: false, error: 'vault_locked' });
    expect(devices.get(context.userId)).toBeUndefined();
    store.release();
    await locking;
  });

  it('expires the cached key and advances the generation', async () => {
    let now = 1000; const broker = new DesktopKeyBroker(new MemoryStore(), { now: () => now, ttlMs: 60 }); await broker.initialize(context.userId, 'correct horse battery staple'); now += 61;
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' }); expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
  });

  it('uses an optional device wrapper only as an additional unlock path', async () => {
    const registry = new MemoryStore(), devices = new DeviceStore();
    const broker = new DesktopKeyBroker(registry, { deviceProtection, deviceStore: devices });
    await broker.initialize(context.userId, 'correct horse battery staple');
    expect(broker.rememberDevice(context.userId)).toEqual({ success: true });
    await broker.lock(context.userId);
    expect(await broker.unlockFromDevice(context.userId)).toMatchObject({ success: true });
    broker.forgetDevice(context.userId);
    expect(broker.deviceWrapperState(context.userId)).toBe('absent');
    expect(registry.rows.has(context.userId)).toBe(true);
  });

  it('deletes a corrupt device wrapper and rejects unavailable protection', async () => {
    const registry = new MemoryStore(), devices = new DeviceStore();
    const broker = new DesktopKeyBroker(registry, { deviceProtection, deviceStore: devices });
    await broker.initialize(context.userId, 'correct horse battery staple');
    devices.set(context.userId, 'not-base64'); await broker.lock(context.userId);
    expect(await broker.unlockFromDevice(context.userId)).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(devices.get(context.userId)).toBeUndefined();
    const unsupported = new DesktopKeyBroker(registry, { deviceProtection: { ...deviceProtection, isEncryptionAvailable: () => false }, deviceStore: devices });
    expect(await unsupported.unlock(context.userId, 'correct horse battery staple')).toMatchObject({ success: true });
    expect(unsupported.rememberDevice(context.userId)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(await unsupported.unlockFromDevice(context.userId)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    const throws = new DesktopKeyBroker(registry, { deviceProtection: { ...deviceProtection, isEncryptionAvailable: () => { throw new Error('backend unavailable'); } }, deviceStore: devices });
    expect(await throws.unlockFromDevice(context.userId)).toEqual({ success: false, error: 'vault_broker_unavailable' });
  });

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'accepts only reviewed Linux secure-storage backend %s',
    async backend => {
      const devices = new DeviceStore();
      const broker = new DesktopKeyBroker(new MemoryStore(), {
        platform: 'linux',
        deviceStore: devices,
        deviceProtection: { ...deviceProtection, getSelectedStorageBackend: () => backend },
      });
      await broker.initialize(context.userId, 'correct horse battery staple');
      expect(broker.rememberDevice(context.userId)).toEqual({ success: true });
      expect(devices.get(context.userId)).toContain(`linux:${backend}`);
    },
  );

  it.each(['basic_text', 'unknown_future_backend', 'keychain'])(
    'rejects and purges unreviewed Linux backend %s',
    async backend => {
      const devices = new DeviceStore();
      devices.set(context.userId, JSON.stringify({ version: 1, backend: `linux:${backend}`, ciphertext: 'YQ==' }));
      const broker = new DesktopKeyBroker(new MemoryStore(), {
        platform: 'linux',
        deviceStore: devices,
        deviceProtection: { ...deviceProtection, getSelectedStorageBackend: () => backend },
      });
      expect(broker.purgeUntrustedDeviceWrappers()).toEqual({ success: true, removed: 1 });
      expect(devices.get(context.userId)).toBeUndefined();
      await broker.initialize(context.userId, 'correct horse battery staple');
      expect(broker.rememberDevice(context.userId))
        .toEqual({ success: false, error: 'vault_broker_unavailable' });
    },
  );

  it('kills a child that does not acknowledge a lock before the bounded deadline', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), { lockAckTimeoutMs: 10 });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    await broker.lock(context.userId);
    expect(child.killed).toBe(true);
    expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
  });

  it('snapshots child owner grants instead of retaining a mutable set', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const grants = new Set([context.userId]);
    const child = new FakeChild();
    broker.attachChild(child as unknown as ChildProcess, 'api', grants);
    grants.add('user-0002');
    const capability = (child.sent[0] as { capability: string }).capability;
    child.emit('message', {
      type: 'skytwin:vault:request', requestId: 'late-grant', capability,
      generation: 1, operation: 'state', context: { ...context, userId: 'user-0002' },
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId: 'late-grant',
      result: { success: false, error: 'vault_broker_unavailable' },
    });
  });

  it('returns typed failures when persistence throws', async () => {
    const failing: WrappedKeyStore = {
      get: () => { throw new Error('disk unavailable'); },
      create: () => { throw new Error('disk unavailable'); },
      deleteIfMatch: () => { throw new Error('disk unavailable'); },
    };
    const broker = new DesktopKeyBroker(failing);
    expect(await broker.state(context.userId)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(await broker.unlock(context.userId, 'correct horse battery staple'))
      .toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(await broker.initialize(context.userId, 'correct horse battery staple'))
      .toEqual({ success: false, error: 'vault_broker_unavailable' });
  });
});
