import type { SignalConnector } from '@skytwin/connectors';

interface ConnectorGroup {
  userId: string;
  connectors: SignalConnector[];
}

/** Stable key for breaker and health isolation; never contains a provider message id. */
export function connectorRuntimeKey(userId: string, connector: SignalConnector): string {
  return `${userId}:${connector.name}:${connector.connectorAccountId ?? 'unbound'}`;
}

/** Human source name plus stable account identity for connector_health uniqueness. */
export function connectorHealthName(connector: SignalConnector): string {
  return connector.connectorAccountId
    ? `${connector.name}:${connector.connectorAccountId}`
    : connector.name;
}

export function connectorTopology(groups: ConnectorGroup[]): string[] {
  return groups
    .flatMap((group) => group.connectors.map((connector) => connectorRuntimeKey(group.userId, connector)))
    .sort();
}

export function sameConnectorTopology(left: ConnectorGroup[], right: ConnectorGroup[]): boolean {
  const a = connectorTopology(left);
  const b = connectorTopology(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
