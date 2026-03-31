import { ConfidenceLevel } from './enums.js';

/**
 * A behavioral pattern detected from repeated user actions.
 */
export interface BehavioralPattern {
  id: string;
  userId: string;
  patternType: 'habit' | 'temporal' | 'contextual' | 'cross_domain';
  description: string;
  trigger: PatternTrigger;
  observedAction: string;
  frequency: number;
  confidence: ConfidenceLevel;
  firstObservedAt: Date;
  lastObservedAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Conditions that trigger a behavioral pattern.
 */
export interface PatternTrigger {
  domain?: string;
  source?: string;
  timeOfDay?: { start: number; end: number };
  dayOfWeek?: number[];
  senderPattern?: string;
  subjectPattern?: string;
  conditions: Record<string, unknown>;
}

/**
 * Temporal activity profile derived from evidence timestamps.
 */
export interface TemporalProfile {
  userId: string;
  activeHours: { start: number; end: number };
  peakResponseTimes: Record<string, number>;
  weekdayPatterns: Record<number, string[]>;
  urgencyThresholds: Record<string, number>;
}

/**
 * A trait observed consistently across multiple domains.
 */
export interface CrossDomainTrait {
  id: string;
  traitName: string;
  confidence: ConfidenceLevel;
  supportingDomains: string[];
  evidenceCount: number;
  description: string;
}
