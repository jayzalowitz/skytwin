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
   * Optional link to a capability_provenance_nodes row.
   * When set, the provenance lineage view can walk from action → explanation.
   * Tracked in #305 — the parent epic #189 closed without wiring this
   * specific population path.
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
