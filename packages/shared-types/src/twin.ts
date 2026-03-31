import { ConfidenceLevel } from './enums.js';

/**
 * The digital twin profile: a structured model of the user's preferences,
 * decision patterns, and inferred behaviors.
 */
export interface TwinProfile {
  id: string;
  userId: string;
  version: number;
  preferences: Preference[];
  inferences: Inference[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single preference the twin has learned about the user.
 */
export interface Preference {
  id: string;
  domain: string;
  key: string;
  value: unknown;
  confidence: ConfidenceLevel;
  source: PreferenceSource;
  evidenceIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How a preference was established.
 */
export type PreferenceSource = 'explicit' | 'inferred' | 'default' | 'corrected';

/**
 * An inference drawn from evidence about user behavior.
 */
export interface Inference {
  id: string;
  domain: string;
  key: string;
  value: unknown;
  confidence: ConfidenceLevel;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  reasoning: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A piece of evidence from user behavior that supports or contradicts an inference.
 */
export interface TwinEvidence {
  id: string;
  userId: string;
  source: string;
  type: string;
  data: Record<string, unknown>;
  domain: string;
  timestamp: Date;
}

/**
 * Feedback from the user about a decision SkyTwin made.
 */
export interface FeedbackEvent {
  id: string;
  userId: string;
  decisionId: string;
  feedbackType: 'approve' | 'reject' | 'correct' | 'ignore';
  correctedAction?: string;
  correctedValue?: unknown;
  reason?: string;
  timestamp: Date;
}
