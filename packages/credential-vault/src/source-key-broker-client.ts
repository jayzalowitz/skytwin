import { randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  SOURCE_KEY_BROKER_PROTOCOL_VERSION,
  snapshotSourceKeyBrokerContext,
  snapshotSourceKeyBrokerControlMessage,
  snapshotSourceKeyBrokerRequest,
  snapshotSourceKeyBrokerResponse,
  snapshotSourceKeyEnvelope,
  sourceKeyBrokerFailure,
  type SourceKeyBrokerContext,
  type SourceKeyBrokerLockAckMessage,
  type SourceKeyBrokerOperation,
  type SourceKeyBrokerRequest,
  type SourceKeyBrokerResponseExpectation,
  type SourceKeyBrokerResult,
  type SourceKeyBrokerResultFor,
  type SourceKeyBrokerRole,
  type SourceKeyEnvelopeV2,
} from '@skytwin/shared-types';

/** Messages a child broker client is authorized to place on its private IPC. */
export type SourceKeyBrokerClientWireMessage =
  | SourceKeyBrokerRequest
  | SourceKeyBrokerLockAckMessage;

/**
 * Delivers one immutable protocol snapshot to the parent broker.
 *
 * A transport adapter should resolve only after the underlying IPC delivery
 * callback succeeds. A false result, a rejection, or a thrown exception is a
 * terminal disconnect: the client fails every pending request closed.
 */
export interface SourceKeyBrokerClientTransport {
  send(
    message: SourceKeyBrokerClientWireMessage,
  ): void | boolean | Promise<void | boolean>;
}

export interface SourceKeyBrokerClientOptions {
  readonly role: SourceKeyBrokerRole;
  readonly transport: SourceKeyBrokerClientTransport;
  readonly requestTimeoutMs?: number;
  readonly maxPendingRequests?: number;
  /** Test seam only. Production callers should use the cryptographic default. */
  readonly requestIdFactory?: () => string;
  /** Transport adapters use this to detach listeners on terminal disconnect. */
  readonly onDisconnect?: () => void;
}

export interface SourceKeyBrokerOwnerLeaseFailure {
  readonly success: false;
  readonly error: 'vault_locked' | 'vault_broker_unavailable';
}

export interface SourceKeyBrokerOwnerLeaseSuccess<T> {
  readonly success: true;
  readonly value: T;
}

export type SourceKeyBrokerOwnerLeaseResult<T> =
  | SourceKeyBrokerOwnerLeaseSuccess<T>
  | SourceKeyBrokerOwnerLeaseFailure;

interface PendingRequest {
  readonly expectation: SourceKeyBrokerResponseExpectation;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (result: SourceKeyBrokerResult) => void;
}

interface PendingLock {
  readonly lockId: string;
  readonly ownerId: string;
  readonly generation: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const MAX_PENDING_REQUESTS = 1_024;

function randomRequestId(): string {
  return randomBytes(16).toString('hex');
}

/** Read one own data string without invoking hostile accessors or proxies. */
function ownDataString(value: unknown, key: string): string | null {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

/**
 * Fail-closed child-side client for the versioned source-key broker protocol.
 *
 * This class deliberately owns no key material and grants no owners. Runtime
 * composition must feed messages from an already-private child IPC channel.
 */
export class SourceKeyBrokerClient {
  private readonly role: SourceKeyBrokerRole;
  private readonly transport: SourceKeyBrokerClientTransport;
  private readonly requestTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly requestIdFactory: () => string;
  private onDisconnect: (() => void) | null;
  private readonly generations = new Map<string, number>();
  private readonly lockedOwners = new Map<string, number>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeOwnerLeases = new Map<string, number>();
  private readonly pendingLocks = new Map<string, PendingLock>();
  private capability: Buffer | null = null;
  private disconnected = false;

  constructor(options: SourceKeyBrokerClientOptions) {
    if (
      !Number.isSafeInteger(
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ) ||
      (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) <= 0 ||
      (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) >
        MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new RangeError('requestTimeoutMs is outside the supported range');
    }
    if (
      !Number.isSafeInteger(
        options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      ) ||
      (options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS) <= 0 ||
      (options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS) >
        MAX_PENDING_REQUESTS
    ) {
      throw new RangeError('maxPendingRequests is outside the supported range');
    }
    this.role = options.role;
    this.transport = options.transport;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.requestIdFactory = options.requestIdFactory ?? randomRequestId;
    this.onDisconnect = options.onDisconnect ?? null;
  }

  /**
   * Accept one untrusted IPC payload. Unknown non-vault traffic is ignored;
   * malformed vault traffic terminates this client authority.
   */
  handleMessage(value: unknown): void {
    if (this.disconnected) return;

    const control = snapshotSourceKeyBrokerControlMessage(value);
    if (control) {
      if (control.type === 'skytwin:vault:capability') {
        if (control.role !== this.role) {
          this.handleDisconnect();
          return;
        }
        const capability = Buffer.from(control.capability, 'base64');
        if (this.capability !== null) {
          const matches = this.capability.equals(capability);
          capability.fill(0);
          if (!matches) this.handleDisconnect();
          return;
        }
        this.capability = capability;
        return;
      }

      if (control.type === 'skytwin:vault:generation') {
        if (!this.capability) {
          this.handleDisconnect();
          return;
        }
        this.acceptGeneration(control.ownerId, control.generation);
        return;
      }

      if (control.type === 'skytwin:vault:lock') {
        this.acceptLock(
          control.ownerId,
          control.generation,
          control.lockId,
        );
        return;
      }

      // Children never accept acknowledgements from their parent broker.
      this.handleDisconnect();
      return;
    }

    const type = ownDataString(value, 'type');
    if (type === 'skytwin:vault:response') {
      this.acceptResponse(value);
      return;
    }
    if (type?.startsWith('skytwin:vault:')) this.handleDisconnect();
  }

  /** A child-process disconnect is terminal; late messages cannot reconnect it. */
  handleDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.capability?.fill(0);
    this.capability = null;
    this.generations.clear();
    this.lockedOwners.clear();
    this.activeOwnerLeases.clear();
    this.pendingLocks.clear();
    this.settleAll('vault_broker_unavailable');
    const onDisconnect = this.onDisconnect;
    this.onDisconnect = null;
    if (onDisconnect) {
      try {
        onDisconnect();
      } catch {
        // Listener cleanup cannot restore a disconnected authority.
      }
    }
  }

  dispose(): void {
    this.handleDisconnect();
  }

  /**
   * Hold an owner-scoped lock-barrier lease around work that may retain source
   * plaintext after a broker response resolves (for example, a ciphertext-only
   * repository transaction). Lock closes new admission synchronously and its
   * acknowledgement waits for every admitted callback to finish or abort.
   * Callback failures are rethrown after the lease is released.
   */
  async runWithOwnerLease<T>(
    context: SourceKeyBrokerContext,
    callback: () => T | Promise<T>,
  ): Promise<Readonly<SourceKeyBrokerOwnerLeaseResult<T>>> {
    const canonicalContext = snapshotSourceKeyBrokerContext(context);
    if (
      this.disconnected ||
      !this.capability ||
      !canonicalContext ||
      !this.generations.has(canonicalContext.ownerId)
    ) {
      return Object.freeze({
        success: false,
        error: 'vault_broker_unavailable',
      });
    }
    if (this.lockedOwners.has(canonicalContext.ownerId)) {
      return Object.freeze({ success: false, error: 'vault_locked' });
    }

    const ownerId = canonicalContext.ownerId;
    this.activeOwnerLeases.set(
      ownerId,
      (this.activeOwnerLeases.get(ownerId) ?? 0) + 1,
    );
    try {
      const value = await callback();
      return Object.freeze({ success: true, value });
    } finally {
      this.releaseOwnerLease(ownerId);
    }
  }

  encrypt(
    context: SourceKeyBrokerContext,
    plaintext: string,
  ): Promise<Readonly<SourceKeyBrokerResultFor<'encrypt'>>> {
    return this.request('encrypt', context, { plaintext });
  }

  decrypt(
    context: SourceKeyBrokerContext,
    envelope: SourceKeyEnvelopeV2,
  ): Promise<Readonly<SourceKeyBrokerResultFor<'decrypt'>>> {
    return this.request('decrypt', context, { envelope });
  }

  rewrap(
    context: SourceKeyBrokerContext,
    envelope: SourceKeyEnvelopeV2,
  ): Promise<Readonly<SourceKeyBrokerResultFor<'rewrap'>>> {
    return this.request('rewrap', context, { envelope });
  }

  state(
    context: SourceKeyBrokerContext,
  ): Promise<Readonly<SourceKeyBrokerResultFor<'state'>>> {
    return this.request('state', context, {});
  }

  private request<O extends SourceKeyBrokerOperation>(
    operation: O,
    context: SourceKeyBrokerContext,
    payload:
      | Readonly<{ plaintext: string }>
      | Readonly<{ envelope: SourceKeyEnvelopeV2 }>
      | Readonly<Record<string, never>>,
  ): Promise<Readonly<SourceKeyBrokerResultFor<O>>> {
    const unavailable = (): Readonly<SourceKeyBrokerResultFor<O>> =>
      sourceKeyBrokerFailure(operation, 'vault_broker_unavailable');
    const canonicalContext = snapshotSourceKeyBrokerContext(context);
    if (
      this.disconnected ||
      !this.capability ||
      !canonicalContext ||
      this.pending.size >= this.maxPendingRequests
    ) {
      return Promise.resolve(unavailable());
    }
    if (
      operation !== 'state' &&
      this.lockedOwners.has(canonicalContext.ownerId)
    ) {
      return Promise.resolve(sourceKeyBrokerFailure(operation, 'vault_locked'));
    }
    const generation = this.generations.get(canonicalContext.ownerId);
    if (generation === undefined) return Promise.resolve(unavailable());

    if (
      (operation === 'decrypt' || operation === 'rewrap') &&
      ('envelope' in payload) &&
      !snapshotSourceKeyEnvelope(payload.envelope, canonicalContext)
    ) {
      return Promise.resolve(
        sourceKeyBrokerFailure(operation, 'ciphertext_invalid'),
      );
    }

    const requestId = this.allocateRequestId();
    if (!requestId) return Promise.resolve(unavailable());
    const candidate = {
      type: 'skytwin:vault:request',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId,
      capability: this.capability.toString('base64'),
      role: this.role,
      generation,
      operation,
      context: canonicalContext,
      ...payload,
    };
    const request = snapshotSourceKeyBrokerRequest(candidate);
    if (!request || request.operation !== operation) {
      return Promise.resolve(unavailable());
    }

    return new Promise<Readonly<SourceKeyBrokerResultFor<O>>>((resolve) => {
      const expectation: SourceKeyBrokerResponseExpectation = Object.freeze({
        requestId,
        generation,
        operation,
        context: canonicalContext,
      });
      const timer = setTimeout(() => {
        const entry = this.takePending(requestId);
        if (entry) entry.resolve(unavailable());
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        expectation,
        timer,
        resolve: (result) =>
          resolve(result as Readonly<SourceKeyBrokerResultFor<O>>),
      });
      this.deliver(request, requestId);
    });
  }

  private allocateRequestId(): string | null {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let requestId: string;
      try {
        requestId = this.requestIdFactory();
      } catch {
        return null;
      }
      if (/^[a-f0-9]{32}$/.test(requestId) && !this.pending.has(requestId)) {
        return requestId;
      }
    }
    return null;
  }

  private deliver(
    message: SourceKeyBrokerClientWireMessage,
    requestId?: string,
  ): void {
    let delivery: void | boolean | Promise<void | boolean>;
    try {
      delivery = this.transport.send(message);
    } catch {
      this.deliveryFailed(requestId);
      return;
    }
    if (delivery === false) {
      this.deliveryFailed(requestId);
      return;
    }
    if (delivery instanceof Promise) {
      void delivery.then(
        (delivered) => {
          if (delivered === false) this.deliveryFailed(requestId);
        },
        () => this.deliveryFailed(requestId),
      );
    }
  }

  private deliveryFailed(requestId?: string): void {
    if (requestId) {
      const entry = this.takePending(requestId);
      if (entry) {
        entry.resolve(
          sourceKeyBrokerFailure(
            entry.expectation.operation,
            'vault_broker_unavailable',
          ),
        );
      }
    }
    this.handleDisconnect();
  }

  private acceptResponse(value: unknown): void {
    const requestId = ownDataString(value, 'requestId');
    if (!requestId) {
      this.handleDisconnect();
      return;
    }
    const entry = this.pending.get(requestId);
    if (!entry) return;
    const response = snapshotSourceKeyBrokerResponse(value, entry.expectation);
    const claimed = this.takePending(requestId);
    if (!claimed) return;
    claimed.resolve(
      response?.result ??
        sourceKeyBrokerFailure(
          claimed.expectation.operation,
          'vault_broker_unavailable',
        ),
    );
  }

  private acceptGeneration(ownerId: string, generation: number): void {
    const current = this.generations.get(ownerId);
    if (current !== undefined && generation !== current) {
      this.handleDisconnect();
      return;
    }
    this.generations.set(ownerId, generation);
    const lockedGeneration = this.lockedOwners.get(ownerId);
    if (lockedGeneration !== undefined) {
      if (
        generation !== lockedGeneration ||
        this.pendingLocks.has(ownerId)
      ) {
        this.handleDisconnect();
        return;
      }
      this.lockedOwners.delete(ownerId);
    }
  }

  private acceptLock(
    ownerId: string,
    generation: number,
    lockId: string,
  ): void {
    const current = this.generations.get(ownerId);
    if (
      !this.capability ||
      current === undefined ||
      generation < current
    ) {
      this.handleDisconnect();
      return;
    }
    const existingLock = this.pendingLocks.get(ownerId);
    if (
      existingLock &&
      (existingLock.lockId !== lockId || existingLock.generation !== generation)
    ) {
      this.handleDisconnect();
      return;
    }
    this.generations.set(ownerId, generation);
    this.lockedOwners.set(ownerId, generation);
    this.settleOwner(ownerId, 'vault_locked');
    this.pendingLocks.set(ownerId, { lockId, ownerId, generation });
    this.acknowledgeDrainedLock(ownerId);
  }

  private acknowledgeDrainedLock(ownerId: string): void {
    if ((this.activeOwnerLeases.get(ownerId) ?? 0) !== 0) return;
    const lock = this.pendingLocks.get(ownerId);
    if (!lock || !this.capability || this.disconnected) return;
    this.pendingLocks.delete(ownerId);
    const acknowledgement: SourceKeyBrokerLockAckMessage = Object.freeze({
      type: 'skytwin:vault:lock-ack',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      lockId: lock.lockId,
      capability: this.capability.toString('base64'),
      role: this.role,
      ownerKind: 'user',
      ownerId: lock.ownerId,
      generation: lock.generation,
    });
    this.deliver(acknowledgement);
  }

  private releaseOwnerLease(ownerId: string): void {
    const active = this.activeOwnerLeases.get(ownerId);
    if (active === undefined) return;
    if (active > 1) {
      this.activeOwnerLeases.set(ownerId, active - 1);
      return;
    }
    this.activeOwnerLeases.delete(ownerId);
    this.acknowledgeDrainedLock(ownerId);
  }

  private takePending(requestId: string): PendingRequest | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    return entry;
  }

  private settleOwner(
    ownerId: string,
    error: 'vault_locked' | 'vault_broker_unavailable',
  ): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.expectation.context.ownerId !== ownerId) continue;
      const claimed = this.takePending(requestId);
      if (claimed) {
        claimed.resolve(
          sourceKeyBrokerFailure(claimed.expectation.operation, error),
        );
      }
    }
  }

  private settleAll(error: 'vault_broker_unavailable'): void {
    for (const requestId of [...this.pending.keys()]) {
      const entry = this.takePending(requestId);
      if (entry) {
        entry.resolve(
          sourceKeyBrokerFailure(entry.expectation.operation, error),
        );
      }
    }
  }
}
