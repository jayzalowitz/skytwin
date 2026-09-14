import type {
  CandidateAction,
  DecisionObject,
  DecisionOutcome,
  ExplanationRecord,
  RiskAssessment,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type { DecisionRow } from '../types.js';

export interface RecordRoutineNonActionInput {
  decision: DecisionObject;
  action: CandidateAction;
  risk: RiskAssessment;
  outcome: DecisionOutcome;
  explanation: ExplanationRecord;
}

export interface RecordRoutineNonActionResult {
  created: boolean;
  decisionId: string;
}

/**
 * Persist the complete audit record for a routine write that was deliberately
 * not dispatched. The decision's signal id is the idempotency authority. Every
 * child row is inserted in the same transaction so a failed explanation (or
 * any other failed child write) cannot strand a decision that suppresses a
 * later repair attempt.
 */
export const routineNonActionRepository = {
  async record(input: RecordRoutineNonActionInput): Promise<RecordRoutineNonActionResult> {
    assertConsistentInput(input);
    const signalId = input.decision.rawData['signalId'] as string;
    const userId = input.decision.rawData['userId'] as string;

    try {
      return await withTransaction(async (client) => {
        const existing = await client.query<Pick<DecisionRow, 'id'>>(
          'SELECT id FROM decisions WHERE user_id = $1 AND signal_id = $2 LIMIT 1',
          [userId, signalId],
        );
        if (existing.rows[0]) {
          return { created: false, decisionId: existing.rows[0].id };
        }

        await client.query(
          `INSERT INTO decisions (
            id, user_id, situation_type, raw_event, interpreted_situation,
            domain, urgency, metadata, signal_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.decision.id,
            userId,
            input.decision.situationType,
            JSON.stringify(input.decision.rawData),
            JSON.stringify({ summary: input.decision.summary }),
            input.decision.domain,
            input.decision.urgency,
            JSON.stringify({}),
            signalId,
          ],
        );

        await client.query(
          `INSERT INTO candidate_actions (
            id, decision_id, action_type, description, parameters,
            predicted_user_preference, risk_assessment, reversible, estimated_cost
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.action.id,
            input.decision.id,
            input.action.actionType,
            input.action.description,
            JSON.stringify({ ...input.action.parameters, domain: input.action.domain }),
            input.action.confidence,
            JSON.stringify(serializeRisk(input.risk)),
            input.action.reversible,
            input.action.estimatedCostCents > 0 ? input.action.estimatedCostCents : null,
          ],
        );

        await client.query(
          `INSERT INTO decision_outcomes (
            id, decision_id, selected_action_id, auto_executed,
            requires_approval, escalation_reason, explanation, confidence
          ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
          [
            input.outcome.id,
            input.decision.id,
            false,
            input.outcome.requiresApproval,
            input.outcome.requiresApproval ? input.outcome.reasoning : null,
            input.outcome.reasoning,
            0,
          ],
        );

        await client.query(
          `INSERT INTO explanation_records (
            id, decision_id, what_happened, evidence_used, preferences_invoked,
            confidence_reasoning, action_rationale, escalation_rationale,
            correction_guidance, capability_provenance_node_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            input.explanation.id,
            input.decision.id,
            input.explanation.summary,
            JSON.stringify(serializeEvidence(input.explanation)),
            serializePreferences(input.explanation),
            input.explanation.confidenceReasoning,
            input.explanation.actionRationale,
            input.explanation.escalationRationale ?? null,
            input.explanation.correctionGuidance,
            input.explanation.capabilityProvenanceNodeId ?? null,
          ],
        );

        return { created: true, decisionId: input.decision.id };
      });
    } catch (error) {
      // Two concurrent requests may both miss the lookup. The unique
      // (user_id, signal_id) index chooses one winner; withTransaction rolls
      // the losing transaction back in full before this recovery lookup.
      if ((error as { code?: unknown } | null)?.code === '23505') {
        const existing = await query<Pick<DecisionRow, 'id'>>(
          'SELECT id FROM decisions WHERE user_id = $1 AND signal_id = $2 LIMIT 1',
          [userId, signalId],
        );
        if (existing.rows[0]) {
          return { created: false, decisionId: existing.rows[0].id };
        }
      }
      throw error;
    }
  },
};

function assertConsistentInput(input: RecordRoutineNonActionInput): void {
  const signalId = input.decision.rawData['signalId'];
  const userId = input.decision.rawData['userId'];
  if (typeof signalId !== 'string' || signalId.length === 0 || signalId.length > 256) {
    throw new Error('Routine non-action requires a bounded signal id.');
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('Routine non-action requires a user id.');
  }
  if (
    input.action.decisionId !== input.decision.id ||
    input.risk.actionId !== input.action.id ||
    input.outcome.decisionId !== input.decision.id ||
    input.explanation.decisionId !== input.decision.id
  ) {
    throw new Error('Routine non-action artifacts do not share one decision and action identity.');
  }
  if (input.outcome.selectedAction !== null || input.outcome.riskAssessment !== null) {
    throw new Error('Routine non-action outcome must not identify an executed action.');
  }
  if (
    input.outcome.autoExecute ||
    input.outcome.allCandidates.length !== 1 ||
    input.outcome.allCandidates[0]?.id !== input.action.id ||
    input.outcome.allRiskAssessments?.length !== 1 ||
    input.outcome.allRiskAssessments[0]?.actionId !== input.action.id
  ) {
    throw new Error('Routine non-action outcome is inconsistent with its evaluated candidate.');
  }
}

function serializeRisk(risk: RiskAssessment): Record<string, unknown> {
  return {
    actionId: risk.actionId,
    overallTier: risk.overallTier,
    dimensions: risk.dimensions,
    reasoning: risk.reasoning,
    assessedAt: risk.assessedAt.toISOString(),
  };
}

function serializeEvidence(explanation: ExplanationRecord): unknown[] {
  return [
    ...explanation.evidenceUsed.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      source: evidence.source,
      summary: evidence.summary,
      relevance: evidence.relevance,
    })),
    {
      __adapter_meta: true,
      riskTier: explanation.riskTier,
      overallConfidence: explanation.overallConfidence,
      userId: explanation.userId,
    },
  ];
}

function serializePreferences(explanation: ExplanationRecord): string[] {
  return explanation.preferencesInvoked.map((preference) => JSON.stringify({
    preferenceId: preference.preferenceId,
    domain: preference.domain,
    key: preference.key,
    confidence: preference.confidence,
    howUsed: preference.howUsed,
  }));
}
