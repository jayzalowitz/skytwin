import { describe, expect, it } from 'vitest';
import {
  SOURCE_KEY_BROKER_PROTOCOL_VERSION,
  type SourceKeyBrokerContext,
  type SourceKeyBrokerRequest,
} from '@skytwin/shared-types';
import {
  createProcessSourceKeyBrokerClient,
  type SourceKeyBrokerProcessPort,
} from '../process-source-key-broker-client.js';
import type { SourceKeyBrokerClientWireMessage } from '../source-key-broker-client.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CAPABILITY = Buffer.alloc(32, 9).toString('base64');
const context: SourceKeyBrokerContext = Object.freeze({
  ownerKind: 'user',
  ownerId: OWNER_ID,
  purpose: 'twin',
  table: 'twin_profiles',
  column: 'profile_data',
  rowId: 'row-1',
});

type PortEvent = 'message' | 'disconnect' | 'exit';
type PortListener = (...args: unknown[]) => void;

class FakeProcessPort implements SourceKeyBrokerProcessPort {
  connected = true;
  readonly sent: SourceKeyBrokerClientWireMessage[] = [];
  readonly deliveryCallbacks: Array<(error: Error | null) => void> = [];
  private readonly listeners = new Map<PortEvent, Set<PortListener>>();

  send(
    message: unknown,
    callback: (error: Error | null) => void,
  ): boolean {
    this.sent.push(message as SourceKeyBrokerClientWireMessage);
    this.deliveryCallbacks.push(callback);
    return false; // Node uses false for backpressure, not delivery failure.
  }

  on(event: PortEvent, listener: PortListener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: PortEvent, listener: PortListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: PortEvent, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  listenerCount(event: PortEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function authorize(port: FakeProcessPort): void {
  port.emit('message', {
    type: 'skytwin:vault:capability',
    protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
    role: 'worker',
    capability: CAPABILITY,
  });
  port.emit('message', {
    type: 'skytwin:vault:generation',
    protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
    ownerKind: 'user',
    ownerId: OWNER_ID,
    generation: 4,
  });
}

describe('createProcessSourceKeyBrokerClient', () => {
  it('uses the send callback as delivery authority and detaches on disconnect', async () => {
    const port = new FakeProcessPort();
    const client = createProcessSourceKeyBrokerClient('worker', port, {
      requestTimeoutMs: 1_000,
      requestIdFactory: () => '1'.repeat(32),
    });
    authorize(port);

    const pending = client.encrypt(context, 'secret');
    expect(port.sent).toHaveLength(1);
    expect(port.listenerCount('message')).toBe(1);
    port.deliveryCallbacks[0]!(null);
    const request = port.sent[0] as SourceKeyBrokerRequest;
    port.emit('message', {
      type: 'skytwin:vault:response',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      generation: request.generation,
      context: request.context,
      result: {
        success: false,
        operation: 'encrypt',
        error: 'vault_locked',
      },
    });
    await expect(pending).resolves.toMatchObject({
      success: false,
      error: 'vault_locked',
    });

    port.emit('disconnect');
    expect(port.listenerCount('message')).toBe(0);
    expect(port.listenerCount('disconnect')).toBe(0);
    expect(port.listenerCount('exit')).toBe(0);
  });

  it('attaches no listeners and fails immediately when IPC is unavailable', async () => {
    const port = new FakeProcessPort();
    port.connected = false;
    const client = createProcessSourceKeyBrokerClient('api', port);

    expect(port.listenerCount('message')).toBe(0);
    await expect(client.state(context)).resolves.toEqual({
      success: false,
      operation: 'state',
      error: 'vault_broker_unavailable',
    });
    expect(port.sent).toHaveLength(0);
  });

  it('fails pending work and detaches when the send callback reports an error', async () => {
    const port = new FakeProcessPort();
    const client = createProcessSourceKeyBrokerClient('worker', port, {
      requestIdFactory: () => '2'.repeat(32),
    });
    authorize(port);
    const pending = client.encrypt(context, 'secret');

    port.deliveryCallbacks[0]!(new Error('delivery failed'));

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: 'vault_broker_unavailable',
    });
    expect(port.listenerCount('message')).toBe(0);
  });
});
