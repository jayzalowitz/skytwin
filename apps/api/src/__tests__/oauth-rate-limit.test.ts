import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkNewUserRateLimit,
  checkPendingPollRateLimit,
  NEW_USER_RATE_LIMIT_MAX,
  NEW_USER_RATE_LIMIT_MAX_BUCKETS,
  NEW_USER_RATE_LIMIT_WINDOW_MS,
  PENDING_POLL_RATE_LIMIT_MAX,
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

describe('checkPendingPollRateLimit', () => {
  beforeEach(() => {
    _resetNewUserRateLimitForTests();
  });

  it('allows the full poll loop (30 hits/min) without 429ing the legit wizard', () => {
    // The Electron wizard polls every 2s for 5 minutes — that's 30
    // requests/minute. If this bucket capped at NEW_USER_RATE_LIMIT_MAX
    // (=5) the wizard would 429 after ~10 seconds and look "stuck".
    // PENDING_POLL_RATE_LIMIT_MAX must be at least 30; we ship 120 for
    // comfortable headroom on jitter + retries.
    const now = 9_000_000;
    expect(PENDING_POLL_RATE_LIMIT_MAX).toBeGreaterThanOrEqual(30);
    for (let i = 0; i < 30; i++) {
      const r = checkPendingPollRateLimit('192.0.2.1', now + i * 2_000);
      expect(r.allowed).toBe(true);
    }
  });

  it('uses a SEPARATE bucket from the newUser path so authorize+poll cant cross-starve', () => {
    // Earlier code shared the bucket; a single ?newUser=true hit would
    // consume one of the 5 slots and a few poll hits would knock the
    // wizard offline. Distinct buckets mean filling one has no effect
    // on the other.
    const now = 11_000_000;
    for (let i = 0; i < NEW_USER_RATE_LIMIT_MAX; i++) {
      checkNewUserRateLimit('198.51.100.1', now);
    }
    expect(checkNewUserRateLimit('198.51.100.1', now).allowed).toBe(false);
    // Same IP — pending bucket is untouched.
    expect(checkPendingPollRateLimit('198.51.100.1', now).allowed).toBe(true);
  });

  it('rejects beyond PENDING_POLL_RATE_LIMIT_MAX', () => {
    const now = 13_000_000;
    for (let i = 0; i < PENDING_POLL_RATE_LIMIT_MAX; i++) {
      checkPendingPollRateLimit('203.0.113.1', now);
    }
    const blocked = checkPendingPollRateLimit('203.0.113.1', now);
    expect(blocked.allowed).toBe(false);
  });
});
