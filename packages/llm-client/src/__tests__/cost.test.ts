import { describe, it, expect } from 'vitest';
import { estimateLlmCostCents, isZeroCostProvider } from '../cost.js';

describe('estimateLlmCostCents', () => {
  // #187 AC#8: this is the load-bearing invariant — when the user is in
  // Smart mode (embedded provider top of chain), every estimated cost is
  // zero. The future spend-recording call site relies on this returning
  // 0 without special-casing.
  it('returns 0 for embedded provider regardless of token counts', () => {
    expect(estimateLlmCostCents('embedded', 0, 0)).toBe(0);
    expect(estimateLlmCostCents('embedded', 1_000_000, 1_000_000)).toBe(0);
    // Largest token count the safe-integer guard accepts. The guard
    // throws above 2e12, which is far beyond any real prompt; the
    // embedded path still returns 0 at that boundary because the rate
    // table entry is { 0, 0 } regardless of token count.
    expect(estimateLlmCostCents('embedded', 2_000_000_000_000, 0)).toBe(0);
  });

  it('returns 0 for ollama provider regardless of token counts', () => {
    expect(estimateLlmCostCents('ollama', 0, 0)).toBe(0);
    expect(estimateLlmCostCents('ollama', 500_000, 500_000)).toBe(0);
  });

  it('returns 0 for any provider with zero token counts', () => {
    expect(estimateLlmCostCents('anthropic')).toBe(0);
    expect(estimateLlmCostCents('openai')).toBe(0);
    expect(estimateLlmCostCents('google')).toBe(0);
  });

  it('estimates anthropic cost in integer cents with safe rounding up', () => {
    // 1M input + 1M output at 800/4000 deci-cents per million →
    // 4800 deci-cents → 480 cents = $4.80. Locks the corrected
    // unit conversion (1 cent = 10 deci-cents).
    expect(estimateLlmCostCents('anthropic', 1_000_000, 1_000_000)).toBe(480);
  });

  it('estimates openai cost in integer cents', () => {
    // 1M output at 600 deci-cents per million → 600 deci-cents →
    // 60 cents = $0.60. Matches GPT-4o-mini list price exactly.
    expect(estimateLlmCostCents('openai', 0, 1_000_000)).toBe(60);
  });

  it('estimates google cost in integer cents', () => {
    // 1M output at 300 deci-cents per million → 300 deci-cents →
    // 30 cents = $0.30. Matches Gemini 1.5 Flash list price exactly.
    expect(estimateLlmCostCents('google', 0, 1_000_000)).toBe(30);
  });

  it('rounds up so the cap-enforcement direction is always safe', () => {
    // Anthropic at small token counts (10k input, 10k output) →
    // (800*10_000 + 4000*10_000) / 1_000_000 = 48 deci-cents →
    // ceil(48/10) = 5 cents. Exact value would be 4.8¢; rounding up
    // means the cap sees 5¢ instead of dropping the fractional cent.
    expect(estimateLlmCostCents('anthropic', 10_000, 10_000)).toBe(5);
  });

  it('rounds up tiny usage to at least 1 cent for non-zero rates', () => {
    // Regression coverage for the original under-estimation bug
    // (which had 100×-too-small rates and reported 1¢ for 10k+10k
    // Anthropic — almost zero usage). With corrected rates, a single
    // token of OpenAI output still rounds up from
    // (150 + 600) / 1M ≈ 0.0006 deci-cents to 1¢. Same direction:
    // the cap can never under-bill.
    expect(estimateLlmCostCents('openai', 1, 1)).toBe(1);
  });

  it('is a pure function — same input twice yields the same output', () => {
    const a = estimateLlmCostCents('anthropic', 500_000, 250_000);
    const b = estimateLlmCostCents('anthropic', 500_000, 250_000);
    expect(a).toBe(b);
  });

  // #253 round-2: unknown provider must throw rather than report fake-
  // free usage. `AIProviderName` is the type guard at compile time;
  // this asserts the runtime fallback for code paths that cast a
  // string from the DB or an external source.
  it('throws when given a provider name not in the rate table', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      estimateLlmCostCents('mystery-provider' as any, 100, 100),
    ).toThrow(/unknown provider/);
  });

  // #253 round-2: token counts beyond the safe-integer guard throw so
  // an untrusted aggregator can't sneak a bogus value past IEEE-754
  // rounding into a wrong cents value.
  it('throws on non-finite or negative token counts', () => {
    expect(() => estimateLlmCostCents('anthropic', Number.NaN, 0)).toThrow();
    expect(() => estimateLlmCostCents('anthropic', -1, 0)).toThrow();
    expect(() => estimateLlmCostCents('anthropic', 0, Infinity)).toThrow();
  });

  it('throws on token counts above the safe-integer guard', () => {
    // 3e12 is well above the 2e12 guard, far below 2^53.
    expect(() => estimateLlmCostCents('anthropic', 3_000_000_000_000, 0)).toThrow(/must be/);
  });
});

describe('isZeroCostProvider', () => {
  it('returns true for local-runtime providers', () => {
    expect(isZeroCostProvider('embedded')).toBe(true);
    expect(isZeroCostProvider('ollama')).toBe(true);
  });

  it('returns false for hosted paid APIs', () => {
    expect(isZeroCostProvider('anthropic')).toBe(false);
    expect(isZeroCostProvider('openai')).toBe(false);
    expect(isZeroCostProvider('google')).toBe(false);
  });
});
