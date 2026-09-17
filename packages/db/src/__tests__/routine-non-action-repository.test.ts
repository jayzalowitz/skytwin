import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfidenceLevel,
  RiskTier,
  SituationType,
  type CandidateAction,
  type DecisionObject,
  type DecisionOutcome,
  type ExplanationRecord,
  type RiskAssessment,
} from '@skytwin/shared-types';

interface FakeState {
  decisions: Map<string, string>;
  candidates: number;
  outcomes: number;
  explanations: number;
}

const harness = vi.hoisted(() => ({
  committed: {
    decisions: new Map<string, string>(),
    candidates: 0,
    outcomes: 0,
    explanations: 0,
  } as FakeState,
  failExplanation: false,
  transactionCount: 0,
  transactionSql: [] as string[],
  recoveryQuery: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => harness.recoveryQuery(...args),
  withTransaction: async (
    fn: (client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
  ) => {
    harness.transactionCount += 1;
    const draft: FakeState = {
      decisions: new Map(harness.committed.decisions),
      candidates: harness.committed.candidates,
      outcomes: harness.committed.outcomes,
      explanations: harness.committed.explanations,
    };
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        harness.transactionSql.push(sql);
        if (sql.startsWith('SELECT id FROM decisions')) {
          const key = `${String(values[0])}:${String(values[1])}`;
          const id = draft.decisions.get(key);
          return { rows: id ? [{ id }] : [] };
        }
        if (sql.includes('INSERT INTO decisions')) {
          draft.decisions.set(`${String(values[1])}:${String(values[8])}`, String(values[0]));
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO candidate_actions')) {
          draft.candidates += 1;
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO decision_outcomes')) {
          draft.outcomes += 1;
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO explanation_records')) {
          if (harness.failExplanation) throw new Error('explanation insert failed');
          draft.explanations += 1;
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const result = await fn(client);
    harness.committed = draft;
    return result;
  },
}));

const { routineNonActionRepository } = await import(
  '../repositories/routine-non-action-repository.js'
);

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const DECISION_ID = '11111111-1111-4111-8111-111111111111';
const ACTION_ID = '22222222-2222-4222-8222-222222222222';
const OUTCOME_ID = '33333333-3333-4333-8333-333333333333';
const EXPLANATION_ID = '44444444-4444-4444-8444-444444444444';

function input() {
  const decision: DecisionObject = {
    id: DECISION_ID,
    situationType: SituationType.GENERIC,
    domain: 'routines',
    urgency: 'medium',
    summary: 'Evaluate routine registration.',
    rawData: {
      userId: USER_ID,
      signalId: 'routine-registration:stable-key',
    },
    interpretedAt: new Date('2026-09-14T00:00:00.000Z'),
    provenance: 'user_originated',
  };
  const action: CandidateAction = {
    id: ACTION_ID,
    decisionId: DECISION_ID,
    actionType: 'create_note',
    description: 'Create a note on a schedule.',
    domain: 'routines',
    parameters: { userId: USER_ID },
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: ConfidenceLevel.LOW,
    reasoning: 'The request was normalized.',
    provenance: 'untrusted_external',
  };
  const risk: RiskAssessment = {
    actionId: ACTION_ID,
    overallTier: RiskTier.LOW,
    dimensions: {} as RiskAssessment['dimensions'],
    reasoning: 'Low risk, but unavailable.',
    assessedAt: new Date('2026-09-14T00:00:00.000Z'),
  };
  const outcome: DecisionOutcome = {
    id: OUTCOME_ID,
    decisionId: DECISION_ID,
    selectedAction: null,
    allCandidates: [action],
    riskAssessment: null,
    allRiskAssessments: [risk],
    autoExecute: false,
    requiresApproval: false,
    reasoning: 'Routine registration is unavailable.',
    decidedAt: new Date('2026-09-14T00:00:00.000Z'),
    policyVerdicts: { [ACTION_ID]: 'denied' },
  };
  const explanation: ExplanationRecord = {
    id: EXPLANATION_ID,
    decisionId: DECISION_ID,
    userId: USER_ID,
    summary: 'The routine was not registered.',
    evidenceUsed: [{
      evidenceId: ACTION_ID,
      source: 'routine_request',
      summary: 'Normalized routine request.',
      relevance: 'Exact request evaluated.',
    }],
    preferencesInvoked: [],
    confidenceReasoning: risk.reasoning,
    actionRationale: 'No dispatch was attempted.',
    escalationRationale: outcome.reasoning,
    correctionGuidance: 'Retry after the operation is supported.',
    riskTier: risk.overallTier,
    overallConfidence: action.confidence,
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
  };
  return { decision, action, risk, outcome, explanation };
}

describe('routineNonActionRepository', () => {
  beforeEach(() => {
    harness.committed = {
      decisions: new Map(),
      candidates: 0,
      outcomes: 0,
      explanations: 0,
    };
    harness.failExplanation = false;
    harness.transactionCount = 0;
    harness.transactionSql = [];
    harness.recoveryQuery.mockReset().mockResolvedValue({ rows: [] });
  });

  it('rolls back every artifact when explanation persistence fails, then permits a complete retry', async () => {
    harness.failExplanation = true;

    await expect(routineNonActionRepository.record(input()))
      .rejects.toThrow('explanation insert failed');
    expect(harness.committed.decisions.size).toBe(0);
    expect(harness.committed.candidates).toBe(0);
    expect(harness.committed.outcomes).toBe(0);
    expect(harness.committed.explanations).toBe(0);

    harness.failExplanation = false;
    await expect(routineNonActionRepository.record(input())).resolves.toEqual({
      created: true,
      decisionId: DECISION_ID,
    });
    expect(harness.committed.decisions.size).toBe(1);
    expect(harness.committed.candidates).toBe(1);
    expect(harness.committed.outcomes).toBe(1);
    expect(harness.committed.explanations).toBe(1);
  });

  it('returns the completed decision on replay without inserting any child twice', async () => {
    await routineNonActionRepository.record(input());
    const result = await routineNonActionRepository.record(input());

    expect(result).toEqual({ created: false, decisionId: DECISION_ID });
    expect(harness.committed.candidates).toBe(1);
    expect(harness.committed.outcomes).toBe(1);
    expect(harness.committed.explanations).toBe(1);
  });

  it('persists a non-action outcome with no selected action or selected risk authority', async () => {
    await routineNonActionRepository.record(input());

    const outcomeSql = harness.transactionSql.find((sql) => sql.includes('INSERT INTO decision_outcomes'));
    expect(outcomeSql).toContain('selected_action_id');
    expect(outcomeSql).toContain('VALUES ($1, $2, NULL');
  });

  it('rejects inconsistent non-action artifacts before opening a transaction', async () => {
    const malformed = input();
    malformed.outcome.selectedAction = malformed.action;

    await expect(routineNonActionRepository.record(malformed))
      .rejects.toThrow('must not identify an executed action');
    expect(harness.transactionCount).toBe(0);
  });
});
