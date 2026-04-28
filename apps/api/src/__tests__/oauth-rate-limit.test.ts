import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkNewUserRateLimit,
  NEW_USER_RATE_LIMIT_MAX,
  NEW_USER_RATE_LIMIT_MAX_BUCKETS,
  NEW_USER_RATE_LIMIT_WINDOW_MS,
  _resetNewUserRateLimitForTests,
  _newUserRateLimitBucketCountForTests,
} from '../routes/oauth.js';

describe('checkNewUserRateLimit', () => {
  beforeEach(() => {
    _resetNewUserRateLimitForTests();
  });

  it('allows up to MAX requests within the window', () => {
    const now = 1_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX; i++) {
      const result = checkNewUserRateLimit('1.2.3.4', now);
      expect(result.allowed).toBe(true);
    }
  });

  it('rejects the (MAX+1)th request inside the window', () => {
    const now = 1_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX; i++) {
      checkNewUserRateLimit('1.2.3.4', now);
    }
    const blocked = checkNewUserRateLimit('1.2.3.4', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetAt).toBe(now + NEW_USER_RATE_LIMIT_WINDOW_MS);
  });

  it('isolates buckets per IP', () => {
    const now = 2_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX; i++) {
      checkNewUserRateLimit('1.1.1.1', now);
    }
    expect(checkNewUserRateLimit('1.1.1.1', now).allowed).toBe(false);
    // Different IP gets a fresh bucket.
    expect(checkNewUserRateLimit('2.2.2.2', now).allowed).toBe(true);
  });

  it('resets after the window passes', () => {
    const now = 3_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX; i++) {
      checkNewUserRateLimit('9.9.9.9', now);
    }
    expect(checkNewUserRateLimit('9.9.9.9', now).allowed).toBe(false);

    // Past the window — bucket should reset.
    const after = now + NEW_USER_RATE_LIMIT_WINDOW_MS + 1;
    expect(checkNewUserRateLimit('9.9.9.9', after).allowed).toBe(true);
  });

  // ── Bucket cap (memory leak mitigation) ─────────────────────────────────

  it('caps the bucket count when many distinct IPs hit the endpoint', () => {
    // Fill the cap with expired buckets — each IP gets exactly one hit at
    // an old timestamp. Then fire one more call from a brand-new IP at
    // current time and verify the Map size never exceeds the cap.
    const baseTime = 4_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX_BUCKETS; i++) {
      checkNewUserRateLimit(`10.0.0.${i}`, baseTime);
    }
    expect(_newUserRateLimitBucketCountForTests()).toBe(NEW_USER_RATE_LIMIT_MAX_BUCKETS);

    // Past the window so the eviction sweep can drop expired buckets.
    const after = baseTime + NEW_USER_RATE_LIMIT_WINDOW_MS + 1;
    checkNewUserRateLimit('203.0.113.1', after);

    // After the sweep, only the fresh bucket should remain.
    const size = _newUserRateLimitBucketCountForTests();
    expect(size).toBeLessThanOrEqual(NEW_USER_RATE_LIMIT_MAX_BUCKETS);
    expect(size).toBeGreaterThan(0);
  });

  it('drops oldest buckets when at cap and all are still in-window', () => {
    const now = 5_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX_BUCKETS; i++) {
      checkNewUserRateLimit(`10.1.0.${i}`, now);
    }
    expect(_newUserRateLimitBucketCountForTests()).toBe(NEW_USER_RATE_LIMIT_MAX_BUCKETS);

    // All buckets are in-window. Adding a new IP must evict at least one.
    checkNewUserRateLimit('203.0.113.99', now);
    expect(_newUserRateLimitBucketCountForTests()).toBeLessThanOrEqual(
      NEW_USER_RATE_LIMIT_MAX_BUCKETS,
    );
  });
});
