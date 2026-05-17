import { describe, it, expect } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import {
  DEFAULT_EVAL_THRESHOLDS,
  evalResultConfidence,
  runEvalBench,
  scorePair,
  type EvalPair,
  type UserReplyLengthStats,
} from '../eval-bench.js';

const STATS_50_15: UserReplyLengthStats = {
  meanChars: 50,
  stdDevChars: 15,
};

function pair(args: Partial<EvalPair> & { generatedDraft: string; actualReply: string }): EvalPair {
  return {
    inboundSubject: args.inboundSubject ?? 'Re: question',
    inboundBody: args.inboundBody ?? 'When are you free?',
    inboundFrom: args.inboundFrom ?? 'colleague@example.com',
    actualReply: args.actualReply,
    generatedDraft: args.generatedDraft,
  };
}

describe('scorePair — length metric', () => {
  it('lengthPassed when draft is within 2σ of user mean', () => {
    const result = scorePair(
      pair({
        actualReply: 'Sure, that works for me. Talk soon.',
        generatedDraft: 'Sure, that works for me. Talk soon.', // ~35 chars (within 2σ of 50)
      }),
      STATS_50_15,
    );
    expect(result.lengthPassed).toBe(true);
    expect(result.lengthZScore).toBeLessThan(2);
  });

  it('lengthPassed=false when draft is way outside the user distribution', () => {
    const longDraft = 'x'.repeat(200);
    const result = scorePair(
      pair({
        actualReply: 'Short reply',
        generatedDraft: longDraft,
      }),
      STATS_50_15,
    );
    expect(result.lengthPassed).toBe(false);
    expect(result.lengthZScore).toBeGreaterThan(2);
  });

  it('handles stddev=0 — exact-match required', () => {
    const result = scorePair(
      pair({
        actualReply: 'foo',
        generatedDraft: 'x'.repeat(50),
      }),
      { meanChars: 50, stdDevChars: 0 },
    );
    expect(result.lengthZScore).toBe(0);
    expect(result.lengthPassed).toBe(true);

    const offResult = scorePair(
      pair({
        actualReply: 'foo',
        generatedDraft: 'x'.repeat(60),
      }),
      { meanChars: 50, stdDevChars: 0 },
    );
    expect(offResult.lengthZScore).toBe(Infinity);
    expect(offResult.lengthPassed).toBe(false);
  });
});

describe('scorePair — voice metric (bigram jaccard)', () => {
  it('voicePassed when draft uses bigrams that overlap with the actual reply', () => {
    const r = scorePair(
      pair({
        actualReply: 'Thanks for the heads up, let me check my calendar and get back to you.',
        // Draft repeats some of the actual reply's bigrams — heads/up,
        // check/my, calendar/and, get/back, back/to.
        generatedDraft:
          'Thanks for the heads up. Let me check my calendar and get back to you soon.',
      }),
      STATS_50_15,
    );
    expect(r.voicePassed).toBe(true);
    expect(r.voiceJaccard).toBeGreaterThan(DEFAULT_EVAL_THRESHOLDS.voiceJaccardMin);
  });

  it('voicePassed=false when draft is in a completely different voice', () => {
    const r = scorePair(
      pair({
        actualReply: "yo no worries, ttyl",
        generatedDraft:
          'Dear sir, I am pleased to confirm the receipt of your communication and shall respond imminently.',
      }),
      STATS_50_15,
    );
    expect(r.voicePassed).toBe(false);
  });

  it('jaccard is 1 when draft equals actual reply (degenerate)', () => {
    const text = 'Thanks Jane. Tuesday works for me.';
    const r = scorePair(
      pair({ actualReply: text, generatedDraft: text }),
      STATS_50_15,
    );
    expect(r.voiceJaccard).toBe(1);
    expect(r.topicalJaccard).toBe(1);
  });
});

describe('scorePair — topical metric (content-word jaccard)', () => {
  it('topicalPassed when content words overlap', () => {
    const r = scorePair(
      pair({
        actualReply: 'Tuesday afternoon works great for the design review meeting.',
        generatedDraft:
          'Tuesday afternoon at 2pm works for the design review meeting.',
      }),
      STATS_50_15,
    );
    expect(r.topicalPassed).toBe(true);
  });

  it('topicalPassed=false when topics diverge', () => {
    const r = scorePair(
      pair({
        actualReply: 'Tuesday afternoon works for the design review.',
        generatedDraft: 'Could not attend. Stuck in airport with flight delays.',
      }),
      STATS_50_15,
    );
    expect(r.topicalPassed).toBe(false);
  });

  it('stop words do not inflate topical score', () => {
    // Both replies share "the", "a", "is" — but if topical did NOT
    // strip stop words those would dominate. Make sure they don't:
    // a draft with stop-word-only overlap should score 0.
    const r = scorePair(
      pair({
        actualReply: 'The launch is a go.',
        generatedDraft: 'The cake is a lie.',
      }),
      STATS_50_15,
    );
    // 'launch' / 'cake' / 'lie' don't overlap.
    expect(r.topicalJaccard).toBe(0);
  });
});

describe('runEvalBench — aggregate', () => {
  it('refuses an empty corpus', () => {
    const r = runEvalBench([], STATS_50_15);
    expect(r.passed).toBe(false);
    expect(r.corpusSize).toBe(0);
    expect(r.notes).toMatch(/Empty corpus/i);
  });

  it('passes when all pairs score above all thresholds', () => {
    // Three pairs where draft ≈ actual reply (all metrics high).
    const sameTextPairs: EvalPair[] = [
      pair({
        actualReply: 'Sure, that works. See you Tuesday at 2.',
        generatedDraft: 'Sure, that works. See you Tuesday at 2.',
      }),
      pair({
        actualReply: 'Sounds good. I will follow up by Friday with the doc.',
        generatedDraft: 'Sounds good. I will follow up by Friday with the doc.',
      }),
      pair({
        actualReply: 'Thanks for the update. Let me know if anything changes.',
        generatedDraft: 'Thanks for the update. Let me know if anything changes.',
      }),
    ];
    const r = runEvalBench(sameTextPairs, STATS_50_15);
    expect(r.passed).toBe(true);
    expect(r.overallPassRate).toBe(1);
  });

  it('fails when most pairs miss a metric (overall pass-rate below threshold)', () => {
    // Drafts have no overlap with replies → voice + topical fail.
    const mismatchPairs: EvalPair[] = Array(5)
      .fill(0)
      .map((_, i) =>
        pair({
          actualReply: `Reply ${i} about meeting tuesday`,
          generatedDraft: `Garbage ${i} unrelated text xyzzy`,
        }),
      );
    const r = runEvalBench(mismatchPairs, STATS_50_15);
    expect(r.passed).toBe(false);
    expect(r.notes).toMatch(/voice|topical/);
  });

  it('overall thresholds default to 0.8 pass rate per metric', () => {
    expect(DEFAULT_EVAL_THRESHOLDS.overallPassRateMin).toBe(0.8);
    expect(DEFAULT_EVAL_THRESHOLDS.lengthSigmaMax).toBe(2);
  });

  it('returns per-pair scores for dashboard rendering', () => {
    const pairs: EvalPair[] = [
      pair({ actualReply: 'a b c', generatedDraft: 'a b c' }),
      pair({ actualReply: 'a b c', generatedDraft: 'x y z' }),
    ];
    const r = runEvalBench(pairs, STATS_50_15);
    expect(r.pairs).toHaveLength(2);
    expect(r.pairs[0]!.voiceJaccard).toBeGreaterThan(r.pairs[1]!.voiceJaccard);
  });
});

describe('evalResultConfidence', () => {
  it('returns HIGH when the run passed', () => {
    const passed = {
      corpusSize: 5,
      voicePassRate: 1,
      topicalPassRate: 1,
      lengthPassRate: 1,
      overallPassRate: 1,
      passed: true,
      thresholds: DEFAULT_EVAL_THRESHOLDS,
      notes: 'ok',
      pairs: [],
    };
    expect(evalResultConfidence(passed)).toBe(ConfidenceLevel.HIGH);
  });

  it('returns MODERATE when within 10pp of overall threshold', () => {
    const near = {
      corpusSize: 10,
      voicePassRate: 0.7,
      topicalPassRate: 0.7,
      lengthPassRate: 0.75,
      overallPassRate: 0.75, // 5pp below 0.8 — moderate
      passed: false,
      thresholds: DEFAULT_EVAL_THRESHOLDS,
      notes: 'near miss',
      pairs: [],
    };
    expect(evalResultConfidence(near)).toBe(ConfidenceLevel.MODERATE);
  });

  it('returns LOW when far from threshold', () => {
    const far = {
      corpusSize: 10,
      voicePassRate: 0.2,
      topicalPassRate: 0.3,
      lengthPassRate: 0.4,
      overallPassRate: 0.3,
      passed: false,
      thresholds: DEFAULT_EVAL_THRESHOLDS,
      notes: 'fail',
      pairs: [],
    };
    expect(evalResultConfidence(far)).toBe(ConfidenceLevel.LOW);
  });
});
