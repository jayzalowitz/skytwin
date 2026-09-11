import { describe, expect, it } from 'vitest';
import type { SignalConnector } from '@skytwin/connectors';
import {
  connectorHealthName,
  connectorRuntimeKey,
  sameConnectorTopology,
} from '../connector-runtime-key.js';

function connector(name: string, connectorAccountId?: string): SignalConnector {
  return {
    name,
    connectorAccountId,
    connect: async () => {},
    disconnect: async () => {},
    poll: async () => [],
    onSignal: () => {},
  };
}

describe('connector runtime identity', () => {
  it('isolates breakers and health rows by stable account', () => {
    const gmail = connector('gmail', 'account-a');
    expect(connectorRuntimeKey('user-1', gmail)).toBe('user-1:gmail:account-a');
    expect(connectorHealthName(gmail)).toBe('gmail:account-a');
  });

  it('detects same-user account add, remove, and switch', () => {
    const group = (ids: string[]) => [{
      userId: 'user-1',
      connectors: ids.map((id) => connector('gmail', id)),
    }];
    expect(sameConnectorTopology(group(['a']), group(['a']))).toBe(true);
    expect(sameConnectorTopology(group(['a']), group(['a', 'b']))).toBe(false);
    expect(sameConnectorTopology(group(['a', 'b']), group(['a']))).toBe(false);
    expect(sameConnectorTopology(group(['a']), group(['b']))).toBe(false);
  });
});
