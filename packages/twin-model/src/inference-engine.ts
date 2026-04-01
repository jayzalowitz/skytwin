import type {
  Inference,
  TwinEvidence,
  TwinProfile,
  Preference,
  FeedbackEvent,
  BehavioralPattern,
  CrossDomainTrait,
  TemporalProfile,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { PatternDetector } from './analyzers/pattern-detector.js';
import { TemporalAnalyzer } from './analyzers/temporal-analyzer.js';
import { CrossDomainAnalyzer } from './analyzers/cross-domain-analyzer.js';

/**
 * Report describing contradictions found among preferences.
 */
export interface ContradictionReport {
  hasContradictions: boolean;
  contradictions: Contradiction[];
}

export interface Contradiction {
  preferenceA: Preference;
  preferenceB: Preference;
  domain: string;
  description: string;
}

/**
 * The inference engine analyzes evidence to produce and update inferences
 * about user preferences. It detects patterns, calculates confidence,
 * and identifies contradictions.
 */
/**
 * Combined result from the full analysis pipeline.
 */
export interface FullAnalysisResult {
  inferences: Inference[];
  patterns: BehavioralPattern[];
  traits: CrossDomainTrait[];
  temporalProfile: TemporalProfile;
}

export class InferenceEngine {
  private readonly patternDetector = new PatternDetector();
  private readonly temporalAnalyzer = new TemporalAnalyzer();
  private readonly crossDomainAnalyzer = new CrossDomainAnalyzer();

  /**
   * Run the full analysis pipeline: basic inference + patterns + temporal + cross-domain.
   */
  analyzeWithPatterns(
    existing: Inference[],
    newEvidence: TwinEvidence[],
    existingPatterns: BehavioralPattern[],
  ): FullAnalysisResult {
    const inferences = this.analyzeEvidence(existing, newEvidence);
    const patterns = this.patternDetector.detectHabits(newEvidence, existingPatterns);
    const temporalProfile = this.temporalAnalyzer.analyzeTemporalPatterns(newEvidence);
    const traits = this.crossDomainAnalyzer.detectTraits(inferences, patterns);

    return { inferences, patterns, traits, temporalProfile };
  }

  /**
   * Analyze new evidence in the context of existing inferences to produce
   * an updated set of inferences.
   */
  analyzeEvidence(
    existing: Inference[],
    newEvidence: TwinEvidence[],
  ): Inference[] {
    const inferenceMap = new Map<string, Inference>();

    // Index existing inferences by domain+key
    for (const inf of existing) {
      inferenceMap.set(`${inf.domain}:${inf.key}`, inf);
    }

    // Group new evidence by domain
    const evidenceByDomain = new Map<string, TwinEvidence[]>();
    for (const ev of newEvidence) {
      const group = evidenceByDomain.get(ev.domain) ?? [];
      group.push(ev);
      evidenceByDomain.set(ev.domain, group);
    }

    // Process each domain's evidence
    for (const [domain, evidenceGroup] of evidenceByDomain) {
      const extractedSignals = this.extractSignals(evidenceGroup);

      for (const signal of extractedSignals) {
        const key = `${domain}:${signal.key}`;
        const existingInference = inferenceMap.get(key);

        if (existingInference) {
          // Update existing inference with new evidence
          const updatedInference = this.mergeInference(
            existingInference,
            signal,
            evidenceGroup,
          );
          inferenceMap.set(key, updatedInference);
        } else {
          // Create new inference
          const newInference: Inference = {
            id: `inf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            domain,
            key: signal.key,
            value: signal.value,
            confidence: this.calculateConfidence(evidenceGroup),
            supportingEvidenceIds: evidenceGroup.map((e) => e.id),
            contradictingEvidenceIds: [],
            reasoning: `Inferred from ${evidenceGroup.length} evidence item(s) in domain "${domain}".`,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          inferenceMap.set(key, newInference);
        }
      }
    }

    return Array.from(inferenceMap.values());
  }

  /**
   * Calculate confidence level based on evidence quantity and consistency.
   */
  calculateConfidence(evidence: TwinEvidence[]): ConfidenceLevel {
    if (evidence.length === 0) {
      return ConfidenceLevel.SPECULATIVE;
    }

    // Check for explicit user confirmations
    const hasExplicitConfirmation = evidence.some(
      (e) => e.type === 'explicit_preference' || e.type === 'user_correction',
    );
    if (hasExplicitConfirmation) {
      return ConfidenceLevel.CONFIRMED;
    }

    // Check consistency of evidence
    const consistency = this.measureConsistency(evidence);

    if (evidence.length >= 5 && consistency >= 0.8) {
      return ConfidenceLevel.HIGH;
    }
    if (evidence.length >= 3 && consistency >= 0.6) {
      return ConfidenceLevel.MODERATE;
    }
    if (evidence.length >= 2 && consistency >= 0.4) {
      return ConfidenceLevel.LOW;
    }

    return ConfidenceLevel.SPECULATIVE;
  }

  /**
   * Detect contradictions among a set of preferences.
   * Contradictions arise when preferences in the same domain
   * have conflicting values for the same key.
   */
  detectContradictions(preferences: Preference[]): ContradictionReport {
    const contradictions: Contradiction[] = [];

    // Group preferences by domain+key
    const grouped = new Map<string, Preference[]>();
    for (const pref of preferences) {
      const key = `${pref.domain}:${pref.key}`;
      const group = grouped.get(key) ?? [];
      group.push(pref);
      grouped.set(key, group);
    }

    // Check each group for conflicting values
    for (const [, group] of grouped) {
      if (group.length < 2) continue;

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;

          if (!this.valuesAreConsistent(a.value, b.value)) {
            contradictions.push({
              preferenceA: a,
              preferenceB: b,
              domain: a.domain,
              description:
                `Conflicting values for "${a.key}" in domain "${a.domain}": ` +
                `"${String(a.value)}" (${a.confidence}) vs "${String(b.value)}" (${b.confidence}).`,
            });
          }
        }
      }
    }

    return {
      hasContradictions: contradictions.length > 0,
      contradictions,
    };
  }

  /**
   * Update inferences based on user feedback about a specific decision.
   * Positive feedback strengthens relevant inferences; corrections
   * create new or updated inferences.
   */
  updateInferencesFromFeedback(
    profile: TwinProfile,
    feedback: FeedbackEvent,
  ): Inference[] {
    const updatedInferences = [...profile.inferences];

    switch (feedback.feedbackType) {
      case 'approve': {
        // Strengthen inferences related to this decision
        for (const inference of updatedInferences) {
          if (inference.supportingEvidenceIds.length > 0) {
            inference.confidence = this.increaseConfidence(inference.confidence);
            inference.updatedAt = new Date();
          }
        }
        break;
      }

      case 'reject': {
        // Weaken inferences related to this decision
        for (const inference of updatedInferences) {
          if (inference.supportingEvidenceIds.length > 0) {
            inference.confidence = this.decreaseConfidence(inference.confidence);
            inference.updatedAt = new Date();
          }
        }
        break;
      }

      case 'correct': {
        // Create a correction-based inference if corrected value provided
        if (feedback.correctedAction && feedback.correctedValue !== undefined) {
          const correctionInference: Inference = {
            id: `inf_correction_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            domain: 'correction',
            key: feedback.correctedAction,
            value: feedback.correctedValue,
            confidence: ConfidenceLevel.CONFIRMED,
            supportingEvidenceIds: [feedback.id],
            contradictingEvidenceIds: [],
            reasoning: `User explicitly corrected this preference. Reason: ${feedback.reason ?? 'none given'}.`,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          updatedInferences.push(correctionInference);
        }
        break;
      }

      case 'undo': {
        // Undo is a strong signal that the action was wrong — weaken
        // related inferences similarly to a reject.  The caller
        // (TwinService) applies additional 2x weight and severity
        // adjustments on top of this base correction.
        for (const inference of updatedInferences) {
          if (inference.supportingEvidenceIds.length > 0) {
            inference.confidence = this.decreaseConfidence(inference.confidence);
            inference.updatedAt = new Date();
          }
        }
        break;
      }

      case 'ignore': {
        // No inference update for ignored feedback
        break;
      }
    }

    return updatedInferences;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private extractSignals(
    evidence: TwinEvidence[],
  ): Array<{ key: string; value: unknown }> {
    const signals: Array<{ key: string; value: unknown }> = [];

    for (const ev of evidence) {
      // Extract action-based signals
      if (ev.data['action'] !== undefined) {
        signals.push({
          key: `preferred_action_${ev.type}`,
          value: ev.data['action'],
        });
      }

      // Extract value-based signals
      if (ev.data['preference_key'] !== undefined && ev.data['preference_value'] !== undefined) {
        signals.push({
          key: ev.data['preference_key'] as string,
          value: ev.data['preference_value'],
        });
      }

      // Extract behavior-based signals
      if (ev.data['behavior'] !== undefined) {
        signals.push({
          key: `behavior_${ev.type}`,
          value: ev.data['behavior'],
        });
      }

      // If no structured signal found, use the whole data object
      if (signals.length === 0) {
        signals.push({
          key: `observation_${ev.type}`,
          value: ev.data,
        });
      }
    }

    return signals;
  }

  private mergeInference(
    existing: Inference,
    signal: { key: string; value: unknown },
    evidence: TwinEvidence[],
  ): Inference {
    const newEvidenceIds = evidence.map((e) => e.id);
    const isConsistent = this.valuesAreConsistent(existing.value, signal.value);

    if (isConsistent) {
      return {
        ...existing,
        confidence: this.increaseConfidence(existing.confidence),
        supportingEvidenceIds: [
          ...existing.supportingEvidenceIds,
          ...newEvidenceIds,
        ],
        reasoning:
          existing.reasoning +
          ` Reinforced by ${evidence.length} additional evidence item(s).`,
        updatedAt: new Date(),
      };
    }

    // Contradicting evidence
    return {
      ...existing,
      confidence: this.decreaseConfidence(existing.confidence),
      contradictingEvidenceIds: [
        ...existing.contradictingEvidenceIds,
        ...newEvidenceIds,
      ],
      reasoning:
        existing.reasoning +
        ` Contradicted by ${evidence.length} evidence item(s); confidence decreased.`,
      updatedAt: new Date(),
    };
  }

  private measureConsistency(evidence: TwinEvidence[]): number {
    if (evidence.length <= 1) return 1.0;

    // Group by type and check value consistency
    const valuesByType = new Map<string, unknown[]>();
    for (const ev of evidence) {
      const values = valuesByType.get(ev.type) ?? [];
      values.push(ev.data['action'] ?? ev.data['preference_value'] ?? ev.data);
      valuesByType.set(ev.type, values);
    }

    let consistentPairs = 0;
    let totalPairs = 0;

    for (const [, values] of valuesByType) {
      for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
          totalPairs++;
          if (this.valuesAreConsistent(values[i], values[j])) {
            consistentPairs++;
          }
        }
      }
    }

    if (totalPairs === 0) return 1.0;
    return consistentPairs / totalPairs;
  }

  private valuesAreConsistent(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    // Deep equality for objects
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    // Numeric proximity
    if (typeof a === 'number' && typeof b === 'number') {
      const diff = Math.abs(a - b);
      const magnitude = Math.max(Math.abs(a), Math.abs(b), 1);
      return diff / magnitude < 0.2; // Within 20%
    }

    return false;
  }

  private increaseConfidence(current: ConfidenceLevel): ConfidenceLevel {
    const levels = [
      ConfidenceLevel.SPECULATIVE,
      ConfidenceLevel.LOW,
      ConfidenceLevel.MODERATE,
      ConfidenceLevel.HIGH,
      ConfidenceLevel.CONFIRMED,
    ];
    const idx = levels.indexOf(current);
    return levels[Math.min(idx + 1, levels.length - 1)]!;
  }

  private decreaseConfidence(current: ConfidenceLevel): ConfidenceLevel {
    const levels = [
      ConfidenceLevel.SPECULATIVE,
      ConfidenceLevel.LOW,
      ConfidenceLevel.MODERATE,
      ConfidenceLevel.HIGH,
      ConfidenceLevel.CONFIRMED,
    ];
    const idx = levels.indexOf(current);
    return levels[Math.max(idx - 1, 0)]!;
  }
}
