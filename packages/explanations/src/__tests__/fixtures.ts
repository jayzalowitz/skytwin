import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';
import type {
  CandidateAction,
  DecisionContext,
  DecisionObject,
  DecisionOutcome,
  ExplanationRecord,
  Preference,
  RiskAssessment,
} from '@skytwin/shared-types';
import type { ExplanationRepositoryPort } from '../explanation-generator.js';

export function makeDecision(overrides?: Partial<DecisionObject>): DecisionObject {
  return {
    id: 'dec_001',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'low',
    summary: 'Email triage needed for "Weekly Newsletter"',
    rawData: {
      source: 'gmail',
      from: 'newsletter@techdigest.com',
      subject: 'Weekly Newsletter',
    },
    interpretedAt: new Date('2026-04-23T12:00:00Z'),
    ...overrides,
  };
}

export function makePreference(overrides?: Partial<Preference>): Preference {
  return {
    id: 'pref_001',
    domain: 'email',
    key: 'auto_archive_newsletters',
    value: true,
    confidence: ConfidenceLevel.HIGH,
    source: 'inferred',
    evidenceIds: ['ev_a', 'ev_b'],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-20T00:00:00Z'),
    ...overrides,
  };
}

export function makeAction(overrides?: Partial<CandidateAction>): CandidateAction {
  return {
    id: 'act_001',
    decisionId: 'dec_001',
    actionType: 'email-archive',
    description: 'Archive the newsletter',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'High confidence newsletter pattern match.',
    ...overrides,
  };
}

export function makeRiskAssessment(overrides?: Partial<RiskAssessment>): RiskAssessment {
  const dim = { tier: RiskTier.LOW, score: 0.2, reasoning: 'Low risk.' };
  return {
    actionId: 'act_001',
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: dim,
      [RiskDimension.FINANCIAL_IMPACT]: dim,
      [RiskDimension.LEGAL_SENSITIVITY]: dim,
      [RiskDimension.PRIVACY_SENSITIVITY]: dim,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: dim,
      [RiskDimension.OPERATIONAL_RISK]: dim,
    },
    reasoning: 'All dimensions low.',
    assessedAt: new Date('2026-04-23T12:00:00Z'),
    ...overrides,
  };
}

export function makeContext(overrides?: Partial<DecisionContext>): DecisionContext {
  return {
    userId: 'user_001',
    decision: makeDecision(),
    trustTier: TrustTier.MODERATE_AUTONOMY,
    relevantPreferences: [],
    timestamp: new Date('2026-04-23T12:00:00Z'),
    ...overrides,
  };
}

export interface MakeOutcomeOptions {
  selectedAction?: CandidateAction | null;
  allCandidates?: CandidateAction[];
  riskAssessment?: RiskAssessment | null;
  autoExecute?: boolean;
  requiresApproval?: boolean;
  reasoning?: string;
}

export function makeOutcome(opts: MakeOutcomeOptions = {}): DecisionOutcome {
  const selectedAction = opts.selectedAction === undefined ? makeAction() : opts.selectedAction;
  const allCandidates = opts.allCandidates ?? (selectedAction ? [selectedAction] : []);
  return {
    id: 'out_001',
    decisionId: 'dec_001',
    selectedAction,
    allCandidates,
    riskAssessment: opts.riskAssessment === undefined ? makeRiskAssessment() : opts.riskAssessment,
    autoExecute: opts.autoExecute ?? false,
    requiresApproval: opts.requiresApproval ?? false,
    reasoning: opts.reasoning ?? 'Selected the best candidate.',
    decidedAt: new Date('2026-04-23T12:00:00Z'),
  };
}

export class InMemoryExplanationRepo implements ExplanationRepositoryPort {
  saved: ExplanationRecord[] = [];

  async save(record: ExplanationRecord): Promise<ExplanationRecord> {
    this.saved.push(record);
    return record;
  }

  async getByDecisionId(decisionId: string): Promise<ExplanationRecord | null> {
    return this.saved.find((r) => r.decisionId === decisionId) ?? null;
  }

  async getByUserId(userId: string, limit?: number): Promise<ExplanationRecord[]> {
    const matches = this.saved.filter((r) => r.userId === userId);
    return limit ? matches.slice(0, limit) : matches;
  }
}

export class RejectingExplanationRepo implements ExplanationRepositoryPort {
  constructor(private readonly err: Error = new Error('save failed')) {}

  async save(): Promise<ExplanationRecord> {
    throw this.err;
  }

  async getByDecisionId(): Promise<ExplanationRecord | null> {
    return null;
  }

  async getByUserId(): Promise<ExplanationRecord[]> {
    return [];
  }
}
