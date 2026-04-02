import type { DecisionRepositoryPort } from '@skytwin/decision-engine';
import type {
  DecisionObject,
  DecisionOutcome,
  CandidateAction,
  RiskAssessment,
} from '@skytwin/shared-types';
import { ConfidenceLevel, RiskTier, SituationType } from '@skytwin/shared-types';
import { decisionRepository } from '../repositories/index.js';
import { query } from '../connection.js';
import type {
  DecisionRow,
  CandidateActionRow,
  DecisionOutcomeRow,
} from '../types.js';

/**
 * Map a domain-level DecisionObject urgency value to the DB representation.
 * The DB stores urgency as a string; DecisionObject uses a narrower union.
 */
function urgencyToDb(urgency: DecisionObject['urgency']): string {
  return urgency;
}

/**
 * Map a DB urgency string back to the DecisionObject's union type.
 * Falls back to 'medium' for unrecognised values.
 */
function urgencyFromDb(value: string): DecisionObject['urgency'] {
  const valid: DecisionObject['urgency'][] = ['low', 'medium', 'high', 'critical'];
  if ((valid as string[]).includes(value)) {
    return value as DecisionObject['urgency'];
  }
  return 'medium';
}

/**
 * Parse a string into a SituationType enum value.
 * Falls back to SituationType.GENERIC for unrecognised values.
 */
function parseSituationType(value: string): SituationType {
  const values = Object.values(SituationType) as string[];
  if (values.includes(value)) {
    return value as SituationType;
  }
  return SituationType.GENERIC;
}

/**
 * Parse a string into a ConfidenceLevel enum value.
 * Falls back to ConfidenceLevel.SPECULATIVE for unrecognised values.
 */
function parseConfidenceLevel(value: string): ConfidenceLevel {
  const values = Object.values(ConfidenceLevel) as string[];
  if (values.includes(value)) {
    return value as ConfidenceLevel;
  }
  return ConfidenceLevel.SPECULATIVE;
}

/**
 * Parse a string into a RiskTier enum value.
 * Falls back to RiskTier.NEGLIGIBLE for unrecognised values.
 */
function parseRiskTier(value: string): RiskTier {
  const values = Object.values(RiskTier) as string[];
  if (values.includes(value)) {
    return value as RiskTier;
  }
  return RiskTier.NEGLIGIBLE;
}

// ── Row-to-domain mappers ────────────────────────────────────────────────────

function decisionRowToDomain(row: DecisionRow): DecisionObject {
  return {
    id: row.id,
    situationType: parseSituationType(row.situation_type),
    domain: row.domain,
    urgency: urgencyFromDb(row.urgency),
    summary: (row.interpreted_situation['summary'] as string) ?? '',
    rawData: row.raw_event,
    interpretedAt: row.created_at,
  };
}

function candidateRowToDomain(row: CandidateActionRow): CandidateAction {
  const riskData = row.risk_assessment as Record<string, unknown>;
  return {
    id: row.id,
    decisionId: row.decision_id,
    actionType: row.action_type,
    description: row.description,
    domain: (row.parameters['domain'] as string) ?? '',
    parameters: row.parameters,
    estimatedCostCents: row.estimated_cost ?? 0,
    reversible: row.reversible,
    confidence: parseConfidenceLevel(row.predicted_user_preference),
    reasoning: (riskData['reasoning'] as string) ?? '',
  };
}

function outcomeRowToDomain(
  row: DecisionOutcomeRow,
  selectedAction: CandidateAction | null,
  allCandidates: CandidateAction[],
  riskAssessment: RiskAssessment | null,
): DecisionOutcome {
  return {
    id: row.id,
    decisionId: row.decision_id,
    selectedAction,
    allCandidates,
    riskAssessment,
    autoExecute: row.auto_executed,
    requiresApproval: row.requires_approval,
    reasoning: row.escalation_reason ?? row.explanation,
    decidedAt: row.created_at,
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Adapter that bridges the DecisionRepositoryPort interface used by business
 * logic to the concrete decisionRepository backed by CockroachDB.
 */
export const decisionRepositoryAdapter: DecisionRepositoryPort = {
  async saveDecision(decision: DecisionObject): Promise<DecisionObject> {
    const userId =
      (decision.rawData['userId'] as string | undefined) ?? '';

    const row = await decisionRepository.create({
      id: decision.id,
      userId,
      situationType: decision.situationType,
      rawEvent: decision.rawData,
      interpretedSituation: { summary: decision.summary },
      domain: decision.domain,
      urgency: urgencyToDb(decision.urgency),
    });

    return decisionRowToDomain(row);
  },

  async getDecision(decisionId: string): Promise<DecisionObject | null> {
    const row = await decisionRepository.findById(decisionId);
    if (!row) return null;
    return decisionRowToDomain(row);
  },

  async saveOutcome(outcome: DecisionOutcome): Promise<DecisionOutcome> {
    const row = await decisionRepository.recordOutcome({
      decisionId: outcome.decisionId,
      selectedActionId: outcome.selectedAction?.id ?? null,
      autoExecuted: outcome.autoExecute,
      requiresApproval: outcome.requiresApproval,
      escalationReason: outcome.requiresApproval ? outcome.reasoning : null,
      explanation: outcome.reasoning,
      confidence: outcome.riskAssessment
        ? riskTierToConfidenceNumber(outcome.riskAssessment.overallTier)
        : 0,
    });

    return outcomeRowToDomain(
      row,
      outcome.selectedAction,
      outcome.allCandidates,
      outcome.riskAssessment,
    );
  },

  async getOutcome(decisionId: string): Promise<DecisionOutcome | null> {
    const row = await decisionRepository.getOutcome(decisionId);
    if (!row) return null;

    const candidateRows = await decisionRepository.getCandidateActions(decisionId);
    const allCandidates = candidateRows.map(candidateRowToDomain);

    const selectedAction = row.selected_action_id
      ? allCandidates.find((c) => c.id === row.selected_action_id) ?? null
      : null;

    // Attempt to reconstruct risk assessment from the selected action's
    // risk_assessment JSONB column if available.
    let riskAssessment: RiskAssessment | null = null;
    if (selectedAction && row.selected_action_id) {
      const selectedRow = candidateRows.find(
        (r) => r.id === row.selected_action_id,
      );
      if (selectedRow) {
        riskAssessment = parseRiskAssessmentFromRow(selectedRow);
      }
    }

    return outcomeRowToDomain(row, selectedAction, allCandidates, riskAssessment);
  },

  async saveCandidates(
    candidates: CandidateAction[],
  ): Promise<CandidateAction[]> {
    const saved: CandidateAction[] = [];

    for (const candidate of candidates) {
      const row = await decisionRepository.addCandidateAction({
        id: candidate.id,
        decisionId: candidate.decisionId,
        actionType: candidate.actionType,
        description: candidate.description,
        parameters: { ...candidate.parameters, domain: candidate.domain },
        predictedUserPreference: candidate.confidence,
        riskAssessment: { reasoning: candidate.reasoning },
        reversible: candidate.reversible,
        estimatedCost: candidate.estimatedCostCents > 0
          ? candidate.estimatedCostCents
          : null,
      });

      saved.push(candidateRowToDomain(row));
    }

    return saved;
  },

  async getCandidates(decisionId: string): Promise<CandidateAction[]> {
    const rows = await decisionRepository.getCandidateActions(decisionId);
    return rows.map(candidateRowToDomain);
  },

  async saveRiskAssessment(
    assessment: RiskAssessment,
  ): Promise<RiskAssessment> {
    // Skip persistence if the action ID isn't a valid UUID (e.g. in-memory
    // candidate IDs like "cand_123_archive" from the decision engine).
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(assessment.actionId)) {
      return assessment;
    }

    const serialised = {
      actionId: assessment.actionId,
      overallTier: assessment.overallTier,
      dimensions: assessment.dimensions,
      reasoning: assessment.reasoning,
      assessedAt: assessment.assessedAt.toISOString(),
    };

    await query(
      `UPDATE candidate_actions
       SET risk_assessment = $1
       WHERE id = $2`,
      [JSON.stringify(serialised), assessment.actionId],
    );

    return assessment;
  },

  async getRiskAssessment(
    actionId: string,
  ): Promise<RiskAssessment | null> {
    const result = await query<CandidateActionRow>(
      'SELECT * FROM candidate_actions WHERE id = $1',
      [actionId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return parseRiskAssessmentFromRow(row);
  },

  async getRecentDecisions(
    userId: string,
    limit?: number,
  ): Promise<DecisionObject[]> {
    const rows = await decisionRepository.findByUser(userId, {
      limit: limit ?? 20,
    });
    return rows.map(decisionRowToDomain);
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a RiskTier to a numeric confidence value (0-1 scale, inverted:
 * higher risk = lower confidence number) for storage in the decision_outcomes
 * confidence column.
 */
function riskTierToConfidenceNumber(tier: RiskTier): number {
  const map: Record<RiskTier, number> = {
    [RiskTier.NEGLIGIBLE]: 1.0,
    [RiskTier.LOW]: 0.8,
    [RiskTier.MODERATE]: 0.6,
    [RiskTier.HIGH]: 0.4,
    [RiskTier.CRITICAL]: 0.2,
  };
  return map[tier];
}

/**
 * Attempt to reconstruct a RiskAssessment domain object from a
 * CandidateActionRow's risk_assessment JSONB column.
 * Returns null if the stored data does not contain the expected shape.
 */
function parseRiskAssessmentFromRow(
  row: CandidateActionRow,
): RiskAssessment | null {
  const data = row.risk_assessment;
  if (!data || typeof data !== 'object') return null;

  const overallTier = data['overallTier'];
  if (typeof overallTier !== 'string') return null;

  return {
    actionId: (data['actionId'] as string) ?? row.id,
    overallTier: parseRiskTier(overallTier),
    dimensions: (data['dimensions'] as RiskAssessment['dimensions']) ?? ({} as RiskAssessment['dimensions']),
    reasoning: (data['reasoning'] as string) ?? '',
    assessedAt: data['assessedAt']
      ? new Date(data['assessedAt'] as string)
      : row.created_at,
  };
}
