import { SituationType, ConfidenceLevel } from '@skytwin/shared-types';
import type { DecisionObject, CandidateAction } from '@skytwin/shared-types';
import { randomUUID } from 'node:crypto';

const VALID_SITUATION_TYPES = new Set(Object.values(SituationType));
const VALID_CONFIDENCE_LEVELS = new Set(Object.values(ConfidenceLevel));
const VALID_URGENCIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Extract JSON from an LLM response that may contain markdown fences or preamble.
 */
function extractJson(text: string): string {
  // Try markdown code block first
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1]!.trim();

  // Try raw JSON (array or object)
  const raw = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (raw) return raw[1]!.trim();

  return text.trim();
}

/**
 * Parse the LLM's situation interpretation response into a DecisionObject.
 */
export function parseSituationResponse(
  text: string,
  rawEvent: Record<string, unknown>,
): DecisionObject | null {
  try {
    const json = JSON.parse(extractJson(text)) as Record<string, unknown>;

    const situationType = json['situationType'] as string;
    if (!VALID_SITUATION_TYPES.has(situationType as SituationType)) {
      console.warn(`[llm-parser] Invalid situationType: ${situationType}`);
      return null;
    }

    const urgency = json['urgency'] as string;
    if (!VALID_URGENCIES.has(urgency)) {
      console.warn(`[llm-parser] Invalid urgency: ${urgency}`);
      return null;
    }

    return {
      id: randomUUID(),
      situationType: situationType as SituationType,
      domain: typeof json['domain'] === 'string' ? json['domain'] : 'generic',
      urgency: urgency as 'low' | 'medium' | 'high' | 'critical',
      summary: typeof json['summary'] === 'string' ? json['summary'] : 'LLM-interpreted event',
      rawData: rawEvent,
      interpretedAt: new Date(),
    };
  } catch (err) {
    console.warn(`[llm-parser] Failed to parse situation response: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Parse the LLM's candidate generation response into CandidateAction[].
 * Drops malformed candidates with warnings.
 */
export function parseCandidateResponse(
  text: string,
  decisionId: string,
): CandidateAction[] {
  try {
    const json = JSON.parse(extractJson(text)) as unknown[];

    if (!Array.isArray(json)) {
      console.warn('[llm-parser] Candidate response is not an array');
      return [];
    }

    const candidates: CandidateAction[] = [];

    for (const raw of json) {
      const item = raw as Record<string, unknown>;
      const candidate = validateCandidate(item, decisionId);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    return candidates;
  } catch (err) {
    console.warn(`[llm-parser] Failed to parse candidate response: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function validateCandidate(
  item: Record<string, unknown>,
  decisionId: string,
): CandidateAction | null {
  const actionType = item['actionType'];
  if (typeof actionType !== 'string' || !actionType) {
    console.warn('[llm-parser] Candidate missing actionType');
    return null;
  }

  const description = typeof item['description'] === 'string' ? item['description'] : actionType;
  const domain = typeof item['domain'] === 'string' ? item['domain'] : 'generic';
  const parameters = (typeof item['parameters'] === 'object' && item['parameters'] !== null)
    ? item['parameters'] as Record<string, unknown>
    : {};
  // Safety invariant: LLM must not control spend limits or reversibility.
  // estimatedCostCents defaults to 0 (deterministic cost lookup happens downstream).
  // reversible defaults to false (safe default — the scoring/policy layer can upgrade).
  const estimatedCostCents = 0;
  const reversible = false;

  let confidence = ConfidenceLevel.MODERATE;
  if (typeof item['confidence'] === 'string' && VALID_CONFIDENCE_LEVELS.has(item['confidence'] as ConfidenceLevel)) {
    confidence = item['confidence'] as ConfidenceLevel;
  }

  const reasoning = typeof item['reasoning'] === 'string' ? item['reasoning'] : 'LLM-generated candidate';

  return {
    id: randomUUID(),
    decisionId,
    actionType,
    description,
    domain,
    parameters,
    estimatedCostCents,
    reversible,
    confidence,
    reasoning,
  };
}
