import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOURCE_KEY_BROKER_PROTOCOL_VERSION,
  type SourceKeyBrokerContext,
  type SourceKeyBrokerRequest,
  type SourceKeyBrokerResult,
  type SourceKeyEnvelopeV2,
} from '@skytwin/shared-types';
import {
  SourceKeyBrokerClient,
  type SourceKeyBrokerClientTransport,
  type SourceKeyBrokerClientWireMessage,
} from '../source-key-broker-client.js';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const CAPABILITY = Buffer.alloc(32, 7).toString('base64');

const contextA: SourceKeyBrokerContext = Object.freeze({
  ownerKind: 'user',
  ownerId: OWNER_A,
  purpose: 'credentials',
  table: 'oauth_tokens',
  column: 'access_token',
  rowId: 'row-a',
});

const contextB: SourceKeyBrokerContext = Object.freeze({
  ...contextA,
  ownerId: OWNER_B,
  rowId: 'row-b',
});

const envelope: SourceKeyEnvelopeV2 = Object.freeze({
  magic: 'skytwin-envelope',
  version: 2,
  algorithm: 'aes-256-gcm',
  ownerKind: 'user',
  purpose: 'credentials',
  keyVersion: 1,
  iv: Buffer.alloc(12, 1).toString('base64'),
  tag: Buffer.alloc(16, 2).toString('base64'),
  ciphertext: Buffer.from('ciphertext').toString('base64'),
});

class RecordingTransport implements SourceKeyBrokerClientTransport {
  readonly messages: SourceKeyBrokerClientWireMessage[] = [];
  delivery:
    | void
    | boolean
    | Promise<void | boolean>
    | (() => void | boolean | Promise<void | boolean>) = undefined;

  send(message: SourceKeyBrokerClientWireMessage) {
    this.messages.push(message);
    return typeof this.delivery === 'function'
      ? this.delivery()
      : this.delivery;
  }
}

function idFactory(): () => string {
  let value = 0;
  return () => (++value).toString(16).padStart(32, '0');
}

function createClient(transport = new RecordingTransport()) {
  const client = new SourceKeyBrokerClient({
    role: 'api',
    transport,
    requestTimeoutMs: 1_000,
    requestIdFactory: idFactory(),
  });
  return { client, transport };
}

function authorize(
  client: SourceKeyBrokerClient,
  ownerId = OWNER_A,
  generation = 1,
): void {
  client.handleMessage({
    type: 'skytwin:vault:capability',
    protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
    role: 'api',
    capability: CAPABILITY,
  });
  client.handleMessage({
    type: 'skytwin:vault:generation',
    protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
    ownerKind: 'user',
    ownerId,
    generation,
  });
}

function requests(transport: RecordingTransport): SourceKeyBrokerRequest[] {
  return transport.messages.filter(
    (message): message is SourceKeyBrokerRequest =>
      message.type === 'skytwin:vault:request',
  );
}

function respond(
  client: SourceKeyBrokerClient,
  request: SourceKeyBrokerRequest,
  result: SourceKeyBrokerResult,
): void {
  client.handleMessage({
    type: 'skytwin:vault:response',
    protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    generation: request.generation,
    context: request.context,
    result,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceKeyBrokerClient', () => {
  it('rejects unbounded timeout and pending-request options', () => {
    const transport = new RecordingTransport();
    expect(
      () =>
        new SourceKeyBrokerClient({
          role: 'api',
          transport,
          requestTimeoutMs: 60_001,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new SourceKeyBrokerClient({
          role: 'api',
          transport,
          maxPendingRequests: 1_025,
        }),
    ).toThrow(RangeError);
  });

  it('requires an exact capability and owner generation before sending', async () => {
    const { client, transport } = createClient();

    await expect(client.encrypt(contextA, 'secret')).resolves.toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_broker_unavailable',
    });
    authorize(client);
    const pending = client.encrypt(contextA, 'secret');
    const [request] = requests(transport);
    expect(request).toMatchObject({
      capability: CAPABILITY,
      role: 'api',
      generation: 1,
      operation: 'encrypt',
      context: contextA,
      plaintext: 'secret',
    });
    respond(client, request!, {
      success: true,
      operation: 'encrypt',
      envelope,
    });
    await expect(pending).resolves.toEqual({
      success: true,
      operation: 'encrypt',
      envelope,
    });
  });

  it('rejects stale and cross-context responses without exposing their payload', async () => {
    const { client, transport } = createClient();
    authorize(client);

    const stalePending = client.decrypt(contextA, envelope);
    const staleRequest = requests(transport)[0]!;
    client.handleMessage({
      type: 'skytwin:vault:response',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId: staleRequest.requestId,
      generation: staleRequest.generation - 1,
      context: staleRequest.context,
      result: {
        success: true,
        operation: 'decrypt',
        plaintext: 'must-not-escape',
      },
    });
    await expect(stalePending).resolves.toEqual({
      success: false,
      operation: 'decrypt',
      error: 'vault_broker_unavailable',
    });

    const swappedPending = client.decrypt(contextA, envelope);
    const swappedRequest = requests(transport)[1]!;
    client.handleMessage({
      type: 'skytwin:vault:response',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId: swappedRequest.requestId,
      generation: swappedRequest.generation,
      context: { ...swappedRequest.context, rowId: 'other-row' },
      result: {
        success: true,
        operation: 'decrypt',
        plaintext: 'also-must-not-escape',
      },
    });
    await expect(swappedPending).resolves.toEqual({
      success: false,
      operation: 'decrypt',
      error: 'vault_broker_unavailable',
    });
  });

  it('does not invoke hostile response accessors', async () => {
    const { client, transport } = createClient();
    authorize(client);
    const pending = client.decrypt(contextA, envelope);
    const request = requests(transport)[0]!;
    let accessed = false;
    const hostile: Record<string, unknown> = {
      type: 'skytwin:vault:response',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      generation: request.generation,
      context: request.context,
    };
    Object.defineProperty(hostile, 'result', {
      enumerable: true,
      get() {
        accessed = true;
        return {
          success: true,
          operation: 'decrypt',
          plaintext: 'hostile',
        };
      },
    });

    client.handleMessage(hostile);

    await expect(pending).resolves.toEqual({
      success: false,
      operation: 'decrypt',
      error: 'vault_broker_unavailable',
    });
    expect(accessed).toBe(false);
  });

  it('makes disconnect terminal and discards late responses and capabilities', async () => {
    const { client, transport } = createClient();
    authorize(client);
    const pending = client.decrypt(contextA, envelope);
    const request = requests(transport)[0]!;

    client.handleDisconnect();
    respond(client, request, {
      success: true,
      operation: 'decrypt',
      plaintext: 'late-plaintext',
    });
    authorize(client, OWNER_A, 2);

    await expect(pending).resolves.toEqual({
      success: false,
      operation: 'decrypt',
      error: 'vault_broker_unavailable',
    });
    await expect(client.encrypt(contextA, 'new-secret')).resolves.toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_broker_unavailable',
    });
    expect(requests(transport)).toHaveLength(1);
  });

  it('drains only the locked owner before acknowledging the lock barrier', async () => {
    const { client, transport } = createClient();
    authorize(client, OWNER_A, 1);
    authorize(client, OWNER_B, 3);
    const firstA = client.decrypt(contextA, envelope);
    const secondA = client.encrypt(contextA, 'secret-a');
    const pendingB = client.encrypt(contextB, 'secret-b');

    client.handleMessage({
      type: 'skytwin:vault:lock',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      lockId: 'a'.repeat(32),
      ownerKind: 'user',
      ownerId: OWNER_A,
      generation: 2,
    });

    await expect(firstA).resolves.toMatchObject({
      success: false,
      operation: 'decrypt',
      error: 'vault_locked',
    });
    await expect(secondA).resolves.toMatchObject({
      success: false,
      operation: 'encrypt',
      error: 'vault_locked',
    });
    expect(transport.messages.at(-1)).toEqual({
      type: 'skytwin:vault:lock-ack',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      lockId: 'a'.repeat(32),
      capability: CAPABILITY,
      role: 'api',
      ownerKind: 'user',
      ownerId: OWNER_A,
      generation: 2,
    });
    await expect(client.encrypt(contextA, 'while-locked')).resolves.toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_locked',
    });
    const lockedState = client.state(contextA);
    const stateRequest = requests(transport).find(
      (request) => request.operation === 'state',
    )!;
    respond(client, stateRequest, {
      success: true,
      operation: 'state',
      state: 'locked',
    });
    await expect(lockedState).resolves.toEqual({
      success: true,
      operation: 'state',
      state: 'locked',
    });

    const requestB = requests(transport).find(
      (request) => request.context.ownerId === OWNER_B,
    )!;
    respond(client, requestB, {
      success: true,
      operation: 'encrypt',
      envelope,
    });
    await expect(pendingB).resolves.toMatchObject({
      success: true,
      operation: 'encrypt',
    });

    client.handleMessage({
      type: 'skytwin:vault:generation',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      ownerKind: 'user',
      ownerId: OWNER_A,
      generation: 2,
    });
    const resumed = client.encrypt(contextA, 'resumed');
    expect(requests(transport).at(-1)).toMatchObject({
      operation: 'encrypt',
      generation: 2,
    });
    client.handleDisconnect();
    await expect(resumed).resolves.toMatchObject({
      success: false,
      error: 'vault_broker_unavailable',
    });
  });

  it('withholds lock acknowledgement until an owner callback releases plaintext', async () => {
    const { client, transport } = createClient();
    authorize(client, OWNER_A, 1);
    authorize(client, OWNER_B, 1);
    let releaseCallback = (): void => {};
    let callbackIsHolding = false;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const leased = client.runWithOwnerLease(contextA, async () => {
      const decrypted = await client.decrypt(contextA, envelope);
      callbackIsHolding = true;
      await callbackGate;
      return decrypted;
    });
    const decryptRequest = requests(transport).find(
      (request) => request.operation === 'decrypt',
    )!;
    respond(client, decryptRequest, {
      success: true,
      operation: 'decrypt',
      plaintext: 'leased-plaintext',
    });
    await vi.waitFor(() => expect(callbackIsHolding).toBe(true));

    client.handleMessage({
      type: 'skytwin:vault:lock',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      lockId: 'b'.repeat(32),
      ownerKind: 'user',
      ownerId: OWNER_A,
      generation: 2,
    });
    expect(
      transport.messages.filter(
        (message) => message.type === 'skytwin:vault:lock-ack',
      ),
    ).toHaveLength(0);

    const ownerBPending = client.encrypt(contextB, 'owner-b-continues');
    const ownerBRequest = requests(transport).find(
      (request) =>
        request.operation === 'encrypt' && request.context.ownerId === OWNER_B,
    )!;
    respond(client, ownerBRequest, {
      success: true,
      operation: 'encrypt',
      envelope,
    });
    await expect(ownerBPending).resolves.toMatchObject({ success: true });
    expect(
      transport.messages.filter(
        (message) => message.type === 'skytwin:vault:lock-ack',
      ),
    ).toHaveLength(0);

    releaseCallback();
    await expect(leased).resolves.toEqual({
      success: true,
      value: {
        success: true,
        operation: 'decrypt',
        plaintext: 'leased-plaintext',
      },
    });
    expect(transport.messages.at(-1)).toMatchObject({
      type: 'skytwin:vault:lock-ack',
      lockId: 'b'.repeat(32),
      ownerId: OWNER_A,
      generation: 2,
    });
  });

  it('accepts exactly 16 MiB of UTF-8 plaintext and refuses one byte more', async () => {
    const { client, transport } = createClient();
    authorize(client);
    const exact = 'x'.repeat(16 * 1024 * 1024);
    const accepted = client.encrypt(contextA, exact);
    expect(requests(transport)).toHaveLength(1);

    await expect(client.encrypt(contextA, `${exact}x`)).resolves.toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_broker_unavailable',
    });
    expect(requests(transport)).toHaveLength(1);

    const request = requests(transport)[0]!;
    respond(client, request, {
      success: false,
      operation: 'encrypt',
      error: 'vault_locked',
    });
    await expect(accepted).resolves.toMatchObject({
      success: false,
      error: 'vault_locked',
    });
  });

  it('fails timed-out and rejected deliveries closed', async () => {
    vi.useFakeTimers();
    const timeoutFixture = createClient();
    authorize(timeoutFixture.client);
    const timedOut = timeoutFixture.client.encrypt(contextA, 'secret');
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(timedOut).resolves.toMatchObject({
      success: false,
      error: 'vault_broker_unavailable',
    });

    const rejectedTransport = new RecordingTransport();
    rejectedTransport.delivery = Promise.reject(new Error('private IPC lost'));
    const rejectedFixture = createClient(rejectedTransport);
    authorize(rejectedFixture.client);
    await expect(
      rejectedFixture.client.encrypt(contextA, 'secret'),
    ).resolves.toMatchObject({
      success: false,
      error: 'vault_broker_unavailable',
    });
  });

  it('bounds pending requests and preserves the admitted request', async () => {
    const transport = new RecordingTransport();
    const client = new SourceKeyBrokerClient({
      role: 'api',
      transport,
      requestTimeoutMs: 1_000,
      maxPendingRequests: 1,
      requestIdFactory: idFactory(),
    });
    authorize(client);

    const admitted = client.encrypt(contextA, 'first-secret');
    await expect(client.encrypt(contextA, 'second-secret')).resolves.toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_broker_unavailable',
    });
    expect(requests(transport)).toHaveLength(1);

    respond(client, requests(transport)[0]!, {
      success: false,
      operation: 'encrypt',
      error: 'vault_locked',
    });
    await expect(admitted).resolves.toMatchObject({
      success: false,
      error: 'vault_locked',
    });
  });

  it('disconnects instead of acknowledging a lock for an unknown owner', async () => {
    const { client, transport } = createClient();
    authorize(client);

    client.handleMessage({
      type: 'skytwin:vault:lock',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      lockId: 'c'.repeat(32),
      ownerKind: 'user',
      ownerId: OWNER_B,
      generation: 1,
    });

    expect(
      transport.messages.some(
        (message) => message.type === 'skytwin:vault:lock-ack',
      ),
    ).toBe(false);
    await expect(client.state(contextA)).resolves.toEqual({
      success: false,
      operation: 'state',
      error: 'vault_broker_unavailable',
    });
  });

  it('rejects a generation change that did not pass through a lock barrier', async () => {
    const { client, transport } = createClient();
    authorize(client);

    client.handleMessage({
      type: 'skytwin:vault:generation',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      ownerKind: 'user',
      ownerId: OWNER_A,
      generation: 2,
    });

    await expect(client.encrypt(contextA, 'must-not-send')).resolves.toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_broker_unavailable',
    });
    expect(requests(transport)).toHaveLength(0);
  });
});
