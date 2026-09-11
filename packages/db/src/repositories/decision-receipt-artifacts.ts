import type { DecisionReceiptArtifactKind } from '@skytwin/shared-types';

export type DecisionReceiptRowArtifactKind = Extract<
  DecisionReceiptArtifactKind,
  'decision' | 'candidate_action' | 'explanation' | 'signal' | 'preference' |
  'feedback' | 'inference_completion'
>;

const V1_FIELDS: Record<DecisionReceiptRowArtifactKind, readonly string[]> = {
  decision: [
    'id', 'user_id', 'situation_type', 'raw_event', 'interpreted_situation',
    'domain', 'urgency', 'metadata', 'signal_id',
  ],
  candidate_action: [
    'id', 'decision_id', 'action_type', 'description', 'parameters',
    'predicted_user_preference', 'risk_assessment', 'reversible', 'estimated_cost',
  ],
  explanation: [
    'id', 'decision_id', 'what_happened', 'evidence_used', 'preferences_invoked',
    'confidence_reasoning', 'action_rationale', 'escalation_rationale',
    'correction_guidance', 'capability_provenance_node_id',
  ],
  signal: [
    'id', 'user_id', 'source', 'type', 'domain', 'data', 'timestamp', 'retention_until',
  ],
  preference: [
    'id', 'user_id', 'domain', 'key', 'value', 'confidence', 'source', 'evidence',
    'version', 'value_encrypted', 'evidence_encrypted', 'encryption_key_version',
  ],
  feedback: ['id', 'user_id', 'decision_id', 'type', 'data'],
  inference_completion: ['decision_id', 'explanation_id', 'completed_at'],
};

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

/**
 * Stable v1 projection for row-backed receipt artifacts. Unknown/future DB
 * columns are deliberately ignored; changing this allowlist requires v2.
 */
export function decisionReceiptRowArtifactV1(
  kind: DecisionReceiptRowArtifactKind,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const field of V1_FIELDS[kind]) {
    if (Object.prototype.hasOwnProperty.call(row, field)) projection[field] = normalize(row[field]);
  }
  return projection;
}
