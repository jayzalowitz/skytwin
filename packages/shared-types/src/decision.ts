import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  SituationType,
  TrustTier,
} from './enums.js';
import type { ActionProvenance, ConfirmationLevel } from './action-safety.js';
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
  /**
   * Where the triggering content originated — the documentary-poisoning
   * defense. Set by the situation interpreter from the source signal's
   * authoring tier + source. When absent, consumers MUST treat it as
   * `untrusted_external` (fail safe). See `@skytwin/shared-types`
   * `action-safety.ts`.
   */
  provenance?: ActionProvenance;
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
  /**
   * Tags whether `estimatedCostCents = 0` represents a genuinely free
   * action (a read-only DirectExecutionAdapter op, a no-cost local
   * routine) or a not-yet-known cost that just defaulted to zero (#372).
   *
   *   `'verified_zero'` — caller has confirmed the action carries no
   *     LLM / API spend (or it costs the embedded local LLM nothing).
   *     The policy engine's zero-cost fast-path is allowed to fire.
   *   `'unknown'`       — caller does NOT know the cost yet (LLM-generated
   *     candidate; the LLM doesn't get to declare its own price). The
   *     fast-path MUST NOT fire — the action escalates or is gated by the
   *     downstream cost estimate.
   *   `undefined`       — legacy / pre-#372 callers. Treated as
   *     `'verified_zero'` for backward compatibility so existing
   *     rule-based generators that emit naked zero keep their semantics.
   *     New code paths should set this field explicitly.
   *
   * **Persistence note:** this flag must round-trip wherever
   * `CandidateAction` is stored or transported. The
   * `candidate_actions` JSONB column (saveCandidates) currently stores
   * fields explicitly — any new serializer or deserializer must include
   * `costZeroIntent` or a reloaded zero-cost candidate will be treated
   * as legacy `verified_zero` and re-open the bypass. The route-layer
   * approval payload in `events.ts` already passes `estimatedCostCents`;
   * serializers should additionally pass `costZeroIntent` whenever set.
   */
  costZeroIntent?: 'verified_zero' | 'unknown';
  reversible: boolean;
  confidence: ConfidenceLevel;
  reasoning: string;
  /**
   * Provenance copied from the originating `DecisionObject` so the policy
   * engine can gate the action without re-deriving where it came from. When
   * absent, the policy engine treats it as `untrusted_external` (fail safe).
   */
  provenance?: ActionProvenance;
  /**
   * Link to a `capability_provenance_nodes` row (#305). Populated when the
   * candidate originated from a capability-pipeline node (e.g. an MCP server
   * the user installed) so the lineage view can walk action → explanation
   * → provenance node back to the source capability. Engine-originated
   * candidates (rule-based, LLM-strategy, draft-email) leave this unset.
   */
  capabilityProvenanceNodeId?: string;
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
  /**
   * Convenience pointer to the SELECTED candidate's assessment.
   * Equals `allRiskAssessments.find(a => a.actionId === selectedAction.id)`.
   *
   * Pre-#412 this was the only field carrying assessments on the
   * outcome, which created a divergence hazard: any code path that
   * re-selected a candidate post-decision (manual override from the
   * approval queue, a future "swap candidate" UX, a bug) would leave
   * `riskAssessment` stale relative to `selectedAction`. The
   * execution-router backstop at `execution-router.ts:65-83` catches
   * the resulting `action.id !== riskAssessment.actionId` mismatch,
   * but only after a wrong-tier adapter was already picked.
   *
   * Consumers that care about a SPECIFIC candidate's risk (anything
   * other than the selected one) MUST look it up by id via
   * `allRiskAssessments` or `getAssessmentForAction(outcome, id)`.
   */
  riskAssessment: RiskAssessment | null;
  /**
   * Every candidate's assessment (#412). Source of truth for the
   * in-memory outcome. Equivalent to per-row reads of
   * `candidate_actions.risk_assessment` JSONB — the DB already
   * persists per-candidate; this field stops the in-memory layer
   * from losing that completeness.
   *
   * Optional for backward compatibility — pre-#412 outcomes (test
   * fixtures, legacy producers, the proactive evaluator's synthetic
   * outcomes) won't have it set. Consumers that need a specific
   * candidate's risk MUST handle the empty/undefined case (call
   * `getAssessmentForAction(outcome, id)`, which returns null when
   * the list is missing — and the caller should fall back to a DB
   * read via `decisionRepositoryAdapter.getRiskAssessment(id)`). The
   * decision-maker always populates this on real evaluations.
   */
  allRiskAssessments?: RiskAssessment[];
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
  /**
   * How many deliberate human confirmations the selected action needs when
   * `requiresApproval` is true. `dual` means two distinct confirmations are
   * required before execution — set by the policy engine's injection guard
   * for extreme-severity actions. Absent / `single` means one approval.
   */
  confirmationLevel?: ConfirmationLevel;
}

/**
 * Per-candidate policy verdict produced during decision evaluation.
 */
export type PolicyVerdict = 'allowed' | 'requires-approval' | 'denied';
