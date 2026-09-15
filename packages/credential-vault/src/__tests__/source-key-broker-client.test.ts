import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOURCE_KEY_BROKER_PROTOCOL_VERSION,
  type SourceKeyBrokerContext,
  type SourceKeyBrokerOwnerGrantRequest,
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
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_HASH = 'a'.repeat(64);

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

function grantRequests(
  transport: RecordingTransport,
): SourceKeyBrokerOwnerGrantRequest[] {
  return transport.messages.filter(
    (message): message is SourceKeyBrokerOwnerGrantRequest =>
      message.type === 'skytwin:vault:owner-grant-request',
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

async function grantApiSession(
  client: SourceKeyBrokerClient,
  transport: RecordingTransport,
  input: { ownerId: string; sessionId: string; expiresAtMs: number },
  grantId: string,
  generation = 1,
) {
  const pending = client.grantSession({ ...input, tokenHash: TOKEN_HASH });
  const request = grantRequests(transport).at(-1)!;
  client.handleMessage({
    type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
    requestId: request.requestId, role: 'api', ownerKind: 'user',
    ...input, success: true, grantId, generation,
  });
  const result = await pending;
  if (!result.success) throw new Error('fixture grant failed');
  return result.authority;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceKeyBrokerClient', () => {
  it('coalesces simultaneous exact grants and rejects a conflicting tuple', async () => {
    const { client, transport } = createClient();
    authorize(client);
    const input = {
      ownerId: OWNER_A, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000,
    };
    const first = client.grantSession(input);
    const identical = client.grantSession({ ...input });
    const conflicting = client.grantSession({ ...input, ownerId: OWNER_B });
    expect(grantRequests(transport)).toHaveLength(1);
    await expect(conflicting).resolves.toEqual({
      success: false, error: 'vault_broker_unavailable',
    });
    const request = grantRequests(transport)[0]!;
    client.handleMessage({
      type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
      requestId: request.requestId, role: 'api', ownerKind: 'user',
      ownerId: input.ownerId, sessionId: input.sessionId,
      expiresAtMs: input.expiresAtMs, success: true,
      grantId: 'c'.repeat(32), generation: 1,
    });
    await expect(Promise.all([first, identical])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    await expect(client.grantSession({ ...input, tokenHash: 'b'.repeat(64) }))
      .resolves.toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(grantRequests(transport)).toHaveLength(1);
  });

  it('uses only an exact granted API session on every crypto request', async () => {
    const transport = new RecordingTransport();
    let authority: { kind: 'api_session'; sessionId: string; grantId: string } | undefined;
    const client = new SourceKeyBrokerClient({
      role: 'api',
      transport,
      requestIdFactory: idFactory(),
      sessionAuthorityProvider: () => authority,
    });
    client.handleMessage({
      type: 'skytwin:vault:capability', protocolVersion: 1,
      role: 'api', capability: CAPABILITY,
    });
    const expiresAtMs = Date.now() + 60_000;
    const pendingGrant = client.grantSession({
      ownerId: OWNER_A, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    const grantRequest = grantRequests(transport)[0]!;
    expect(grantRequest).toMatchObject({
      ownerId: OWNER_A, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    client.handleMessage({
      type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
      requestId: grantRequest.requestId, role: 'api', ownerKind: 'user',
      ownerId: OWNER_A, sessionId: SESSION_A, expiresAtMs,
      success: true, grantId: 'c'.repeat(32), generation: 7,
    });
    const granted = await pendingGrant;
    expect(granted.success).toBe(true);
    if (!granted.success) throw new Error('fixture grant failed');
    authority = granted.authority;

    const pending = client.encrypt(contextA, 'session-secret');
    const cryptoRequest = requests(transport)[0]!;
    expect(cryptoRequest).toMatchObject({
      generation: 7,
      authority: granted.authority,
      context: contextA,
    });
    respond(client, cryptoRequest, {
      success: false, operation: 'encrypt', error: 'vault_locked',
    });
    await expect(pending).resolves.toMatchObject({ error: 'vault_locked' });

    authority = { ...granted.authority, grantId: 'd'.repeat(32) };
    await expect(client.state(contextA)).resolves.toMatchObject({
      success: false, error: 'vault_broker_unavailable',
    });
    authority = { ...granted.authority, sessionId: SESSION_B };
    await expect(client.state(contextA)).resolves.toMatchObject({
      success: false, error: 'vault_broker_unavailable',
    });
    authority = granted.authority;
    await expect(client.state(contextB)).resolves.toMatchObject({
      success: false, error: 'vault_broker_unavailable',
    });
    expect(requests(transport)).toHaveLength(1);
  });

  it('rejects substituted and replayed grant results', async () => {
    const transport = new RecordingTransport();
    const client = new SourceKeyBrokerClient({
      role: 'api', transport, requestIdFactory: idFactory(),
    });
    authorize(client);
    const expiresAtMs = Date.now() + 60_000;
    const pending = client.grantSession({
      ownerId: OWNER_A, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    const grant = grantRequests(transport)[0]!;
    client.handleMessage({
      type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
      requestId: grant.requestId, role: 'api', ownerKind: 'user',
      ownerId: OWNER_B, sessionId: SESSION_A, expiresAtMs,
      success: true, grantId: 'c'.repeat(32), generation: 1,
    });
    await expect(pending).resolves.toEqual({
      success: false, error: 'vault_broker_unavailable',
    });
    client.handleMessage({
      type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
      requestId: grant.requestId, role: 'api', ownerKind: 'user',
      ownerId: OWNER_A, sessionId: SESSION_A, expiresAtMs,
      success: true, grantId: 'd'.repeat(32), generation: 1,
    });
    expect(grantRequests(transport)).toHaveLength(1);
  });

  it('makes revoke beat a delayed grant and expiry remove request authority', async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);
    const transport = new RecordingTransport();
    let authority: { kind: 'api_session'; sessionId: string; grantId: string } | undefined;
    const client = new SourceKeyBrokerClient({
      role: 'api', transport, requestTimeoutMs: 1_000,
      requestIdFactory: idFactory(), sessionAuthorityProvider: () => authority,
    });
    authorize(client);
    const expiresAtMs = base + 500;
    const pending = client.grantSession({
      ownerId: OWNER_A, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    const grant = grantRequests(transport)[0]!;
    client.revokeSession(OWNER_A, SESSION_A);
    await expect(pending).resolves.toEqual({
      success: false, error: 'vault_broker_unavailable',
    });
    client.handleMessage({
      type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
      requestId: grant.requestId, role: 'api', ownerKind: 'user',
      ownerId: OWNER_A, sessionId: SESSION_A, expiresAtMs,
      success: true, grantId: 'c'.repeat(32), generation: 1,
    });
    authority = { kind: 'api_session', sessionId: SESSION_A, grantId: 'c'.repeat(32) };
    await expect(client.state(contextA)).resolves.toMatchObject({
      success: false, error: 'vault_broker_unavailable',
    });

    const second = client.grantSession({
      ownerId: OWNER_A, sessionId: SESSION_B,
      tokenHash: TOKEN_HASH, expiresAtMs,
    });
    const secondGrant = grantRequests(transport)[1]!;
    client.handleMessage({
      type: 'skytwin:vault:owner-grant-result', protocolVersion: 1,
      requestId: secondGrant.requestId, role: 'api', ownerKind: 'user',
      ownerId: OWNER_A, sessionId: SESSION_B, expiresAtMs,
      success: true, grantId: 'e'.repeat(32), generation: 1,
    });
    const accepted = await second;
    if (!accepted.success) throw new Error('fixture grant failed');
    authority = accepted.authority;
    vi.setSystemTime(base + 501);
    await expect(client.state(contextA)).resolves.toMatchObject({
      success: false, error: 'vault_broker_unavailable',
    });
  });

  it('keeps worker authority empty and closes instead of evicting live tombstones', async () => {
    const workerTransport = new RecordingTransport();
    const worker = new SourceKeyBrokerClient({ role: 'worker', transport: workerTransport });
    worker.handleMessage({
      type: 'skytwin:vault:capability', protocolVersion: 1,
      role: 'worker', capability: CAPABILITY,
    });
    await expect(worker.grantSession({
      ownerId: OWNER_A, sessionId: SESSION_A,
      tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000,
    })).resolves.toEqual({ success: false, error: 'vault_broker_unavailable' });
    expect(workerTransport.messages).toHaveLength(0);

    const transport = new RecordingTransport();
    const api = new SourceKeyBrokerClient({
      role: 'api', transport, maxPendingRequests: 1,
      requestIdFactory: idFactory(),
    });
    authorize(api);
    api.revokeSession(OWNER_A, SESSION_A);
    api.revokeSession(OWNER_A, SESSION_B);
    await expect(api.state(contextA)).resolves.toMatchObject({
      success: false, error: 'vault_broker_unavailable',
    });
    expect(transport.messages.filter((message) =>
      message.type === 'skytwin:vault:owner-revoke')).toHaveLength(1);
  });

  it('rejects a delayed S1 response after revoke while same-owner S2 remains live', async () => {
    const transport = new RecordingTransport();
    let authority: { kind: 'api_session'; sessionId: string; grantId: string } | undefined;
    const client = new SourceKeyBrokerClient({
      role: 'api', transport, requestIdFactory: idFactory(),
      sessionAuthorityProvider: () => authority,
    });
    authorize(client);
    const expiresAtMs = Date.now() + 60_000;
    const first = await grantApiSession(
      client, transport,
      { ownerId: OWNER_A, sessionId: SESSION_A, expiresAtMs },
      'a'.repeat(32),
    );
    const second = await grantApiSession(
      client, transport,
      { ownerId: OWNER_A, sessionId: SESSION_B, expiresAtMs },
      'b'.repeat(32),
    );

    authority = first;
    const pending = client.decrypt(contextA, envelope);
    const delayedRequest = requests(transport).at(-1)!;
    client.revokeSession(OWNER_A, SESSION_A);
    await expect(pending).resolves.toEqual({
      success: false, operation: 'decrypt', error: 'vault_broker_unavailable',
    });
    respond(client, delayedRequest, {
      success: true, operation: 'decrypt', plaintext: 'must-not-escape',
    });

    authority = second;
    const stillLive = client.state(contextA);
    const secondRequest = requests(transport).at(-1)!;
    respond(client, secondRequest, {
      success: true, operation: 'state', state: 'unlocked',
    });
    await expect(stillLive).resolves.toEqual({
      success: true, operation: 'state', state: 'unlocked',
    });
  });

  it('rejects plaintext arriving after the exact session grant expires', async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);
    const transport = new RecordingTransport();
    let authority: { kind: 'api_session'; sessionId: string; grantId: string } | undefined;
    const client = new SourceKeyBrokerClient({
      role: 'api', transport, requestIdFactory: idFactory(),
      sessionAuthorityProvider: () => authority,
    });
    authorize(client);
    authority = await grantApiSession(
      client, transport,
      { ownerId: OWNER_A, sessionId: SESSION_A, expiresAtMs: base + 500 },
      'a'.repeat(32),
    );
    const pending = client.decrypt(contextA, envelope);
    const delayedRequest = requests(transport).at(-1)!;
    vi.setSystemTime(base + 501);
    respond(client, delayedRequest, {
      success: true, operation: 'decrypt', plaintext: 'must-not-escape',
    });
    await expect(pending).resolves.toEqual({
      success: false, operation: 'decrypt', error: 'vault_broker_unavailable',
    });
  });

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
