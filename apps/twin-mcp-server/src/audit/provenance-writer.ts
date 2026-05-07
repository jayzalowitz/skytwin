import { randomUUID } from 'node:crypto';
import { provenanceRepository } from '@skytwin/db';

/** PII field names we strip before writing to the audit log. Stored lowercase; keys are lowercased before lookup. */
const PII_FIELDS = new Set([
  'email', 'phone', 'password', 'token', 'secret', 'ssn', 'credit_card',
  'card_number', 'cvv', 'api_key', 'apikey', 'authorization',
]);

/**
 * Recursively redact PII fields from an args object.
 * Only redacts top-level keys whose names match PII_FIELDS.
 */
export function redactPII(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (PII_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactPII(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface ProvenanceCallInput {
  userId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Write a capability_provenance_nodes row for an external-agent MCP tool call.
 * Called after every successful tool invocation (hard rail).
 */
export async function writeExternalAgentProvenance(input: ProvenanceCallInput): Promise<void> {
  const callId = randomUUID();
  await provenanceRepository.writeNode({
    userId: input.userId,
    nodeType: 'external_agent',
    refTable: 'external_agent_calls',
    refId: callId,
    occurredAt: new Date(),
    payload: {
      agentName: input.agentName,
      toolName: input.toolName,
      args: redactPII(input.args),
    },
  });
}
