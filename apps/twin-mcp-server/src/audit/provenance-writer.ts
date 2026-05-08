import { randomUUID } from 'node:crypto';
import { provenanceRepository } from '@skytwin/db';

/** PII field names we strip before writing to the audit log. Stored lowercase; keys are lowercased before lookup. */
const PII_FIELDS = new Set([
  'email', 'phone', 'password', 'token', 'secret', 'ssn', 'credit_card',
  'card_number', 'cvv', 'api_key', 'apikey', 'authorization',
]);

/**
 * Recursively redact PII fields anywhere in a value tree (objects, arrays,
 * nested objects-in-arrays). Keys matched case-insensitively against PII_FIELDS;
 * values for matched keys are replaced with '[REDACTED]'. Primitives pass
 * through unchanged.
 */
export function redactPII(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue(args) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactValue(v);
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
