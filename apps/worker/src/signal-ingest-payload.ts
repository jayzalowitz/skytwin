import type { RawSignal } from '@skytwin/connectors';

const GMAIL_DATA_KEYS = [
  'from', 'to', 'cc', 'hasInReplyTo', 'hasListUnsubscribe', 'subject', 'snippet',
  'labels', 'listId', 'authoringTier', 'receivedAt', 'requiresResponse',
] as const;

/** Build the loopback service payload without duplicating Gmail provider ids. */
export function buildSignalIngestPayload(
  signal: RawSignal,
  userId: string,
): Record<string, unknown> {
  let forwardedData = { ...signal.data };
  if (signal.connectorEvidence?.kind === 'gmail_message') {
    // Structural allowlist: nested caller-shaped blobs and provider response
    // fields never cross into interpretation, even if they hide target ids.
    forwardedData = {};
    for (const key of GMAIL_DATA_KEYS) {
      if (signal.data[key] !== undefined) forwardedData[key] = signal.data[key];
    }
  }
  return {
    ...forwardedData,
    source: signal.source,
    type: signal.type,
    signalId: signal.id,
    userId,
    ...(signal.connectorEvidence ? { connectorEvidence: signal.connectorEvidence } : {}),
  };
}
