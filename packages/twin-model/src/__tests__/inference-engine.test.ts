import { describe, it, expect, beforeEach } from 'vitest';
import { InferenceEngine } from '../inference-engine.js';
import type {
  Inference,
  TwinEvidence,
  TwinProfile,
  Preference,
  FeedbackEvent,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Helpers ──────────────────────────────────────────────────────

function makeEvidence(overrides: Partial<TwinEvidence> = {}): TwinEvidence {
  return {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    userId: 'user_test',
    source: 'test_source',
    type: 'user_action',
    data: { action: 'archive' },
    domain: 'email',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeInference(overrides: Partial<Inference> = {}): Inference {
  return {
    id: `inf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    domain: 'email',
    key: 'preferred_action_user_action',
    value: 'archive',
    confidence: ConfidenceLevel.MODERATE,
    supportingEvidenceIds: ['ev_1'],
    contradictingEvidenceIds: [],
    reasoning: 'Inferred from evidence.',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePreference(overrides: Partial<Preference> = {}): Preference {
  return {
    id: `pref_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    domain: 'email',
    key: 'auto_archive',
    value: true,
    confidence: ConfidenceLevel.HIGH,
    source: 'explicit',
    evidenceIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeProfile(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    id: 'twin_test',
    userId: 'user_test',
    version: 1,
    preferences: [],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('InferenceEngine', () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    engine = new InferenceEngine();
  });

  // ── 1. calculateConfidence() ─────────────────────────────────────

  describe('calculateConfidence', () => {
    it('should return SPECULATIVE for empty evidence', () => {
      const result = engine.calculateConfidence([]);
      expect(result).toBe(ConfidenceLevel.SPECULATIVE);
    });

    it('should return CONFIRMED when evidence includes explicit_preference type', () => {
      const evidence = [
        makeEvidence({ type: 'explicit_preference' }),
      ];
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.CONFIRMED);
    });

    it('should return CONFIRMED when evidence includes user_correction type', () => {
      const evidence = [
        makeEvidence({ type: 'user_correction' }),
      ];
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.CONFIRMED);
    });

    it('should return HIGH for 5+ evidence items with >= 80% consistency', () => {
      // 5 items with the same action value => 100% consistency
      const evidence = Array.from({ length: 5 }, (_, i) =>
        makeEvidence({
          id: `ev_${i}`,
          type: 'user_action',
          data: { action: 'archive' },
        }),
      );
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.HIGH);
    });

    it('should return MODERATE for 3+ evidence items with >= 60% consistency', () => {
      // 3 items with the same action => 100% consistency, 3 items total
      const evidence = Array.from({ length: 3 }, (_, i) =>
        makeEvidence({
          id: `ev_${i}`,
          type: 'user_action',
          data: { action: 'archive' },
        }),
      );
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.MODERATE);
    });

    it('should return LOW for 2+ evidence items with >= 40% consistency', () => {
      // 2 items: one says 'archive', another says 'delete' (different type avoids pairwise comparison)
      // Use same type so they get compared, but mix values to lower consistency
      // 2 of same type with different values => 0% consistency among those pairs
      // We need at least 40% consistency. Let's have 2 consistent + 1 inconsistent in same type = 2 items same, 1 different
      // Actually, let's think carefully about what gives exactly LOW.
      // With 2 items of same type, same value: consistency = 1.0, length = 2 => LOW (2 >= 2 && 1.0 >= 0.4)
      const evidence = [
        makeEvidence({ id: 'ev_0', type: 'user_action', data: { action: 'archive' } }),
        makeEvidence({ id: 'ev_1', type: 'user_action', data: { action: 'archive' } }),
      ];
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.LOW);
    });

    it('should return SPECULATIVE for single non-explicit evidence item', () => {
      const evidence = [
        makeEvidence({ type: 'observation', data: { action: 'archive' } }),
      ];
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.SPECULATIVE);
    });

    it('should return SPECULATIVE when consistency is too low for any threshold', () => {
      // 5 items of same type, all different values => 0 consistent pairs out of 10 => 0% consistency
      // 5 >= 5 but 0.0 < 0.8, 5 >= 3 but 0.0 < 0.6, 5 >= 2 but 0.0 < 0.4 => SPECULATIVE
      const evidence = Array.from({ length: 5 }, (_, i) =>
        makeEvidence({
          id: `ev_${i}`,
          type: 'user_action',
          data: { action: `action_${i}` },
        }),
      );
      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.SPECULATIVE);
    });

    it('should prefer CONFIRMED over HIGH even with many consistent items', () => {
      const evidence = Array.from({ length: 10 }, (_, i) =>
        makeEvidence({
          id: `ev_${i}`,
          type: 'user_action',
          data: { action: 'archive' },
        }),
      );
      // Add one explicit preference
      evidence.push(makeEvidence({ id: 'ev_explicit', type: 'explicit_preference' }));

      const result = engine.calculateConfidence(evidence);
      expect(result).toBe(ConfidenceLevel.CONFIRMED);
    });
  });

  // ── 2. detectContradictions() ────────────────────────────────────

  describe('detectContradictions', () => {
    it('should report no contradictions when preferences are consistent', () => {
      const preferences = [
        makePreference({ domain: 'email', key: 'auto_archive', value: true }),
        makePreference({ domain: 'calendar', key: 'auto_accept', value: false }),
      ];

      const report = engine.detectContradictions(preferences);

      expect(report.hasContradictions).toBe(false);
      expect(report.contradictions).toEqual([]);
    });

    it('should report no contradictions for single preferences per domain+key', () => {
      const preferences = [
        makePreference({ domain: 'email', key: 'auto_archive', value: true }),
        makePreference({ domain: 'email', key: 'reply_style', value: 'brief' }),
      ];

      const report = engine.detectContradictions(preferences);

      expect(report.hasContradictions).toBe(false);
      expect(report.contradictions).toHaveLength(0);
    });

    it('should report no contradictions when same domain+key has matching values', () => {
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'auto_archive', value: true }),
        makePreference({ id: 'p2', domain: 'email', key: 'auto_archive', value: true }),
      ];

      const report = engine.detectContradictions(preferences);

      expect(report.hasContradictions).toBe(false);
    });

    it('should detect contradictions when same domain+key has conflicting values', () => {
      const prefA = makePreference({
        id: 'pref_a',
        domain: 'email',
        key: 'auto_archive',
        value: true,
        confidence: ConfidenceLevel.HIGH,
      });
      const prefB = makePreference({
        id: 'pref_b',
        domain: 'email',
        key: 'auto_archive',
        value: false,
        confidence: ConfidenceLevel.LOW,
      });

      const report = engine.detectContradictions([prefA, prefB]);

      expect(report.hasContradictions).toBe(true);
      expect(report.contradictions).toHaveLength(1);
      expect(report.contradictions[0]!.preferenceA).toBe(prefA);
      expect(report.contradictions[0]!.preferenceB).toBe(prefB);
      expect(report.contradictions[0]!.domain).toBe('email');
      expect(report.contradictions[0]!.description).toContain('auto_archive');
      expect(report.contradictions[0]!.description).toContain('email');
    });

    it('should detect multiple contradictions across different keys', () => {
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'auto_archive', value: true }),
        makePreference({ id: 'p2', domain: 'email', key: 'auto_archive', value: false }),
        makePreference({ id: 'p3', domain: 'email', key: 'reply_style', value: 'brief' }),
        makePreference({ id: 'p4', domain: 'email', key: 'reply_style', value: 'detailed' }),
      ];

      const report = engine.detectContradictions(preferences);

      expect(report.hasContradictions).toBe(true);
      expect(report.contradictions).toHaveLength(2);
    });

    it('should not treat preferences in different domains as contradictions', () => {
      const preferences = [
        makePreference({ domain: 'email', key: 'auto_archive', value: true }),
        makePreference({ domain: 'calendar', key: 'auto_archive', value: false }),
      ];

      const report = engine.detectContradictions(preferences);

      expect(report.hasContradictions).toBe(false);
    });

    it('should report no contradictions for an empty preference list', () => {
      const report = engine.detectContradictions([]);

      expect(report.hasContradictions).toBe(false);
      expect(report.contradictions).toEqual([]);
    });
  });

  // ── 3. analyzeEvidence() ─────────────────────────────────────────

  describe('analyzeEvidence', () => {
    it('should create a new inference from evidence when no existing inferences', () => {
      const evidence = [
        makeEvidence({
          id: 'ev_1',
          domain: 'email',
          type: 'user_action',
          data: { action: 'archive' },
        }),
      ];

      const result = engine.analyzeEvidence([], evidence);

      expect(result.length).toBeGreaterThanOrEqual(1);
      const inf = result.find((i) => i.domain === 'email');
      expect(inf).toBeDefined();
      expect(inf!.value).toBe('archive');
      expect(inf!.supportingEvidenceIds).toContain('ev_1');
      expect(inf!.contradictingEvidenceIds).toEqual([]);
      expect(inf!.reasoning).toContain('email');
    });

    it('should merge into existing inference when domain+key matches and value is consistent', () => {
      const existingInference = makeInference({
        id: 'inf_existing',
        domain: 'email',
        key: 'preferred_action_user_action',
        value: 'archive',
        confidence: ConfidenceLevel.LOW,
        supportingEvidenceIds: ['ev_old'],
        reasoning: 'Original reasoning.',
      });

      const newEvidence = [
        makeEvidence({
          id: 'ev_new',
          domain: 'email',
          type: 'user_action',
          data: { action: 'archive' },
        }),
      ];

      const result = engine.analyzeEvidence([existingInference], newEvidence);

      const updated = result.find((i) => i.id === 'inf_existing');
      expect(updated).toBeDefined();
      // Confidence should increase from LOW
      expect(updated!.confidence).toBe(ConfidenceLevel.MODERATE);
      // Should include both old and new evidence IDs
      expect(updated!.supportingEvidenceIds).toContain('ev_old');
      expect(updated!.supportingEvidenceIds).toContain('ev_new');
      expect(updated!.reasoning).toContain('Reinforced');
    });

    it('should add contradicting evidence when value is inconsistent', () => {
      const existingInference = makeInference({
        id: 'inf_existing',
        domain: 'email',
        key: 'preferred_action_user_action',
        value: 'archive',
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: ['ev_old'],
        contradictingEvidenceIds: [],
        reasoning: 'Original reasoning.',
      });

      const newEvidence = [
        makeEvidence({
          id: 'ev_contradict',
          domain: 'email',
          type: 'user_action',
          data: { action: 'delete' },
        }),
      ];

      const result = engine.analyzeEvidence([existingInference], newEvidence);

      const updated = result.find((i) => i.id === 'inf_existing');
      expect(updated).toBeDefined();
      // Confidence should decrease from HIGH
      expect(updated!.confidence).toBe(ConfidenceLevel.MODERATE);
      expect(updated!.contradictingEvidenceIds).toContain('ev_contradict');
      expect(updated!.reasoning).toContain('Contradicted');
    });

    it('should preserve existing inferences unrelated to new evidence', () => {
      const existingInference = makeInference({
        id: 'inf_calendar',
        domain: 'calendar',
        key: 'auto_accept',
        value: true,
      });

      const newEvidence = [
        makeEvidence({
          id: 'ev_email',
          domain: 'email',
          type: 'user_action',
          data: { action: 'archive' },
        }),
      ];

      const result = engine.analyzeEvidence([existingInference], newEvidence);

      const calendarInf = result.find((i) => i.id === 'inf_calendar');
      expect(calendarInf).toBeDefined();
      expect(calendarInf!.domain).toBe('calendar');
      expect(calendarInf!.value).toBe(true);
    });

    it('should handle evidence with preference_key and preference_value data', () => {
      const evidence = [
        makeEvidence({
          id: 'ev_pref',
          domain: 'email',
          type: 'user_action',
          data: { preference_key: 'reply_tone', preference_value: 'formal' },
        }),
      ];

      const result = engine.analyzeEvidence([], evidence);

      const inf = result.find((i) => i.key === 'reply_tone');
      expect(inf).toBeDefined();
      expect(inf!.value).toBe('formal');
    });

    it('should return empty array when both existing and evidence are empty', () => {
      const result = engine.analyzeEvidence([], []);
      expect(result).toEqual([]);
    });
  });

  // ── 4. updateInferencesFromFeedback() ────────────────────────────

  describe('updateInferencesFromFeedback', () => {
    it('should decrease confidence on reject feedback', () => {
      const inference = makeInference({
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: ['ev_1'],
      });
      const profile = makeProfile({ inferences: [inference] });
      const feedback: FeedbackEvent = {
        id: 'fb_1',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'reject',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
    });

    it('should increase confidence on approve feedback', () => {
      const inference = makeInference({
        confidence: ConfidenceLevel.LOW,
        supportingEvidenceIds: ['ev_1'],
      });
      const profile = makeProfile({ inferences: [inference] });
      const feedback: FeedbackEvent = {
        id: 'fb_1',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'approve',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
    });

    it('should create a new correction inference on correct feedback', () => {
      const profile = makeProfile({
        inferences: [
          makeInference({
            id: 'inf_original',
            confidence: ConfidenceLevel.MODERATE,
          }),
        ],
      });
      const feedback: FeedbackEvent = {
        id: 'fb_correct',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'correct',
        correctedAction: 'reply_tone',
        correctedValue: 'casual',
        reason: 'I prefer a casual tone',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      // Should include original + the new correction inference
      expect(result.length).toBe(2);

      const correction = result.find((i) => i.domain === 'correction');
      expect(correction).toBeDefined();
      expect(correction!.key).toBe('reply_tone');
      expect(correction!.value).toBe('casual');
      expect(correction!.confidence).toBe(ConfidenceLevel.CONFIRMED);
      expect(correction!.supportingEvidenceIds).toContain('fb_correct');
      expect(correction!.reasoning).toContain('I prefer a casual tone');
    });

    it('should not create correction inference when correctedAction is missing', () => {
      const profile = makeProfile({
        inferences: [makeInference()],
      });
      const feedback: FeedbackEvent = {
        id: 'fb_incomplete',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'correct',
        // No correctedAction or correctedValue
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      // Should only have the original inference (no new correction added)
      expect(result.length).toBe(1);
    });

    it('should be a no-op for ignore feedback', () => {
      const inference = makeInference({
        id: 'inf_1',
        confidence: ConfidenceLevel.MODERATE,
        supportingEvidenceIds: ['ev_1'],
      });
      const profile = makeProfile({ inferences: [inference] });
      const feedback: FeedbackEvent = {
        id: 'fb_ignore',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'ignore',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
    });

    it('should decrease confidence on undo feedback', () => {
      const inference = makeInference({
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: ['ev_1'],
      });
      const profile = makeProfile({ inferences: [inference] });
      const feedback: FeedbackEvent = {
        id: 'fb_undo',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'undo',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
    });

    it('should not decrease confidence below SPECULATIVE', () => {
      const inference = makeInference({
        confidence: ConfidenceLevel.SPECULATIVE,
        supportingEvidenceIds: ['ev_1'],
      });
      const profile = makeProfile({ inferences: [inference] });
      const feedback: FeedbackEvent = {
        id: 'fb_reject',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'reject',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      expect(result[0]!.confidence).toBe(ConfidenceLevel.SPECULATIVE);
    });

    it('should not increase confidence above CONFIRMED', () => {
      const inference = makeInference({
        confidence: ConfidenceLevel.CONFIRMED,
        supportingEvidenceIds: ['ev_1'],
      });
      const profile = makeProfile({ inferences: [inference] });
      const feedback: FeedbackEvent = {
        id: 'fb_approve',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'approve',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      expect(result[0]!.confidence).toBe(ConfidenceLevel.CONFIRMED);
    });

    it('should leave inferences without supporting evidence unaffected by reject', () => {
      const withEvidence = makeInference({
        id: 'inf_with',
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: ['ev_1'],
      });
      const withoutEvidence = makeInference({
        id: 'inf_without',
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: [],
      });
      const profile = makeProfile({ inferences: [withEvidence, withoutEvidence] });
      const feedback: FeedbackEvent = {
        id: 'fb_reject',
        userId: 'user_test',
        decisionId: 'dec_1',
        feedbackType: 'reject',
        timestamp: new Date(),
      };

      const result = engine.updateInferencesFromFeedback(profile, feedback);

      const affected = result.find((i) => i.id === 'inf_with');
      const unaffected = result.find((i) => i.id === 'inf_without');
      expect(affected!.confidence).toBe(ConfidenceLevel.MODERATE);
      expect(unaffected!.confidence).toBe(ConfidenceLevel.HIGH);
    });
  });

  // ── 5. mergeInference() (tested via analyzeEvidence) ─────────────

  describe('mergeInference (via analyzeEvidence)', () => {
    it('should increase confidence when merging consistent value', () => {
      const existing = makeInference({
        id: 'inf_1',
        domain: 'email',
        key: 'preferred_action_user_action',
        value: 'archive',
        confidence: ConfidenceLevel.LOW,
        supportingEvidenceIds: ['ev_old'],
      });

      const evidence = [
        makeEvidence({
          id: 'ev_new',
          domain: 'email',
          type: 'user_action',
          data: { action: 'archive' },
        }),
      ];

      const result = engine.analyzeEvidence([existing], evidence);
      const merged = result.find((i) => i.id === 'inf_1');

      expect(merged).toBeDefined();
      expect(merged!.confidence).toBe(ConfidenceLevel.MODERATE);
      expect(merged!.supportingEvidenceIds).toContain('ev_old');
      expect(merged!.supportingEvidenceIds).toContain('ev_new');
    });

    it('should decrease confidence when merging contradicting value', () => {
      const existing = makeInference({
        id: 'inf_1',
        domain: 'email',
        key: 'preferred_action_user_action',
        value: 'archive',
        confidence: ConfidenceLevel.HIGH,
        supportingEvidenceIds: ['ev_old'],
        contradictingEvidenceIds: [],
      });

      const evidence = [
        makeEvidence({
          id: 'ev_conflict',
          domain: 'email',
          type: 'user_action',
          data: { action: 'delete' },
        }),
      ];

      const result = engine.analyzeEvidence([existing], evidence);
      const merged = result.find((i) => i.id === 'inf_1');

      expect(merged).toBeDefined();
      expect(merged!.confidence).toBe(ConfidenceLevel.MODERATE);
      expect(merged!.contradictingEvidenceIds).toContain('ev_conflict');
      // Original supporting evidence should remain
      expect(merged!.supportingEvidenceIds).toContain('ev_old');
    });

    it('should append reasoning about reinforcement for consistent merge', () => {
      const existing = makeInference({
        id: 'inf_1',
        domain: 'email',
        key: 'preferred_action_user_action',
        value: 'archive',
        reasoning: 'Base reasoning.',
        supportingEvidenceIds: ['ev_old'],
      });

      const evidence = [
        makeEvidence({
          id: 'ev_2',
          domain: 'email',
          type: 'user_action',
          data: { action: 'archive' },
        }),
      ];

      const result = engine.analyzeEvidence([existing], evidence);
      const merged = result.find((i) => i.id === 'inf_1');

      expect(merged!.reasoning).toContain('Base reasoning.');
      expect(merged!.reasoning).toContain('Reinforced by 1 additional evidence item(s)');
    });

    it('should append reasoning about contradiction for inconsistent merge', () => {
      const existing = makeInference({
        id: 'inf_1',
        domain: 'email',
        key: 'preferred_action_user_action',
        value: 'archive',
        reasoning: 'Base reasoning.',
        supportingEvidenceIds: ['ev_old'],
      });

      const evidence = [
        makeEvidence({
          id: 'ev_2',
          domain: 'email',
          type: 'user_action',
          data: { action: 'delete' },
        }),
      ];

      const result = engine.analyzeEvidence([existing], evidence);
      const merged = result.find((i) => i.id === 'inf_1');

      expect(merged!.reasoning).toContain('Base reasoning.');
      expect(merged!.reasoning).toContain('Contradicted by 1 evidence item(s)');
    });
  });

  // ── 6. valuesAreConsistent() (tested via detectContradictions + analyzeEvidence) ──

  describe('valuesAreConsistent (via detectContradictions)', () => {
    it('should treat identical primitive values as consistent', () => {
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'k', value: 'same' }),
        makePreference({ id: 'p2', domain: 'email', key: 'k', value: 'same' }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(false);
    });

    it('should treat deep-equal objects as consistent', () => {
      const objA = { tone: 'formal', length: 'short' };
      const objB = { tone: 'formal', length: 'short' };

      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'style', value: objA }),
        makePreference({ id: 'p2', domain: 'email', key: 'style', value: objB }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(false);
    });

    it('should treat numbers within 20% as consistent', () => {
      // 100 and 110: diff = 10, magnitude = max(100, 110, 1) = 110, 10/110 = 0.0909 < 0.2
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'max_length', value: 100 }),
        makePreference({ id: 'p2', domain: 'email', key: 'max_length', value: 110 }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(false);
    });

    it('should treat numbers beyond 20% as inconsistent', () => {
      // 100 and 150: diff = 50, magnitude = max(100, 150, 1) = 150, 50/150 = 0.333 >= 0.2
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'max_length', value: 100 }),
        makePreference({ id: 'p2', domain: 'email', key: 'max_length', value: 150 }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(true);
    });

    it('should treat different string values as inconsistent', () => {
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'tone', value: 'formal' }),
        makePreference({ id: 'p2', domain: 'email', key: 'tone', value: 'casual' }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(true);
      expect(report.contradictions).toHaveLength(1);
    });

    it('should treat different object shapes as inconsistent', () => {
      const objA = { tone: 'formal' };
      const objB = { tone: 'casual' };

      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'style', value: objA }),
        makePreference({ id: 'p2', domain: 'email', key: 'style', value: objB }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(true);
    });

    it('should treat boolean true vs false as inconsistent', () => {
      const preferences = [
        makePreference({ id: 'p1', domain: 'email', key: 'auto_archive', value: true }),
        makePreference({ id: 'p2', domain: 'email', key: 'auto_archive', value: false }),
      ];

      const report = engine.detectContradictions(preferences);
      expect(report.hasContradictions).toBe(true);
    });
  });

  // ── analyzeWithPatterns integration smoke test ───────────────────

  describe('analyzeWithPatterns', () => {
    it('should return inferences, patterns, traits, and temporalProfile', () => {
      const evidence = [
        makeEvidence({
          id: 'ev_1',
          domain: 'email',
          type: 'user_action',
          data: { action: 'archive' },
        }),
      ];

      const result = engine.analyzeWithPatterns([], evidence, []);

      expect(result).toHaveProperty('inferences');
      expect(result).toHaveProperty('patterns');
      expect(result).toHaveProperty('traits');
      expect(result).toHaveProperty('temporalProfile');
      expect(Array.isArray(result.inferences)).toBe(true);
      expect(result.inferences.length).toBeGreaterThanOrEqual(1);
    });
  });
});
