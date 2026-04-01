import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TwinService } from '../twin-service.js';
import type {
  TwinProfile,
  Inference,
  FeedbackEvent,
  UndoReasoning,
} from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Mock TwinRepository ──────────────────────────────────────────

function createMockRepository() {
  let storedProfile: TwinProfile | null = null;
  const feedbackStore: FeedbackEvent[] = [];

  return {
    getProfile: vi.fn(async (_userId: string) => storedProfile),

    createProfile: vi.fn(async (profile: TwinProfile) => {
      storedProfile = { ...profile };
      return storedProfile;
    }),

    updateProfile: vi.fn(async (profile: TwinProfile) => {
      storedProfile = { ...profile };
      return storedProfile;
    }),

    upsertPreference: vi.fn(async () => {}),
    upsertInference: vi.fn(async () => {}),

    addEvidence: vi.fn(async () => {}),
    getEvidence: vi.fn(async () => []),
    getEvidenceByIds: vi.fn(async () => []),

    addFeedback: vi.fn(async (feedback: FeedbackEvent) => {
      feedbackStore.push(feedback);
      return feedback;
    }),

    getFeedback: vi.fn(async () => feedbackStore),

    getPreferences: vi.fn(async () =>
      storedProfile ? storedProfile.preferences : [],
    ),

    getPreferencesByDomain: vi.fn(async (_userId: string, _domain: string) =>
      storedProfile
        ? storedProfile.preferences.filter((p) => p.domain === _domain)
        : [],
    ),

    getInferences: vi.fn(async () =>
      storedProfile ? storedProfile.inferences : [],
    ),

    // Test helpers
    _setProfile: (profile: TwinProfile | null) => {
      storedProfile = profile;
    },
    _getFeedbackStore: () => feedbackStore,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

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

function makeInference(overrides: Partial<Inference> = {}): Inference {
  return {
    id: `inf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    domain: 'email',
    key: 'auto_archive',
    value: true,
    confidence: ConfidenceLevel.HIGH,
    supportingEvidenceIds: ['ev_1'],
    contradictingEvidenceIds: [],
    reasoning: 'Inferred from evidence.',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeUndoFeedback(
  undoReasoning: UndoReasoning,
  overrides: Partial<FeedbackEvent> = {},
): FeedbackEvent {
  return {
    id: `fb_${Date.now()}`,
    userId: 'user_test',
    decisionId: 'dec_1',
    feedbackType: 'undo',
    undoReasoning,
    timestamp: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Undo feedback in TwinService', () => {
  let repo: ReturnType<typeof createMockRepository>;
  let service: TwinService;

  beforeEach(() => {
    repo = createMockRepository();
    service = new TwinService(repo as never);
  });

  // ── 1. processFeedback handles undo feedbackType ───────────────

  it('should handle undo feedbackType and reduce inference confidence', async () => {
    const inference = makeInference({
      confidence: ConfidenceLevel.HIGH,
    });
    repo._setProfile(makeProfile({ inferences: [inference] }));

    const feedback = makeUndoFeedback({
      whatWentWrong: 'Archived an important email',
      severity: 'moderate',
    });

    const result = await service.processFeedback('user_test', feedback);

    // Undo applies the correction twice (2x weight).
    // Each pass through updateInferencesFromFeedback decreases confidence by one level.
    // HIGH -> MODERATE (1st pass) -> LOW (2nd pass)
    expect(result.inferences.length).toBe(1);
    expect(result.inferences[0]!.confidence).toBe(ConfidenceLevel.LOW);
  });

  it('should persist the feedback event to the repository', async () => {
    repo._setProfile(makeProfile({ inferences: [makeInference()] }));

    const feedback = makeUndoFeedback({
      whatWentWrong: 'Sent wrong reply',
      severity: 'minor',
    });

    await service.processFeedback('user_test', feedback);

    expect(repo.addFeedback).toHaveBeenCalledWith(feedback);
  });

  it('should increment the profile version after undo feedback', async () => {
    repo._setProfile(makeProfile({ version: 3, inferences: [makeInference()] }));

    const feedback = makeUndoFeedback({
      whatWentWrong: 'Wrong calendar event',
      severity: 'minor',
    });

    const result = await service.processFeedback('user_test', feedback);

    expect(result.version).toBe(4);
  });

  // ── 2. Severe severity applies stronger correction ─────────────

  it('should apply extra confidence reduction for severe undo reasoning', async () => {
    const inference = makeInference({
      confidence: ConfidenceLevel.CONFIRMED,
    });
    repo._setProfile(makeProfile({ inferences: [inference] }));

    const feedback = makeUndoFeedback({
      whatWentWrong: 'Deleted a critical document',
      severity: 'severe',
    });

    const result = await service.processFeedback('user_test', feedback);

    // CONFIRMED -> HIGH (1st pass) -> MODERATE (2nd pass) -> LOW (severe penalty)
    expect(result.inferences[0]!.confidence).toBe(ConfidenceLevel.LOW);
  });

  it('severe undo should produce lower confidence than moderate undo for the same starting level', async () => {
    // Moderate undo path
    const moderateInference = makeInference({
      id: 'inf_moderate',
      confidence: ConfidenceLevel.CONFIRMED,
    });
    repo._setProfile(makeProfile({ inferences: [moderateInference] }));

    const moderateResult = await service.processFeedback(
      'user_test',
      makeUndoFeedback({
        whatWentWrong: 'Small mistake',
        severity: 'moderate',
      }),
    );
    const moderateConfidence = moderateResult.inferences[0]!.confidence;

    // Severe undo path
    const severeInference = makeInference({
      id: 'inf_severe',
      confidence: ConfidenceLevel.CONFIRMED,
    });
    repo._setProfile(makeProfile({ inferences: [severeInference] }));

    const severeResult = await service.processFeedback(
      'user_test',
      makeUndoFeedback({
        whatWentWrong: 'Catastrophic mistake',
        severity: 'severe',
      }),
    );
    const severeConfidence = severeResult.inferences[0]!.confidence;

    // Severe should end up at a lower confidence than moderate
    const levels = [
      ConfidenceLevel.SPECULATIVE,
      ConfidenceLevel.LOW,
      ConfidenceLevel.MODERATE,
      ConfidenceLevel.HIGH,
      ConfidenceLevel.CONFIRMED,
    ];
    expect(levels.indexOf(severeConfidence)).toBeLessThan(
      levels.indexOf(moderateConfidence),
    );
  });

  it('severe undo should not reduce confidence below SPECULATIVE', async () => {
    const inference = makeInference({
      confidence: ConfidenceLevel.LOW,
    });
    repo._setProfile(makeProfile({ inferences: [inference] }));

    const feedback = makeUndoFeedback({
      whatWentWrong: 'Total failure',
      severity: 'severe',
    });

    const result = await service.processFeedback('user_test', feedback);

    // LOW -> SPECULATIVE (1st pass) -> SPECULATIVE (2nd pass, floored) -> SPECULATIVE (severe penalty, floored)
    expect(result.inferences[0]!.confidence).toBe(ConfidenceLevel.SPECULATIVE);
  });

  // ── 3. Undo reasoning is preserved in the feedback record ──────

  it('should preserve undoReasoning in the stored feedback event', async () => {
    repo._setProfile(makeProfile({ inferences: [makeInference()] }));

    const undoReasoning: UndoReasoning = {
      whatWentWrong: 'Replied with wrong tone',
      whichStep: 'tone_selection',
      preferredAlternative: 'formal',
      severity: 'moderate',
    };

    const feedback = makeUndoFeedback(undoReasoning);

    await service.processFeedback('user_test', feedback);

    const storedFeedback = repo._getFeedbackStore();
    expect(storedFeedback.length).toBe(1);
    expect(storedFeedback[0]!.undoReasoning).toEqual(undoReasoning);
    expect(storedFeedback[0]!.undoReasoning!.whatWentWrong).toBe('Replied with wrong tone');
    expect(storedFeedback[0]!.undoReasoning!.whichStep).toBe('tone_selection');
    expect(storedFeedback[0]!.undoReasoning!.preferredAlternative).toBe('formal');
    expect(storedFeedback[0]!.undoReasoning!.severity).toBe('moderate');
  });

  it('should preserve undoReasoning with only required fields', async () => {
    repo._setProfile(makeProfile({ inferences: [makeInference()] }));

    const undoReasoning: UndoReasoning = {
      whatWentWrong: 'Sent email to wrong person',
      severity: 'severe',
    };

    const feedback = makeUndoFeedback(undoReasoning);

    await service.processFeedback('user_test', feedback);

    const storedFeedback = repo._getFeedbackStore();
    expect(storedFeedback[0]!.undoReasoning).toEqual(undoReasoning);
    expect(storedFeedback[0]!.undoReasoning!.whichStep).toBeUndefined();
    expect(storedFeedback[0]!.undoReasoning!.preferredAlternative).toBeUndefined();
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it('should still work when undo feedback has no undoReasoning (single pass only)', async () => {
    const inference = makeInference({
      confidence: ConfidenceLevel.HIGH,
    });
    repo._setProfile(makeProfile({ inferences: [inference] }));

    const feedback: FeedbackEvent = {
      id: 'fb_no_reasoning',
      userId: 'user_test',
      decisionId: 'dec_1',
      feedbackType: 'undo',
      // No undoReasoning provided
      timestamp: new Date(),
    };

    const result = await service.processFeedback('user_test', feedback);

    // Without undoReasoning, only a single pass runs: HIGH -> MODERATE
    expect(result.inferences[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
  });

  it('should leave inferences without supporting evidence unaffected', async () => {
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
    repo._setProfile(makeProfile({ inferences: [withEvidence, withoutEvidence] }));

    const feedback = makeUndoFeedback({
      whatWentWrong: 'Wrong action',
      severity: 'moderate',
    });

    const result = await service.processFeedback('user_test', feedback);

    const affectedInference = result.inferences.find((i) => i.id === 'inf_with');
    const unaffectedInference = result.inferences.find((i) => i.id === 'inf_without');

    // Inference with evidence should have reduced confidence
    expect(affectedInference!.confidence).toBe(ConfidenceLevel.LOW);
    // Inference without evidence should remain unchanged
    expect(unaffectedInference!.confidence).toBe(ConfidenceLevel.HIGH);
  });
});
