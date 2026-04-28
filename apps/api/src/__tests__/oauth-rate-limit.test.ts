import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkNewUserRateLimit,
  NEW_USER_RATE_LIMIT_MAX,
  NEW_USER_RATE_LIMIT_WINDOW_MS,
  _resetNewUserRateLimitForTests,
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
});
