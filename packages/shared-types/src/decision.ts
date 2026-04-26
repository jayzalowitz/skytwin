import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  SituationType,
  TrustTier,
} from './enums.js';
import { Preference } from './twin.js';

/**
 * A structured representation of a situation requiring a decision.
 */
export interface DecisionObject {
  id: string;
  situationType: SituationType;
  domain: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  rawData: Record<string, unknown>;
  interpretedAt: Date;
}

/**
 * Full context for making a decision: the situation, the user, and the twin state.
 */
export interface DecisionContext {
  userId: string;
  decision: DecisionObject;
  trustTier: TrustTier;
  relevantPreferences: Preference[];
  timestamp: Date;
  /** Behavioral patterns detected from the user's history */
  patterns?: import('./patterns.js').BehavioralPattern[];
  /** Cross-domain traits detected across multiple domains */
  traits?: import('./patterns.js').CrossDomainTrait[];
  /** Temporal activity profile for the user */
  temporalProfile?: import('./patterns.js').TemporalProfile;
  /** Episodic memories relevant to this decision situation */
  episodicMemories?: import('./mempalace.js').EpisodicMemory[];
  /** Wake-up context (L0+L1) from the memory palace */
  wakeUpContext?: import('./mempalace.js').WakeUpContext;
}

/**
 * A candidate action that SkyTwin could take.
 */
export interface CandidateAction {
  id: string;
  decisionId: string;
  actionType: string;
  description: string;
  domain: string;
  parameters: Record<string, unknown>;
  estimatedCostCents: number;
  reversible: boolean;
  confidence: ConfidenceLevel;
  reasoning: string;
}

/**
 * Risk assessment for a candidate action, broken down by dimension.
 */
export interface RiskAssessment {
  actionId: string;
  overallTier: RiskTier;
  dimensions: Record<RiskDimension, DimensionAssessment>;
  reasoning: string;
  assessedAt: Date;
}

/**
 * Assessment for a single risk dimension.
 */
export interface DimensionAssessment {
  tier: RiskTier;
  score: number;
  reasoning: string;
}

/**
 * The outcome of the decision engine's evaluation.
 */
export interface DecisionOutcome {
  id: string;
  decisionId: string;
  selectedAction: CandidateAction | null;
  allCandidates: CandidateAction[];
  riskAssessment: RiskAssessment | null;
  autoExecute: boolean;
  requiresApproval: boolean;
  reasoning: string;
  decidedAt: Date;
  /**
   * Per-candidate policy verdicts, keyed by candidate id. Populated by the
   * decision engine; not persisted. Consumers (e.g. `whatWouldIDo`) use this
   * to filter alternatives so blocked candidates are not surfaced as options
   * the user could take. Safety Invariant #1.
   */
  policyVerdicts?: Record<string, PolicyVerdict>;
}

/**
 * Per-candidate policy verdict produced during decision evaluation.
 */
export type PolicyVerdict = 'allowed' | 'requires-approval' | 'denied';
