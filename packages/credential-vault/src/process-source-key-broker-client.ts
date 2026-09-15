import {
  SourceKeyBrokerClient,
  type SourceKeyBrokerClientOptions,
  type SourceKeyBrokerClientWireMessage,
} from './source-key-broker-client.js';
import type { SourceKeyBrokerRole } from '@skytwin/shared-types';

type ProcessMessageListener = (message: unknown) => void;
type ProcessTerminalListener = (...args: unknown[]) => void;

/** Minimum child-process IPC surface required by the broker client. */
export interface SourceKeyBrokerProcessPort {
  readonly connected?: boolean;
  send?: (
    message: unknown,
    callback: (error: Error | null) => void,
  ) => boolean;
  on?: (
    event: 'message' | 'disconnect' | 'exit',
    listener: ProcessMessageListener | ProcessTerminalListener,
  ) => unknown;
  removeListener?: (
    event: 'message' | 'disconnect' | 'exit',
    listener: ProcessMessageListener | ProcessTerminalListener,
  ) => unknown;
}

export interface ProcessSourceKeyBrokerClientOptions
  extends Pick<
    SourceKeyBrokerClientOptions,
    'maxPendingRequests' | 'requestIdFactory' | 'requestTimeoutMs' | 'sessionAuthorityProvider'
  > {}

/**
 * Wire a broker client to the private IPC channel of an API or worker child.
 * No listener is attached unless the port is already connected and sendable.
 */
export function createProcessSourceKeyBrokerClient(
  role: SourceKeyBrokerRole,
  port: SourceKeyBrokerProcessPort =
    process as unknown as SourceKeyBrokerProcessPort,
  options: ProcessSourceKeyBrokerClientOptions = {},
): SourceKeyBrokerClient {
  let detach = (): void => {};
  const client = new SourceKeyBrokerClient({
    role,
    transport: {
      send(message: SourceKeyBrokerClientWireMessage): Promise<void> {
        return new Promise((resolve, reject) => {
          if (port.connected !== true || typeof port.send !== 'function') {
            reject(new Error('Source-key broker IPC is unavailable'));
            return;
          }
          try {
            // Node's boolean return is only a backpressure signal. The callback
            // is the authority for successful delivery to the IPC subsystem.
            port.send(message, (error) => {
              if (error) reject(new Error('Source-key broker IPC delivery failed'));
              else resolve();
            });
          } catch {
            reject(new Error('Source-key broker IPC delivery failed'));
          }
        });
      },
    },
    ...options,
    onDisconnect: () => detach(),
  });

  if (
    port.connected !== true ||
    typeof port.send !== 'function' ||
    typeof port.on !== 'function'
  ) {
    client.handleDisconnect();
    return client;
  }

  const onMessage: ProcessMessageListener = (message) =>
    client.handleMessage(message);
  const onTerminal: ProcessTerminalListener = () => client.handleDisconnect();
  detach = () => {
    if (typeof port.removeListener !== 'function') return;
    port.removeListener('message', onMessage);
    port.removeListener('disconnect', onTerminal);
    port.removeListener('exit', onTerminal);
  };

  try {
    port.on('message', onMessage);
    port.on('disconnect', onTerminal);
    port.on('exit', onTerminal);
  } catch {
    detach();
    client.handleDisconnect();
  }
  return client;
}
