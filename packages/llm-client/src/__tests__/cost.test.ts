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
    expect(estimateLlmCostCents('embedded', Number.MAX_SAFE_INTEGER, 0)).toBe(0);
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
    // 1M input + 1M output at 8/40 deci-cents per million → 4.8¢ → 5¢.
    expect(estimateLlmCostCents('anthropic', 1_000_000, 1_000_000)).toBe(5);
  });

  it('estimates openai cost in integer cents', () => {
    // 1M output at 6 deci-cents per million → 0.6¢ → 1¢ (rounded up).
    expect(estimateLlmCostCents('openai', 0, 1_000_000)).toBe(1);
  });

  it('estimates google cost in integer cents', () => {
    // 1M output at 3 deci-cents per million → 0.3¢ → 1¢ (rounded up).
    expect(estimateLlmCostCents('google', 0, 1_000_000)).toBe(1);
  });

  it('rounds up so the cap-enforcement direction is always safe', () => {
    // Anthropic at small token counts (10k input, 10k output) →
    // (8*10_000 + 40*10_000) / 1_000_000 = 0.48 deci-cents → ceil = 1 →
    // ceil(1/10) = 1¢. The exact float would be 0.048¢; rounding up
    // means cap checks see 1¢ instead of zeroing out tiny usage.
    expect(estimateLlmCostCents('anthropic', 10_000, 10_000)).toBe(1);
  });

  it('is a pure function — same input twice yields the same output', () => {
    const a = estimateLlmCostCents('anthropic', 500_000, 250_000);
    const b = estimateLlmCostCents('anthropic', 500_000, 250_000);
    expect(a).toBe(b);
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
