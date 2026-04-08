import { describe, it, expect, vi } from 'vitest';
import { FallbackSituationStrategy, FallbackCandidateGenerator } from '../strategies/fallback-strategy.js';
import type { SituationStrategy } from '../strategies/situation-strategy.js';
import type { CandidateGenerator } from '../strategies/candidate-strategy.js';
import type {
  DecisionObject,
  DecisionContext,
  CandidateAction,
  TwinProfile,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';

// ── Test helpers ─────────────────────────────────────────────────────

function makeDecisionObject(overrides: Partial<DecisionObject> = {}): DecisionObject {
  return {
    id: 'decision-1',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'medium',
    summary: 'New email from boss',
    rawData: { from: 'boss@example.com' },
    interpretedAt: new Date(),
    ...overrides,
  };
}

function makeTwinProfile(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    id: 'twin-1',
    userId: 'user-1',
    version: 1,
    preferences: [],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDecisionContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    userId: 'user-1',
    decision: makeDecisionObject(),
    trustTier: TrustTier.LOW_AUTONOMY,
    relevantPreferences: [],
    timestamp: new Date(),
    ...overrides,
  };
}

function makeCandidateAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'archive_email',
    description: 'Archive the email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Matches archival pattern',
    ...overrides,
  };
}

// ── FallbackSituationStrategy ────────────────────────────────────────

describe('FallbackSituationStrategy', () => {
  it('returns the result from the primary strategy when it succeeds', async () => {
    const expectedDecision = makeDecisionObject({ summary: 'Primary interpreted this' });

    const primary: SituationStrategy = {
      interpret: vi.fn().mockResolvedValue(expectedDecision),
    };
    const fallback: SituationStrategy = {
      interpret: vi.fn().mockResolvedValue(makeDecisionObject({ summary: 'Fallback' })),
    };

    const strategy = new FallbackSituationStrategy(primary, fallback);
    const result = await strategy.interpret({ type: 'email' });

    expect(result).toBe(expectedDecision);
    expect(result.summary).toBe('Primary interpreted this');
    expect(primary.interpret).toHaveBeenCalledOnce();
    expect(primary.interpret).toHaveBeenCalledWith({ type: 'email' });
    expect(fallback.interpret).not.toHaveBeenCalled();
  });

  it('falls back to the secondary strategy when primary throws', async () => {
    const fallbackDecision = makeDecisionObject({ summary: 'Fallback interpreted this' });

    const primary: SituationStrategy = {
      interpret: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    };
    const fallback: SituationStrategy = {
      interpret: vi.fn().mockResolvedValue(fallbackDecision),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strategy = new FallbackSituationStrategy(primary, fallback);
    const result = await strategy.interpret({ type: 'email' });

    expect(result).toBe(fallbackDecision);
    expect(result.summary).toBe('Fallback interpreted this');
    expect(primary.interpret).toHaveBeenCalledOnce();
    expect(fallback.interpret).toHaveBeenCalledOnce();
    expect(fallback.interpret).toHaveBeenCalledWith({ type: 'email' });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('LLM timeout');

    warnSpy.mockRestore();
  });

  it('propagates the error when both primary and fallback throw', async () => {
    const primary: SituationStrategy = {
      interpret: vi.fn().mockRejectedValue(new Error('Primary failed')),
    };
    const fallback: SituationStrategy = {
      interpret: vi.fn().mockRejectedValue(new Error('Fallback also failed')),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strategy = new FallbackSituationStrategy(primary, fallback);

    await expect(strategy.interpret({ type: 'email' })).rejects.toThrow('Fallback also failed');
    expect(primary.interpret).toHaveBeenCalledOnce();
    expect(fallback.interpret).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('handles non-Error throwables from the primary', async () => {
    const fallbackDecision = makeDecisionObject({ summary: 'Recovered' });

    const primary: SituationStrategy = {
      interpret: vi.fn().mockRejectedValue('string error'),
    };
    const fallback: SituationStrategy = {
      interpret: vi.fn().mockResolvedValue(fallbackDecision),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strategy = new FallbackSituationStrategy(primary, fallback);
    const result = await strategy.interpret({ type: 'email' });

    expect(result).toBe(fallbackDecision);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('string error');

    warnSpy.mockRestore();
  });
});

// ── FallbackCandidateGenerator ───────────────────────────────────────

describe('FallbackCandidateGenerator', () => {
  it('returns candidates from the primary generator when it succeeds', async () => {
    const expectedCandidates = [
      makeCandidateAction({ id: 'primary-1' }),
      makeCandidateAction({ id: 'primary-2' }),
    ];

    const primary: CandidateGenerator = {
      generate: vi.fn().mockResolvedValue(expectedCandidates),
    };
    const fallback: CandidateGenerator = {
      generate: vi.fn().mockResolvedValue([makeCandidateAction({ id: 'fallback-1' })]),
    };

    const generator = new FallbackCandidateGenerator(primary, fallback);
    const decision = makeDecisionObject();
    const profile = makeTwinProfile();
    const context = makeDecisionContext();

    const result = await generator.generate(decision, profile, context);

    expect(result).toBe(expectedCandidates);
    expect(result).toHaveLength(2);
    expect(primary.generate).toHaveBeenCalledOnce();
    expect(primary.generate).toHaveBeenCalledWith(decision, profile, context);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('falls back to secondary generator when primary throws', async () => {
    const fallbackCandidates = [makeCandidateAction({ id: 'fallback-1', description: 'Fallback action' })];

    const primary: CandidateGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('LLM rate limit')),
    };
    const fallback: CandidateGenerator = {
      generate: vi.fn().mockResolvedValue(fallbackCandidates),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const generator = new FallbackCandidateGenerator(primary, fallback);
    const decision = makeDecisionObject();
    const profile = makeTwinProfile();
    const context = makeDecisionContext();

    const result = await generator.generate(decision, profile, context);

    expect(result).toBe(fallbackCandidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe('Fallback action');
    expect(primary.generate).toHaveBeenCalledOnce();
    expect(fallback.generate).toHaveBeenCalledOnce();
    expect(fallback.generate).toHaveBeenCalledWith(decision, profile, context);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('LLM rate limit');

    warnSpy.mockRestore();
  });

  it('propagates the error when both primary and fallback throw', async () => {
    const primary: CandidateGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('Primary down')),
    };
    const fallback: CandidateGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('Fallback down too')),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const generator = new FallbackCandidateGenerator(primary, fallback);

    await expect(
      generator.generate(makeDecisionObject(), makeTwinProfile(), makeDecisionContext()),
    ).rejects.toThrow('Fallback down too');

    expect(primary.generate).toHaveBeenCalledOnce();
    expect(fallback.generate).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('handles non-Error throwables from the primary', async () => {
    const fallbackCandidates = [makeCandidateAction({ id: 'recovered' })];

    const primary: CandidateGenerator = {
      generate: vi.fn().mockRejectedValue(42),
    };
    const fallback: CandidateGenerator = {
      generate: vi.fn().mockResolvedValue(fallbackCandidates),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const generator = new FallbackCandidateGenerator(primary, fallback);
    const result = await generator.generate(
      makeDecisionObject(),
      makeTwinProfile(),
      makeDecisionContext(),
    );

    expect(result).toBe(fallbackCandidates);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('42');

    warnSpy.mockRestore();
  });

  it('returns empty array from fallback when primary throws and fallback yields nothing', async () => {
    const primary: CandidateGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('Failed')),
    };
    const fallback: CandidateGenerator = {
      generate: vi.fn().mockResolvedValue([]),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const generator = new FallbackCandidateGenerator(primary, fallback);
    const result = await generator.generate(
      makeDecisionObject(),
      makeTwinProfile(),
      makeDecisionContext(),
    );

    expect(result).toEqual([]);
    expect(result).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
