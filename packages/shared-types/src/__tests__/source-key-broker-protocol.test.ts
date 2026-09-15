import { describe, expect, it } from 'vitest';
import {
  SOURCE_KEY_BROKER_FAILURE_CODES,
  SOURCE_KEY_BROKER_OPERATIONS,
  SOURCE_KEY_PURPOSES,
  snapshotSourceKeyBrokerContext,
  snapshotSourceKeyBrokerControlMessage,
  snapshotSourceKeyBrokerRequest,
  snapshotSourceKeyBrokerResponse,
  snapshotSourceKeyBrokerResult,
  snapshotSourceKeyEnvelope,
  sourceKeyBrokerFailure,
  type SourceKeyBrokerContext,
  type SourceKeyBrokerOperation,
} from '../source-key-broker-protocol.js';

const ownerId = '01993f36-7c79-4f17-8e7f-5611f00dba21';
const requestId = '0123456789abcdef0123456789abcdef';
const capability = Buffer.alloc(32, 7).toString('base64');
const context: SourceKeyBrokerContext = Object.freeze({
  ownerKind: 'user',
  ownerId,
  purpose: 'credentials',
  table: 'oauth_tokens',
  column: 'access_token',
  rowId: 'row-1',
});
const envelope = Object.freeze({
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

function request(operation: SourceKeyBrokerOperation): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: 'skytwin:vault:request',
    protocolVersion: 1,
    requestId,
    capability,
    role: 'api',
    generation: 4,
    operation,
    context,
  };
  if (operation === 'encrypt') base['plaintext'] = 'private fixture';
  if (operation === 'decrypt' || operation === 'rewrap')
    base['envelope'] = envelope;
  return base;
}

function success(operation: SourceKeyBrokerOperation): Record<string, unknown> {
  if (operation === 'state')
    return { success: true, operation, state: 'unlocked' };
  if (operation === 'decrypt')
    return { success: true, operation, plaintext: 'private fixture' };
  return { success: true, operation, envelope };
}

describe('source-key broker context and envelope snapshots', () => {
  it('accepts only the ADR user-purpose and exact field context', () => {
    for (const purpose of SOURCE_KEY_PURPOSES) {
      expect(snapshotSourceKeyBrokerContext({ ...context, purpose })).toEqual({
        ...context,
        purpose,
      });
    }
    for (const mutation of [
      { ...context, ownerKind: 'installation' },
      { ...context, ownerKind: 'user_child' },
      { ...context, purpose: 'oauth' },
      { ...context, ownerId: 'not-a-uuid' },
      { ...context, table: 'oauth-tokens' },
      { ...context, column: 'AccessToken' },
      { ...context, rowId: '' },
      { ...context, rowId: 'row with spaces' },
      { ...context, passphrase: 'must-not-be-accepted' },
    ]) {
      expect(snapshotSourceKeyBrokerContext(mutation)).toBeNull();
    }
  });

  it('returns detached, immutable snapshots and never invokes accessors or proxies', () => {
    const mutable = { ...context };
    const snapshot = snapshotSourceKeyBrokerContext(mutable);
    expect(snapshot).not.toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    mutable.rowId = 'row-2';
    expect(snapshot?.rowId).toBe('row-1');

    let accessorRead = false;
    const accessor = { ...context } as Record<string, unknown>;
    Object.defineProperty(accessor, 'rowId', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return 'row-1';
      },
    });
    expect(snapshotSourceKeyBrokerContext(accessor)).toBeNull();
    expect(accessorRead).toBe(false);
    expect(
      snapshotSourceKeyBrokerContext(new Proxy({ ...context }, {})),
    ).toBeNull();
  });

  it('requires canonical bounded envelope fields and matching purpose', () => {
    expect(snapshotSourceKeyEnvelope(envelope, context)).toEqual(envelope);
    expect(
      snapshotSourceKeyEnvelope({ ...envelope, ciphertext: '' }, context),
    ).toMatchObject({
      ciphertext: '',
    });
    for (const mutation of [
      { ...envelope, version: 1 },
      { ...envelope, algorithm: 'aes-128-gcm' },
      { ...envelope, ownerKind: 'installation' },
      { ...envelope, purpose: 'memory' },
      { ...envelope, keyVersion: 0 },
      { ...envelope, iv: 'not-base64' },
      { ...envelope, tag: Buffer.alloc(15).toString('base64') },
      { ...envelope, ciphertext: 'YQ' },
      { ...envelope, dek: 'must-not-be-accepted' },
    ]) {
      expect(snapshotSourceKeyEnvelope(mutation, context)).toBeNull();
    }
  });

  it('validates the full ciphertext boundary without regex stack growth', () => {
    const maximumCiphertext = Buffer.alloc(16 * 1024 * 1024, 3).toString(
      'base64',
    );
    const oversizedCiphertext = Buffer.alloc(16 * 1024 * 1024 + 1, 3).toString(
      'base64',
    );
    const maximumEnvelope = { ...envelope, ciphertext: maximumCiphertext };
    const oversizedEnvelope = { ...envelope, ciphertext: oversizedCiphertext };

    expect(
      snapshotSourceKeyEnvelope(maximumEnvelope, context)?.ciphertext.length,
    ).toBe(maximumCiphertext.length);
    expect(snapshotSourceKeyEnvelope(oversizedEnvelope, context)).toBeNull();

    expect(
      snapshotSourceKeyBrokerRequest({
        ...request('decrypt'),
        envelope: maximumEnvelope,
      }),
    ).not.toBeNull();
    expect(
      snapshotSourceKeyBrokerRequest({
        ...request('decrypt'),
        envelope: oversizedEnvelope,
      }),
    ).toBeNull();

    const response = {
      type: 'skytwin:vault:response',
      protocolVersion: 1,
      requestId,
      generation: 4,
      context,
      result: success('encrypt'),
    };
    const expected = {
      requestId,
      generation: 4,
      operation: 'encrypt' as const,
      context,
    };
    expect(
      snapshotSourceKeyBrokerResponse(
        {
          ...response,
          result: {
            success: true,
            operation: 'encrypt',
            envelope: maximumEnvelope,
          },
        },
        expected,
      ),
    ).not.toBeNull();
    expect(
      snapshotSourceKeyBrokerResponse(
        {
          ...response,
          result: {
            success: true,
            operation: 'encrypt',
            envelope: oversizedEnvelope,
          },
        },
        expected,
      ),
    ).toBeNull();
  });

  it('rejects malformed base64 alphabet, padding, and non-canonical pad bits', () => {
    for (const ciphertext of [
      'Zm9v\n',
      'Zm9v_',
      '=m9v',
      'Zm=v',
      'Zg===',
      'Zh==',
    ]) {
      expect(
        snapshotSourceKeyEnvelope({ ...envelope, ciphertext }, context),
      ).toBeNull();
    }
  });

  it('rejects envelope accessors and proxies without reading ciphertext', () => {
    let ciphertextRead = false;
    const accessor = { ...envelope } as Record<string, unknown>;
    Object.defineProperty(accessor, 'ciphertext', {
      enumerable: true,
      get: () => {
        ciphertextRead = true;
        return envelope.ciphertext;
      },
    });

    expect(snapshotSourceKeyEnvelope(accessor, context)).toBeNull();
    expect(ciphertextRead).toBe(false);
    expect(
      snapshotSourceKeyEnvelope(new Proxy({ ...envelope }, {}), context),
    ).toBeNull();
  });
});

describe('source-key broker requests', () => {
  it('strictly snapshots capability, generation, lock, and lock acknowledgement control messages', () => {
    const messages = [
      {
        type: 'skytwin:vault:capability',
        protocolVersion: 1,
        role: 'api',
        capability,
      },
      {
        type: 'skytwin:vault:generation',
        protocolVersion: 1,
        ownerKind: 'user',
        ownerId,
        generation: 4,
      },
      {
        type: 'skytwin:vault:lock',
        protocolVersion: 1,
        lockId: requestId,
        ownerKind: 'user',
        ownerId,
        generation: 5,
      },
      {
        type: 'skytwin:vault:lock-ack',
        protocolVersion: 1,
        lockId: requestId,
        capability,
        role: 'worker',
        ownerKind: 'user',
        ownerId,
        generation: 5,
      },
    ];
    for (const message of messages) {
      const snapshot = snapshotSourceKeyBrokerControlMessage(message);
      expect(snapshot).toEqual(message);
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
    expect(
      snapshotSourceKeyBrokerControlMessage({
        ...messages[0],
        passphrase: 'no',
      }),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerControlMessage({ ...messages[2], generation: -1 }),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerControlMessage({
        ...messages[3],
        capability: Buffer.alloc(31).toString('base64'),
      }),
    ).toBeNull();
  });

  it('accepts each operation only with its exact payload shape', () => {
    for (const operation of SOURCE_KEY_BROKER_OPERATIONS) {
      const snapshot = snapshotSourceKeyBrokerRequest(request(operation));
      expect(snapshot).toMatchObject({ operation, context });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot?.context)).toBe(true);
      if (operation === 'decrypt' || operation === 'rewrap') {
        expect(
          Object.isFrozen(
            snapshot && 'envelope' in snapshot ? snapshot.envelope : null,
          ),
        ).toBe(true);
      }
    }
  });

  it('supports empty-but-valid plaintext without permitting ambiguous payload combinations', () => {
    expect(
      snapshotSourceKeyBrokerRequest({ ...request('encrypt'), plaintext: '' }),
    ).toMatchObject({ operation: 'encrypt', plaintext: '' });
    expect(
      snapshotSourceKeyBrokerRequest({ ...request('state'), plaintext: '' }),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerRequest({ ...request('encrypt'), envelope }),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerRequest({
        ...request('decrypt'),
        plaintext: 'extra',
      }),
    ).toBeNull();
  });

  it('rejects stale-looking, malformed, oversized, and secret-bearing request metadata', () => {
    const oversized = 'x'.repeat(16 * 1024 * 1024 + 1);
    for (const mutation of [
      { ...request('state'), protocolVersion: 2 },
      { ...request('state'), requestId: requestId.toUpperCase() },
      { ...request('state'), capability: Buffer.alloc(31).toString('base64') },
      { ...request('state'), role: 'renderer' },
      { ...request('state'), generation: -1 },
      { ...request('state'), generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...request('state'), operation: 'grant' },
      { ...request('state'), passphrase: 'must-not-be-accepted' },
      { ...request('state'), key: 'must-not-be-accepted' },
      { ...request('encrypt'), plaintext: oversized },
    ]) {
      expect(snapshotSourceKeyBrokerRequest(mutation)).toBeNull();
    }
  });

  it('rejects request accessors and proxies without evaluating their payload', () => {
    let operationRead = false;
    const accessor = request('state');
    Object.defineProperty(accessor, 'operation', {
      enumerable: true,
      get: () => {
        operationRead = true;
        return 'state';
      },
    });
    expect(snapshotSourceKeyBrokerRequest(accessor)).toBeNull();
    expect(operationRead).toBe(false);
    expect(
      snapshotSourceKeyBrokerRequest(new Proxy(request('state'), {})),
    ).toBeNull();
  });
});

describe('source-key broker results and responses', () => {
  it('freezes the canonical fail-closed error family for every operation', () => {
    for (const operation of SOURCE_KEY_BROKER_OPERATIONS) {
      for (const error of SOURCE_KEY_BROKER_FAILURE_CODES) {
        const result = snapshotSourceKeyBrokerResult(
          { success: false, operation, error },
          operation,
          context,
        );
        expect(result).toEqual({ success: false, operation, error });
        expect(Object.isFrozen(result)).toBe(true);
      }
    }
    expect(sourceKeyBrokerFailure('encrypt', 'vault_locked')).toEqual({
      success: false,
      operation: 'encrypt',
      error: 'vault_locked',
    });
  });

  it('rejects unknown errors, cross-operation successes, and extra result fields', () => {
    expect(
      snapshotSourceKeyBrokerResult(
        { success: false, operation: 'encrypt', error: 'grant_missing' },
        'encrypt',
        context,
      ),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerResult(success('decrypt'), 'encrypt', context),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerResult(
        { ...success('decrypt'), ciphertext: 'extra' },
        'decrypt',
        context,
      ),
    ).toBeNull();
    expect(
      snapshotSourceKeyBrokerResult(
        { success: true, operation: 'state', state: 'locking' },
        'state',
        context,
      ),
    ).toBeNull();

    let stateCoercionAttempted = false;
    expect(
      snapshotSourceKeyBrokerResult(
        {
          success: true,
          operation: 'state',
          state: {
            toString: () => {
              stateCoercionAttempted = true;
              return 'unlocked';
            },
          },
        },
        'state',
        context,
      ),
    ).toBeNull();
    expect(stateCoercionAttempted).toBe(false);

    let successRead = false;
    const accessor = success('decrypt');
    Object.defineProperty(accessor, 'success', {
      enumerable: true,
      get: () => {
        successRead = true;
        return true;
      },
    });
    expect(
      snapshotSourceKeyBrokerResult(accessor, 'decrypt', context),
    ).toBeNull();
    expect(successRead).toBe(false);
    expect(
      snapshotSourceKeyBrokerResult(
        new Proxy(success('decrypt'), {}),
        'decrypt',
        context,
      ),
    ).toBeNull();
  });

  it('binds a response to the exact pending request generation, operation, and context', () => {
    const response = {
      type: 'skytwin:vault:response',
      protocolVersion: 1,
      requestId,
      generation: 4,
      context,
      result: success('encrypt'),
    };
    const expected = {
      requestId,
      generation: 4,
      operation: 'encrypt' as const,
      context,
    };
    const snapshot = snapshotSourceKeyBrokerResponse(response, expected);
    expect(snapshot).toEqual(response);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.context)).toBe(true);
    expect(Object.isFrozen(snapshot?.result)).toBe(true);

    for (const mutation of [
      { ...response, requestId: 'ffffffffffffffffffffffffffffffff' },
      { ...response, generation: 3 },
      {
        ...response,
        context: {
          ...context,
          ownerId: '01993f36-7c79-4f17-8e7f-5611f00dba22',
        },
      },
      { ...response, context: { ...context, rowId: 'row-2' } },
      { ...response, result: success('decrypt') },
      { ...response, plaintext: 'must-not-be-accepted' },
    ]) {
      expect(snapshotSourceKeyBrokerResponse(mutation, expected)).toBeNull();
    }
  });

  it('does not expose a success-shaped fallback for malformed responses', () => {
    const expected = {
      requestId,
      generation: 4,
      operation: 'state' as const,
      context,
    };
    expect(snapshotSourceKeyBrokerResponse(null, expected)).toBeNull();
    expect(
      snapshotSourceKeyBrokerResponse(
        { success: true, state: 'unlocked' },
        expected,
      ),
    ).toBeNull();
  });
});
