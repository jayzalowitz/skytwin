import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrustTier } from '@skytwin/shared-types';

/**
 * checkRateLimit uses a module-level Map for state, so we need a fresh
 * module import for each test suite to avoid cross-test contamination.
 * We dynamically import the module and use vi.useFakeTimers to control
 * time-based reset behavior.
 */

describe('checkRateLimit', () => {
  let checkRateLimit: (userId: string, trustTier: TrustTier) => { allowed: boolean; remaining: number; resetAt: number };
  let RATE_LIMITS: Record<TrustTier, number>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));

    // Dynamic import to get fresh module state per test via cache busting
    // is not straightforward, so we import once and rely on unique userIds
    // per test to avoid state collisions.
    const mod = await import('../routes/ask.js');
    checkRateLimit = mod.checkRateLimit;
    RATE_LIMITS = mod.RATE_LIMITS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow the first call for a new user and return remaining = limit - 1', () => {
    const result = checkRateLimit('user-first-call', TrustTier.OBSERVER);
    const limit = RATE_LIMITS[TrustTier.OBSERVER]; // 60

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(limit - 1);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('should decrement remaining with each call', () => {
    const limit = RATE_LIMITS[TrustTier.OBSERVER]; // 60

    const first = checkRateLimit('user-decrement', TrustTier.OBSERVER);
    expect(first.remaining).toBe(limit - 1);

    const second = checkRateLimit('user-decrement', TrustTier.OBSERVER);
    expect(second.remaining).toBe(limit - 2);

    const third = checkRateLimit('user-decrement', TrustTier.OBSERVER);
    expect(third.remaining).toBe(limit - 3);
  });

  it('should deny access when the limit is reached', () => {
    const limit = RATE_LIMITS[TrustTier.OBSERVER]; // 60

    // Exhaust all allowed calls
    for (let i = 0; i < limit; i++) {
      const result = checkRateLimit('user-exhaust', TrustTier.OBSERVER);
      expect(result.allowed).toBe(true);
    }

    // Next call should be denied
    const denied = checkRateLimit('user-exhaust', TrustTier.OBSERVER);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('should allow requests again after the reset window expires', () => {
    const limit = RATE_LIMITS[TrustTier.OBSERVER]; // 60

    // Exhaust all allowed calls
    for (let i = 0; i < limit; i++) {
      checkRateLimit('user-reset', TrustTier.OBSERVER);
    }

    // Verify denied
    const denied = checkRateLimit('user-reset', TrustTier.OBSERVER);
    expect(denied.allowed).toBe(false);

    // Advance time past the 1-hour reset window
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);

    // Should be allowed again with a fresh window
    const afterReset = checkRateLimit('user-reset', TrustTier.OBSERVER);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(limit - 1);
  });

  it('should apply different limits for different trust tiers', () => {
    const observerResult = checkRateLimit('user-observer-tier', TrustTier.OBSERVER);
    expect(observerResult.remaining).toBe(RATE_LIMITS[TrustTier.OBSERVER] - 1);

    const suggestResult = checkRateLimit('user-suggest-tier', TrustTier.SUGGEST);
    expect(suggestResult.remaining).toBe(RATE_LIMITS[TrustTier.SUGGEST] - 1);

    const lowResult = checkRateLimit('user-low-tier', TrustTier.LOW_AUTONOMY);
    expect(lowResult.remaining).toBe(RATE_LIMITS[TrustTier.LOW_AUTONOMY] - 1);

    const modResult = checkRateLimit('user-mod-tier', TrustTier.MODERATE_AUTONOMY);
    expect(modResult.remaining).toBe(RATE_LIMITS[TrustTier.MODERATE_AUTONOMY] - 1);

    const highResult = checkRateLimit('user-high-tier', TrustTier.HIGH_AUTONOMY);
    expect(highResult.remaining).toBe(RATE_LIMITS[TrustTier.HIGH_AUTONOMY] - 1);
  });

  it('should have correct rate limit values per tier', () => {
    expect(RATE_LIMITS[TrustTier.OBSERVER]).toBe(60);
    expect(RATE_LIMITS[TrustTier.SUGGEST]).toBe(120);
    expect(RATE_LIMITS[TrustTier.LOW_AUTONOMY]).toBe(240);
    expect(RATE_LIMITS[TrustTier.MODERATE_AUTONOMY]).toBe(360);
    expect(RATE_LIMITS[TrustTier.HIGH_AUTONOMY]).toBe(600);
  });

  it('should track the resetAt timestamp as one hour from first call', () => {
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;

    const result = checkRateLimit('user-reset-at', TrustTier.OBSERVER);
    expect(result.resetAt).toBe(now + oneHourMs);
  });
});
