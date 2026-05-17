import { ConfidenceLevel, RiskTier } from './enums.js';

/**
 * A complete explanation record for a decision.
 */
export interface ExplanationRecord {
  id: string;
  decisionId: string;
  userId: string;
  summary: string;
  evidenceUsed: EvidenceReference[];
  preferencesInvoked: PreferenceReference[];
  confidenceReasoning: string;
  actionRationale: string;
  escalationRationale?: string;
  correctionGuidance: string;
  riskTier: RiskTier;
  overallConfidence: ConfidenceLevel;
  /**
   * Link to a `capability_provenance_nodes` row when the explanation's
   * action originated from a capability-pipeline node (an installed MCP
   * server, a recipe). The lineage view walks action → explanation →
   * provenance node via this field to answer "which capability led
   * here?" for a user inspecting an MCP-mediated action.
   *
   * Engine-originated actions (rule-based, LLM-strategy, draft-email)
   * leave this unset. As of #305 the plumbing supports the field
   * end-to-end (CandidateAction.capabilityProvenanceNodeId →
   * ExplanationGenerator → DB column). No candidate generator stamps
   * it today; the MCP-host candidate-suggestion path that does is the
   * follow-up consumer.
   */
  capabilityProvenanceNodeId?: string;
  createdAt: Date;
}

/**
 * Reference to a piece of evidence used in an explanation.
 */
export interface EvidenceReference {
  evidenceId: string;
  source: string;
  summary: string;
  relevance: string;
}

/**
 * Reference to a preference invoked in an explanation.
 */
export interface PreferenceReference {
  preferenceId: string;
  domain: string;
  key: string;
  confidence: ConfidenceLevel;
  howUsed: string;
}
