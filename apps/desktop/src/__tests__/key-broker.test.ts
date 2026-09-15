import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import {
  snapshotSourceKeyBrokerControlMessage,
  snapshotSourceKeyBrokerOwnerAuthorityMessage,
  snapshotSourceKeyBrokerRequest,
} from '@skytwin/shared-types';
import {
  DesktopKeyBroker as ProductionDesktopKeyBroker,
  PersistentWrappedKeyStore,
  ROLE_FIELDS,
  type BrokerContext,
  type BrokerField,
  type BrokerRole,
  type WrappedKeyStore,
  type WrappedUserKey,
} from '../key-broker.js';

const protocolValidators = Object.freeze({
  snapshotSourceKeyBrokerControlMessage,
  snapshotSourceKeyBrokerOwnerAuthorityMessage,
  snapshotSourceKeyBrokerRequest,
});

class DesktopKeyBroker extends ProductionDesktopKeyBroker {
  constructor(
    store: ConstructorParameters<typeof ProductionDesktopKeyBroker>[0],
    options: NonNullable<
      ConstructorParameters<typeof ProductionDesktopKeyBroker>[1]
    > = {},
  ) {
    super(store, { ...options, protocolValidators });
  }
}

const EXPECTED_USER_FIELDS = [
  { purpose: 'credentials', table: 'oauth_tokens', column: 'access_token' },
  { purpose: 'credentials', table: 'oauth_tokens', column: 'refresh_token' },
  { purpose: 'credentials', table: 'ai_provider_settings', column: 'api_key' },
  { purpose: 'portable_config', table: 'mcp_servers', column: 'args' },
  { purpose: 'portable_config', table: 'mcp_servers', column: 'command' },
  { purpose: 'portable_config', table: 'mcp_servers', column: 'display_name' },
  { purpose: 'portable_config', table: 'mcp_servers', column: 'env' },
  { purpose: 'portable_config', table: 'mcp_servers', column: 'url' },
  { purpose: 'portable_config', table: 'federation_peers', column: 'endpoint_url' },
  { purpose: 'portable_config', table: 'federation_peers', column: 'label' },
  { purpose: 'portable_config', table: 'federation_peers', column: 'last_sync_error' },
  { purpose: 'portable_config', table: 'federation_peers', column: 'local_secret_key' },
  { purpose: 'portable_config', table: 'connector_cursors', column: 'cursor_value' },
  { purpose: 'portable_config', table: 'dxt_imports', column: 'artifact_blob' },
  { purpose: 'portable_config', table: 'dxt_imports', column: 'error_message' },
] as const satisfies readonly BrokerField[];

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
  killSignals: NodeJS.Signals[] = [];
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  autoAck = true;
  backpressure = false;
  asyncSendError: Error | null = null;
  afterSuccessfulSend: (() => void) | null = null;
  onKill: ((signal: NodeJS.Signals) => void) | null = null;
  send(value: unknown, callback?: (error: Error | null) => void) {
    this.sent.push(value);
    const message = value as Record<string, unknown>;
    if (this.autoAck && message['type'] === 'skytwin:vault:lock') {
      const capability = (this.sent[0] as { capability: string }).capability;
      const role = (this.sent[0] as { role: BrokerRole }).role;
      queueMicrotask(() => this.emit('message', {
        type: 'skytwin:vault:lock-ack',
        protocolVersion: 1,
        capability,
        lockId: message['lockId'],
        role,
        ownerKind: 'user',
        ownerId: message['ownerId'],
        generation: message['generation'],
      }));
    }
    if (this.asyncSendError) {
      const error = this.asyncSendError;
      queueMicrotask(() => {
        if (callback) callback(error);
        else this.emit('error', error);
      });
    } else if (callback) queueMicrotask(() => {
      callback(null);
      this.afterSuccessfulSend?.();
    });
    return !this.backpressure;
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killSignals.push(signal);
    this.killed = true;
    this.connected = false;
    if (this.onKill) this.onKill(signal);
    else this.emit('exit');
    return true;
  }
}
class DeviceStore {
  rows = new Map<string, string>();
  get(id: string) { return this.rows.get(id); }
  set(id: string, value: string) { this.rows.set(id, value); }
  delete(id: string) { this.rows.delete(id); }
  keys() { return [...this.rows.keys()]; }
}
const deviceProtection = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString(), getSelectedStorageBackend: () => 'keychain' };
const context: BrokerContext = {
  userId: '00000000-0000-0000-0000-000000000001',
  purpose: 'credentials',
  table: 'oauth_tokens',
  column: 'access_token',
  rowId: 'row-1',
};
const wireContext = (value: BrokerContext = context) => ({
  ownerKind: 'user' as const,
  ownerId: value.userId,
  purpose: value.purpose,
  table: value.table,
  column: value.column,
  rowId: value.rowId,
});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const OWNER_B = '00000000-0000-0000-0000-000000000002';
const TOKEN_HASH = 'a'.repeat(64);

describe('DesktopKeyBroker', () => {
  it('keeps the first exact grant stable and rejects same-session replacement', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession: vi.fn().mockResolvedValue({ status: 'active' }),
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    const expiresAtMs = Date.now() + 60_000;
    const base = {
      type: 'skytwin:vault:owner-grant-request' as const, protocolVersion: 1 as const,
      capability, role: 'api' as const, ownerKind: 'user' as const,
      ownerId: context.userId, sessionId: SESSION_A, tokenHash: TOKEN_HASH, expiresAtMs,
    };
    child.emit('message', { ...base, requestId: '1'.repeat(32) });
    child.emit('message', { ...base, requestId: '2'.repeat(32) });
    await tick();
    await tick();
    const first = child.sent.find((value) =>
      (value as { requestId?: string }).requestId === '1'.repeat(32)) as { grantId: string };
    const second = child.sent.find((value) =>
      (value as { requestId?: string }).requestId === '2'.repeat(32)) as { grantId: string };
    expect(second.grantId).toBe(first.grantId);

    child.emit('message', {
      ...base, requestId: '3'.repeat(32), ownerId: OWNER_B,
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({ requestId: '3'.repeat(32), success: false });
  });

  it('denies transient revalidation failure without revoking a live grant', async () => {
    const verifySession = vi.fn()
      .mockResolvedValueOnce({ status: 'active' })
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'active' });
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), { verifySession });
    const capability = (child.sent[0] as { capability: string }).capability;
    const expiresAtMs = Date.now() + 60_000;
    child.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: '4'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A, tokenHash: TOKEN_HASH, expiresAtMs,
    });
    await tick();
    const grantId = (child.sent.at(-1) as { grantId: string }).grantId;
    for (const requestId of ['5'.repeat(32), '6'.repeat(32)]) {
      child.emit('message', {
        type: 'skytwin:vault:request', protocolVersion: 1, requestId,
        capability, role: 'api', generation: 1, operation: 'state',
        context: wireContext(),
        authority: { kind: 'api_session', sessionId: SESSION_A, grantId },
      });
      await tick();
    }
    expect(child.sent.at(-2)).toMatchObject({
      requestId: '5'.repeat(32), result: { success: false },
    });
    expect(child.sent.at(-1)).toMatchObject({
      requestId: '6'.repeat(32), result: { success: true },
    });
  });

  it('starts empty and grants only an exact DB-revalidated API session', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    const verifySession = vi.fn().mockResolvedValue({ status: 'active' });
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession,
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    const expiresAtMs = Date.now() + 60_000;

    child.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1,
      requestId: '1'.repeat(32), capability, role: 'api', generation: 1,
      operation: 'state', context: wireContext(),
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId: '1'.repeat(32),
      result: { success: false, error: 'vault_broker_unavailable' },
    });

    child.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: '2'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    await tick();
    expect(verifySession).toHaveBeenCalledWith({
      ownerId: context.userId, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    const grant = child.sent.at(-1) as {
      success: boolean; grantId: string; generation: number;
    };
    expect(grant).toMatchObject({ success: true, generation: 1 });

    child.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1,
      requestId: '3'.repeat(32), capability, role: 'api', generation: 1,
      operation: 'state', context: wireContext(),
      authority: { kind: 'api_session', sessionId: SESSION_A, grantId: grant.grantId },
    });
    await tick();
    expect(verifySession).toHaveBeenCalledTimes(2);
    expect(child.sent.at(-1)).toMatchObject({
      requestId: '3'.repeat(32),
      result: { success: true, state: 'unlocked' },
    });

    for (const [requestId, authority, ownerId] of [
      ['4'.repeat(32), { kind: 'api_session', sessionId: SESSION_B, grantId: grant.grantId }, context.userId],
      ['5'.repeat(32), { kind: 'api_session', sessionId: SESSION_A, grantId: 'f'.repeat(32) }, context.userId],
      ['6'.repeat(32), { kind: 'api_session', sessionId: SESSION_A, grantId: grant.grantId }, OWNER_B],
    ] as const) {
      child.emit('message', {
        type: 'skytwin:vault:request', protocolVersion: 1,
        requestId, capability, role: 'api', generation: 1,
        operation: 'state', context: wireContext({ ...context, userId: ownerId }),
        authority,
      });
      await tick();
      expect(child.sent.at(-1)).toMatchObject({
        requestId,
        result: { success: false, error: 'vault_broker_unavailable' },
      });
    }

    child.emit('message', {
      type: 'skytwin:vault:owner-revoke', protocolVersion: 1,
      requestId: '7'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
      unexpected: true,
    });
    child.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1,
      requestId: '8'.repeat(32), capability, role: 'api', generation: 1,
      operation: 'state', context: wireContext(),
      authority: { kind: 'api_session', sessionId: SESSION_A, grantId: grant.grantId },
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId: '8'.repeat(32),
      result: { success: false, error: 'vault_broker_unavailable' },
    });
  });

  it('makes revoke beat a delayed grant and rejects replay and malformed authority', async () => {
    let release!: (live: { status: 'active' }) => void;
    const delayed = new Promise<{ status: 'active' }>(resolve => { release = resolve; });
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession: () => delayed,
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    const expiresAtMs = Date.now() + 60_000;
    const grantRequest = {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: '7'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    } as const;
    child.emit('message', grantRequest);
    await tick();
    child.emit('message', {
      type: 'skytwin:vault:owner-revoke', protocolVersion: 1,
      requestId: '8'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
    });
    release({ status: 'active' });
    await tick();
    await tick();
    expect(child.sent.find((message) =>
      (message as { requestId?: string; success?: boolean }).requestId === grantRequest.requestId &&
      (message as { success?: boolean }).success === true)).toBeUndefined();

    child.emit('message', grantRequest);
    await tick();
    expect(child.sent.find((message) =>
      (message as { requestId?: string; success?: boolean }).requestId === grantRequest.requestId &&
      (message as { success?: boolean }).success === true)).toBeUndefined();

    child.emit('message', {
      ...grantRequest,
      requestId: '9'.repeat(32),
      role: 'worker',
    });
    await tick();
    child.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1,
      requestId: 'a'.repeat(32), capability, role: 'api', generation: 1,
      operation: 'state', context: wireContext(),
      authority: { kind: 'api_session', sessionId: SESSION_A, grantId: 'b'.repeat(32) },
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId: 'a'.repeat(32),
      result: { success: false, error: 'vault_broker_unavailable' },
    });
  });

  it('rejects a grant whose revalidation crosses an owner lock generation', async () => {
    let release!: (live: { status: 'active' }) => void;
    const delayed = new Promise<{ status: 'active' }>(resolve => { release = resolve; });
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession: () => delayed,
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    child.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: 'a'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000,
    });
    await tick();
    await broker.lock(context.userId);
    release({ status: 'active' });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId: 'a'.repeat(32), success: false,
    });
  });

  it('revalidates on use and isolates concurrent sessions and owners', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const verifySession = vi.fn().mockResolvedValue({ status: 'active' });
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession,
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    const expiresAtMs = Date.now() + 60_000;
    const fixtures = [
      { requestId: 'f'.repeat(32), ownerId: context.userId, sessionId: SESSION_A },
      { requestId: '0'.repeat(32), ownerId: OWNER_B, sessionId: SESSION_B },
    ];
    for (const fixture of fixtures) {
      child.emit('message', {
        type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
        capability, role: 'api', ownerKind: 'user', tokenHash: TOKEN_HASH,
        expiresAtMs, ...fixture,
      });
      await tick();
    }
    const grants = fixtures.map((fixture) => child.sent.find((message) =>
      (message as { requestId?: string; success?: boolean }).requestId === fixture.requestId &&
      (message as { success?: boolean }).success === true) as { grantId: string });
    expect(grants.every(Boolean)).toBe(true);

    for (const [index, fixture] of fixtures.entries()) {
      const requestId = `${index + 1}`.repeat(32);
      child.emit('message', {
        type: 'skytwin:vault:request', protocolVersion: 1,
        requestId, capability, role: 'api',
        generation: index === 0 ? 1 : 0,
        operation: 'state',
        context: wireContext({ ...context, userId: fixture.ownerId }),
        authority: {
          kind: 'api_session', sessionId: fixture.sessionId,
          grantId: grants[index]!.grantId,
        },
      });
      await tick();
      expect(child.sent.at(-1)).toMatchObject({
        requestId,
        result: index === 0
          ? { success: true, state: 'unlocked' }
          : { success: true, state: 'uninitialized' },
      });
    }

    verifySession.mockResolvedValue({ status: 'inactive' });
    child.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1,
      requestId: '3'.repeat(32), capability, role: 'api', generation: 1,
      operation: 'state', context: wireContext(),
      authority: {
        kind: 'api_session', sessionId: SESSION_A, grantId: grants[0]!.grantId,
      },
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId: '3'.repeat(32),
      result: { success: false, error: 'vault_broker_unavailable' },
    });
  });

  it('bounds live authority tombstones by closing the binding', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    const child = new FakeChild();
    const verifySession = vi.fn().mockResolvedValue({ status: 'active' });
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession,
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    for (let index = 1; index <= 1_025; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      child.emit('message', {
        type: 'skytwin:vault:owner-revoke', protocolVersion: 1,
        requestId: index.toString(16).padStart(32, '0'), capability,
        role: 'api', ownerKind: 'user', ownerId: context.userId,
        sessionId: `00000000-0000-4000-8000-${suffix}`,
      });
    }
    child.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: 'e'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000,
    });
    await tick();
    expect(verifySession).not.toHaveBeenCalled();
    expect(child.sent).toHaveLength(1);
  });

  it('does not carry a session grant across child restart or admit one during lock', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), { lockAckTimeoutMs: 1_000 });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const verifySession = vi.fn().mockResolvedValue({ status: 'active' });
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set(), {
      verifySession,
    });
    const capability = (child.sent[0] as { capability: string }).capability;
    const expiresAtMs = Date.now() + 60_000;
    child.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: 'b'.repeat(32), capability, role: 'api', ownerKind: 'user',
      ownerId: context.userId, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    await tick();
    const grantId = (child.sent.at(-1) as { grantId: string }).grantId;
    child.emit('exit');

    const restarted = new FakeChild();
    await broker.attachChild(restarted as unknown as ChildProcess, 'api', new Set(), {
      verifySession,
    });
    const restartedCapability = (restarted.sent[0] as { capability: string }).capability;
    restarted.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1,
      requestId: 'c'.repeat(32), capability: restartedCapability,
      role: 'api', generation: 1, operation: 'state', context: wireContext(),
      authority: { kind: 'api_session', sessionId: SESSION_A, grantId },
    });
    await tick();
    expect(restarted.sent.at(-1)).toMatchObject({
      requestId: 'c'.repeat(32),
      result: { success: false, error: 'vault_broker_unavailable' },
    });

    restarted.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: 'd'.repeat(32), capability: restartedCapability,
      role: 'api', ownerKind: 'user', ownerId: context.userId,
      sessionId: SESSION_B, tokenHash: TOKEN_HASH, expiresAtMs,
    });
    await tick();
    expect(restarted.sent.at(-1)).toMatchObject({
      requestId: 'd'.repeat(32), success: true,
    });

    restarted.autoAck = false;
    const locking = broker.lock(context.userId);
    await tick();
    restarted.emit('message', {
      type: 'skytwin:vault:owner-grant-request', protocolVersion: 1,
      requestId: 'e'.repeat(32), capability: restartedCapability,
      role: 'api', ownerKind: 'user', ownerId: context.userId,
      sessionId: SESSION_A, tokenHash: TOKEN_HASH, expiresAtMs,
    });
    await tick();
    expect(restarted.sent.at(-1)).toMatchObject({
      requestId: 'e'.repeat(32), success: false,
    });
    const lock = restarted.sent.find((message) =>
      (message as { type?: string }).type === 'skytwin:vault:lock') as {
        lockId: string; generation: number;
      };
    restarted.emit('message', {
      type: 'skytwin:vault:lock-ack', protocolVersion: 1,
      lockId: lock.lockId, capability: restartedCapability,
      role: 'api', ownerKind: 'user', ownerId: context.userId,
      generation: lock.generation,
    });
    await expect(locking).resolves.toMatchObject({ success: true });
  });

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

  it('rejects a syntactically valid persisted canary mutation during initialization', async () => {
    let persisted: WrappedUserKey | undefined;
    const store: WrappedKeyStore = {
      get: () => persisted,
      create: (_id, row) => {
        persisted = structuredClone(row);
        persisted.canary = {
          ...persisted.canary,
          ciphertext: Buffer.alloc(
            Buffer.from(persisted.canary.ciphertext, 'base64').length,
            7,
          ).toString('base64'),
        };
        return true;
      },
      deleteIfMatch: (_id, row) => {
        if (JSON.stringify(persisted) !== JSON.stringify(row)) return false;
        persisted = undefined;
        return true;
      },
    };
    const broker = new DesktopKeyBroker(store);

    expect(await broker.initialize(context.userId, 'correct horse battery staple')).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(persisted).toBeDefined();
    expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
  });

  it('rejects and retains a different valid durable wrapper winner', async () => {
    const winnerStore = new MemoryStore();
    const winnerBroker = new DesktopKeyBroker(winnerStore);
    await winnerBroker.initialize(context.userId, 'correct horse battery staple');
    const winner = structuredClone(winnerStore.rows.get(context.userId)!);
    let persisted: WrappedUserKey | undefined;
    const store: WrappedKeyStore = {
      get: () => persisted,
      create: () => {
        persisted = structuredClone(winner);
        return true;
      },
      deleteIfMatch: (_id, row) => {
        if (JSON.stringify(persisted) !== JSON.stringify(row)) return false;
        persisted = undefined;
        return true;
      },
    };
    const broker = new DesktopKeyBroker(store);

    expect(await broker.initialize(context.userId, 'correct horse battery staple')).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(persisted).toEqual(winner);
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' });
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

  it('revokes an existing unlocked key when replacement unlock cannot drain a child', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 5,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = () => { /* Signal accepted without proven termination. */ };
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));

    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'unlocked' });
    expect(await broker.unlock(context.userId, 'correct horse battery staple')).toEqual({
      success: false,
      error: 'vault_locked',
    });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await broker.state(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
  });

  it('does not reopen from a device wrapper when lock completes during its registry read', async () => {
    const store = new PausableGetStore(), devices = new DeviceStore();
    const broker = new DesktopKeyBroker(store, { deviceProtection, deviceStore: devices, platform: 'darwin' });
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
    expect(encrypted.envelope).toMatchObject({ magic: 'skytwin-envelope', algorithm: 'aes-256-gcm', ownerKind: 'user', purpose: 'credentials' });
    expect(broker.decrypt(context, encrypted.envelope)).toEqual({ success: true, plaintext: 'fixture-secret' });
    expect(broker.decrypt({ ...context, rowId: 'row-2' }, encrypted.envelope)).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(broker.decrypt({ ...context, purpose: 'portable_config' }, encrypted.envelope)).toMatchObject({ success: false });
  });

  it(
    'round-trips plaintext at the advertised 16 MiB envelope limit',
    async () => {
      const broker = new DesktopKeyBroker(new MemoryStore());
      await broker.initialize(context.userId, 'correct horse battery staple');
      const plaintext = 'x'.repeat(16 * 1024 * 1024);
      const encrypted = broker.encrypt(context, plaintext);
      expect(encrypted.success).toBe(true);
      if (!encrypted.success) return;
      expect(broker.decrypt(context, encrypted.envelope)).toEqual({ success: true, plaintext });
      expect(broker.encrypt(context, `${plaintext}x`)).toEqual({
        success: false,
        error: 'ciphertext_invalid',
      });
    },
    30_000,
  );

  it('rejects malformed and oversized ciphertext without permissive base64 decoding', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const encrypted = broker.encrypt(context, 'fixture-secret'); if (!encrypted.success) throw new Error('setup');
    expect(broker.decrypt(context, { ...encrypted.envelope, iv: '!!!!' })).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(broker.decrypt(context, { ...encrypted.envelope, tag: 'YQ==' })).toEqual({ success: false, error: 'ciphertext_invalid' });
  });

  it('binds capability, role, exact field tuple, and owner to one child', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId: '0'.repeat(32), capability, role: 'api', generation: 1, operation: 'encrypt', context: { ownerKind: 'user', ownerId: context.userId, purpose: context.purpose, table: context.table, column: context.column, rowId: context.rowId }, plaintext: 'secret' }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: true } });
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId: '1'.repeat(32), capability, role: 'api', generation: 1, operation: 'state', context: { ownerKind: 'user', ownerId: '00000000-0000-0000-0000-000000000002', purpose: context.purpose, table: context.table, column: context.column, rowId: context.rowId } }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId: 'a'.repeat(32), capability, role: 'api', generation: 1, operation: 'state', context: { ownerKind: 'user', ownerId: context.userId, purpose: context.purpose, table: 'unknown_source', column: 'secret', rowId: context.rowId } }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    const sentBeforeMalformed = child.sent.length;
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId: '2'.repeat(32), capability, role: 'api', generation: 1, operation: 'encrypt', context: { ownerKind: 'user', ownerId: context.userId, purpose: 'credentials', table: 'oauth_tokens:access', column: 'token', rowId: context.rowId }, plaintext: 'secret' }); await tick();
    expect(child.sent).toHaveLength(sentBeforeMalformed);
  });

  it('emits exact protocol responses and rejects hostile wire objects without property access', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    const requestId = '5'.repeat(32);
    child.emit('message', {
      type: 'skytwin:vault:request',
      protocolVersion: 1,
      requestId,
      capability,
      role: 'api',
      generation: 1,
      operation: 'encrypt',
      context: wireContext(),
      plaintext: 'fixture-secret',
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      type: 'skytwin:vault:response',
      protocolVersion: 1,
      requestId,
      generation: 1,
      context: wireContext(),
      result: { success: true, operation: 'encrypt' },
    });

    let accessed = false;
    const hostile = {
      protocolVersion: 1,
      requestId: '6'.repeat(32),
      capability,
      role: 'api',
      generation: 1,
      operation: 'state',
      context: wireContext(),
    } as Record<string, unknown>;
    Object.defineProperty(hostile, 'type', {
      enumerable: true,
      get: () => {
        accessed = true;
        return 'skytwin:vault:request';
      },
    });
    const sentBeforeHostile = child.sent.length;
    child.emit('message', hostile);
    child.emit('message', new Proxy({
      type: 'skytwin:vault:request',
      protocolVersion: 1,
      requestId: '7'.repeat(32),
      capability,
      role: 'api',
      generation: 1,
      operation: 'state',
      context: wireContext(),
    }, { get: () => { accessed = true; throw new Error('must not read'); } }));
    await tick();
    expect(accessed).toBe(false);
    expect(child.sent).toHaveLength(sentBeforeHostile);
  });

  it(
    'enforces the 16 MiB plaintext boundary through the versioned child protocol',
    async () => {
      const broker = new DesktopKeyBroker(new MemoryStore());
      await broker.initialize(context.userId, 'correct horse battery staple');
      const child = new FakeChild();
      await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
      const capability = (child.sent[0] as { capability: string }).capability;
      const maximum = 'x'.repeat(16 * 1024 * 1024);
      child.emit('message', {
        type: 'skytwin:vault:request', protocolVersion: 1,
        requestId: '8'.repeat(32), capability, role: 'api', generation: 1,
        operation: 'encrypt', context: wireContext(), plaintext: maximum,
      });
      await tick();
      expect(child.sent.at(-1)).toMatchObject({
        result: { success: true, operation: 'encrypt' },
      });

      const beforeOversized = child.sent.length;
      child.emit('message', {
        type: 'skytwin:vault:request', protocolVersion: 1,
        requestId: '9'.repeat(32), capability, role: 'api', generation: 1,
        operation: 'encrypt', context: wireContext(), plaintext: `${maximum}x`,
      });
      await tick();
      expect(child.sent).toHaveLength(beforeOversized);
    },
    30_000,
  );

  it('maps every role permission to an inventoried user-owned encrypted source field', () => {
    expect(ROLE_FIELDS).toEqual({
      api: EXPECTED_USER_FIELDS,
      worker: EXPECTED_USER_FIELDS,
    });
    expect(Object.isFrozen(ROLE_FIELDS)).toBe(true);
    expect(Object.isFrozen(ROLE_FIELDS.api)).toBe(true);
    expect(Object.isFrozen(ROLE_FIELDS.worker)).toBe(true);
    expect(ROLE_FIELDS.api.every(field => Object.isFrozen(field))).toBe(true);
    expect(ROLE_FIELDS.worker.every(field => Object.isFrozen(field))).toBe(true);

    const inventory = JSON.parse(readFileSync(
      new URL('../../../../docs/security/encryption-field-inventory.json', import.meta.url),
      'utf8',
    )) as {
      tables: Array<{
        table: string;
        owner: string;
        groups: Array<{ classification: string; columns: string[] }>;
      }>;
    };
    for (const field of EXPECTED_USER_FIELDS) {
      const table = inventory.tables.find(candidate => candidate.table === field.table);
      const group = table?.groups.find(candidate => candidate.columns.includes(field.column));
      expect(
        { owner: table?.owner, classification: group?.classification },
        `${field.table}.${field.column}`,
      ).toEqual({ owner: 'user', classification: 'encrypted_source' });
    }

    const pkce = inventory.tables.find(candidate => candidate.table === 'oauth_pkce_pending');
    expect(pkce?.owner).toBe('installation');
  });

  it('allows every role field through child IPC and denies installation-owned PKCE', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');

    for (const role of ['api', 'worker'] satisfies readonly BrokerRole[]) {
      const child = new FakeChild();
      await broker.attachChild(child as unknown as ChildProcess, role, new Set([context.userId]));
      const capability = (child.sent[0] as { capability: string }).capability;
      for (const [index, field] of EXPECTED_USER_FIELDS.entries()) {
        const requestId = `${role === 'api' ? 'a' : 'b'}${index.toString(16).padStart(31, '0')}`;
        child.emit('message', {
          type: 'skytwin:vault:request',
          protocolVersion: 1,
          requestId,
          capability,
          role,
          generation: 1,
          operation: 'encrypt',
          context: {
            ...field,
            ownerKind: 'user',
            ownerId: context.userId,
            rowId: `row-${index}`,
          },
          plaintext: 'secret',
        });
        await tick();
        expect(
          child.sent.find(value => (value as { requestId?: string }).requestId === requestId),
          `${role}:${field.table}.${field.column}`,
        ).toMatchObject({ result: { success: true } });
      }

      const requestId = `${role === 'api' ? 'c' : 'd'}${'0'.repeat(31)}`;
      child.emit('message', {
        type: 'skytwin:vault:request',
        protocolVersion: 1,
        requestId,
        capability,
        role,
        generation: 1,
        operation: 'encrypt',
        context: {
          ownerKind: 'user',
          ownerId: context.userId,
          purpose: 'portable_config',
          table: 'oauth_pkce_pending',
          column: 'code_verifier',
          rowId: 'pkce-state',
        },
        plaintext: 'verifier',
      });
      await tick();
      expect(child.sent.find(value => (value as { requestId?: string }).requestId === requestId))
        .toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    }
  });

  it('denies every request when a child has no owner grants', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); await broker.attachChild(child as unknown as ChildProcess, 'api', new Set());
    const capability = (child.sent[0] as { capability: string }).capability;
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId: 'e'.repeat(32), capability, role: 'api', generation: 1, operation: 'encrypt', context: { ownerKind: 'user', ownerId: context.userId, purpose: context.purpose, table: context.table, column: context.column, rowId: context.rowId }, plaintext: 'secret' }); await tick();
    expect(child.sent.at(-1)).toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    const response = JSON.stringify(child.sent.at(-1));
    expect(response).not.toContain('secret');
    expect(response).not.toContain(capability);
  });

  it('keeps admission closed until overlapping locks for that user finish', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore()); await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    const first = broker.lock(context.userId), second = broker.lock(context.userId);
    const requestId = 'f'.repeat(32);
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId, capability, role: 'api', generation: 1, operation: 'state', context: { ownerKind: 'user', ownerId: context.userId, purpose: context.purpose, table: context.table, column: context.column, rowId: context.rowId } }); await tick();
    expect(child.sent.find(value => (value as { requestId?: string }).requestId === requestId))
      .toMatchObject({ result: { success: false, error: 'vault_broker_unavailable' } });
    await Promise.all([first, second]);
  });

  it('publishes the installed generation only after the child lock barrier', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    await broker.attachChild(
      child as unknown as ChildProcess,
      'api',
      new Set([context.userId]),
    );

    expect(await broker.unlock(
      context.userId,
      'correct horse battery staple',
    )).toEqual({ success: true, generation: 2 });
    const lockIndex = child.sent.findIndex(
      value => (value as { type?: string }).type === 'skytwin:vault:lock',
    );
    const readyIndex = child.sent.findLastIndex(
      value => (value as { type?: string }).type === 'skytwin:vault:generation',
    );
    expect(lockIndex).toBeGreaterThan(0);
    expect(readyIndex).toBeGreaterThan(lockIndex);
    expect(child.sent[readyIndex]).toMatchObject({
      ownerId: context.userId,
      generation: 2,
    });
  });

  it('refuses to create a device wrapper while a lock is draining child work', async () => {
    const store = new PausableGetStore(), devices = new DeviceStore();
    const broker = new DesktopKeyBroker(store, { deviceProtection, deviceStore: devices, platform: 'darwin' });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild(); await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    const capability = (child.sent[0] as { capability: string }).capability;
    store.pauseNextGet();
    child.emit('message', { type: 'skytwin:vault:request', protocolVersion: 1, requestId: '3'.repeat(32), capability, role: 'api', generation: 1, operation: 'state', context: { ownerKind: 'user', ownerId: context.userId, purpose: context.purpose, table: context.table, column: context.column, rowId: context.rowId } });
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
    const broker = new DesktopKeyBroker(registry, { deviceProtection, deviceStore: devices, platform: 'darwin' });
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
    const broker = new DesktopKeyBroker(registry, { deviceProtection, deviceStore: devices, platform: 'darwin' });
    await broker.initialize(context.userId, 'correct horse battery staple');
    devices.set(context.userId, 'not-base64'); await broker.lock(context.userId);
    expect(await broker.unlockFromDevice(context.userId)).toEqual({ success: false, error: 'ciphertext_invalid' });
    expect(devices.get(context.userId)).toBeUndefined();
    const unsupported = new DesktopKeyBroker(registry, { deviceProtection: { ...deviceProtection, isEncryptionAvailable: () => false }, deviceStore: devices, platform: 'darwin' });
    expect(await unsupported.unlock(context.userId, 'correct horse battery staple')).toMatchObject({ success: true });
    expect(unsupported.rememberDevice(context.userId)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(await unsupported.unlockFromDevice(context.userId)).toEqual({ success: false, error: 'vault_broker_unavailable' });
    const throws = new DesktopKeyBroker(registry, { deviceProtection: { ...deviceProtection, isEncryptionAvailable: () => { throw new Error('backend unavailable'); } }, deviceStore: devices, platform: 'darwin' });
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

  it('does not report locked until an in-progress child barrier completes', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 25,
      childExitTimeoutMs: 25,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));

    const locking = broker.lock(context.userId);
    expect(await broker.state(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(await locking).toMatchObject({ success: true });
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' });
  });

  it('rejects duplicate child attachment without completing its pending lock barrier', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 50,
      childExitTimeoutMs: 5,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = () => { /* Signal accepted without proven termination. */ };
    expect(await broker.attachChild(
      child as unknown as ChildProcess,
      'api',
      new Set([context.userId]),
    )).toBe(true);
    const messageListeners = child.listenerCount('message');
    const locking = broker.lock(context.userId);
    await tick();

    expect(await broker.attachChild(
      child as unknown as ChildProcess,
      'worker',
      new Set([context.userId]),
    )).toBe(false);
    expect(child.listenerCount('message')).toBe(messageListeners);
    expect(await locking).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
      generation: 2,
    });
  });

  it('rejects attachment when initial capability delivery fails asynchronously', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 5,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.asyncSendError = new Error('IPC channel closed asynchronously');
    child.onKill = () => { /* Signal accepted without proven termination. */ };

    expect(await broker.attachChild(
      child as unknown as ChildProcess,
      'api',
      new Set([context.userId]),
    )).toBe(false);
    expect(child.killSignals).toEqual([]);
  });

  it('does not treat failed live-child attachment cleanup as a lock acknowledgement', async () => {
    const secondUserId = '00000000-0000-0000-0000-000000000002';
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 5,
    });
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = () => { /* Signal accepted without proven termination. */ };
    const originalSend = child.send.bind(child);
    let failSecondGeneration: ((error: Error | null) => void) | undefined;
    child.send = (value, callback) => {
      const message = value as Record<string, unknown>;
      if (
        message['type'] === 'skytwin:vault:generation'
        && message['ownerId'] === secondUserId
      ) {
        child.sent.push(value);
        failSecondGeneration = callback;
        return true;
      }
      return originalSend(value, callback);
    };

    const attaching = broker.attachChild(
      child as unknown as ChildProcess,
      'api',
      new Set([context.userId, secondUserId]),
    );
    for (let attempt = 0; attempt < 10 && !failSecondGeneration; attempt++) await tick();
    expect(failSecondGeneration).toBeDefined();

    const locking = broker.lock(context.userId);
    await tick();
    failSecondGeneration?.(new Error('generation delivery failed'));

    expect(await attaching).toBe(false);
    expect(await locking).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
      generation: 1,
    });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.exitCode).toBeNull();
    child.emit('exit');
  });

  it('rejects and cleans up a child that exits while protocol validators load', async () => {
    let resolveValidators!: (validators: typeof protocolValidators) => void;
    const validators = new Promise<typeof protocolValidators>(resolve => {
      resolveValidators = resolve;
    });
    const broker = new ProductionDesktopKeyBroker(new MemoryStore(), {
      protocolValidators: validators,
    });
    const child = new FakeChild();

    const attaching = broker.attachChild(
      child as unknown as ChildProcess,
      'api',
      new Set([context.userId]),
    );
    expect(child.listenerCount('message')).toBe(1);
    expect(child.listenerCount('exit')).toBe(1);
    child.exitCode = 1;
    child.connected = false;
    child.emit('exit', 1);
    resolveValidators(protocolValidators);

    expect(await attaching).toBe(false);
    expect(child.sent).toEqual([]);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('rejects an exit between a successful delivery callback and await continuation', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    const child = new FakeChild();
    child.afterSuccessfulSend = () => {
      child.afterSuccessfulSend = null;
      child.exitCode = 1;
      child.connected = false;
      child.emit('exit', 1);
    };

    expect(await broker.attachChild(
      child as unknown as ChildProcess,
      'worker',
      new Set(),
    )).toBe(false);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('accepts initial IPC backpressure when delivery callbacks succeed', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 25,
    });
    const child = new FakeChild();
    child.backpressure = true;

    expect(await broker.attachChild(
      child as unknown as ChildProcess,
      'worker',
      new Set(),
    )).toBe(true);
    expect(child.sent[0]).toMatchObject({
      type: 'skytwin:vault:capability',
      role: 'worker',
    });
  });

  it('does not report locked when clock expiry reaches an unproven child barrier first', async () => {
    let now = 1_000;
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      now: () => now,
      ttlMs: 60_000,
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 5,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = () => { /* Signal accepted without proven termination. */ };
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    now += 60_001;

    expect(await broker.state(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await broker.state(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
  });

  it('waits for delayed child exit after the acknowledgement deadline', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 50,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = signal => {
      if (signal === 'SIGTERM') setTimeout(() => child.emit('exit'), 10);
    };
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));
    expect(await broker.lock(context.userId)).toMatchObject({ success: true });
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
  });

  it('escalates to SIGKILL and waits for forced child close', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 5,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = signal => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close'));
    };
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));

    expect(await broker.lock(context.userId)).toMatchObject({ success: true });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('fails closed when kill signals do not produce an exit or close event', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore(), {
      lockAckTimeoutMs: 5,
      childExitTimeoutMs: 5,
    });
    await broker.initialize(context.userId, 'correct horse battery staple');
    const child = new FakeChild();
    child.autoAck = false;
    child.onKill = () => { /* Signal accepted without proven termination. */ };
    await broker.attachChild(child as unknown as ChildProcess, 'api', new Set([context.userId]));

    expect(await broker.lock(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
      generation: 2,
    });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await broker.state(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(broker.encrypt(context, 'secret')).toEqual({ success: false, error: 'vault_locked' });
    expect(await broker.unlock(context.userId, 'correct horse battery staple'))
      .toEqual({ success: false, error: 'vault_locked' });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
    expect(await broker.state(context.userId)).toEqual({
      success: false,
      error: 'vault_broker_unavailable',
    });
    child.emit('exit');
    expect(await broker.lock(context.userId)).toMatchObject({ success: true });
    expect(await broker.state(context.userId)).toEqual({ success: true, state: 'locked' });
  });

  it('snapshots child owner grants instead of retaining a mutable set', async () => {
    const broker = new DesktopKeyBroker(new MemoryStore());
    await broker.initialize(context.userId, 'correct horse battery staple');
    const grants = new Set([context.userId]);
    const child = new FakeChild();
    await broker.attachChild(child as unknown as ChildProcess, 'api', grants);
    grants.add('00000000-0000-0000-0000-000000000002');
    const capability = (child.sent[0] as { capability: string }).capability;
    const requestId = '4'.repeat(32);
    child.emit('message', {
      type: 'skytwin:vault:request', protocolVersion: 1, requestId, capability, role: 'api',
      generation: 1, operation: 'state', context: { ownerKind: 'user', ownerId: '00000000-0000-0000-0000-000000000002', purpose: context.purpose, table: context.table, column: context.column, rowId: context.rowId },
    });
    await tick();
    expect(child.sent.at(-1)).toMatchObject({
      requestId,
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
