import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '@skytwin/core';
import { MicrosoftOAuthRefreshError, OAuthRefreshError } from '@skytwin/connectors';
import { isPermanentOAuthRefreshError, recordPermanentOAuthFailure } from '../oauth-circuit.js';

function makeBreaker(): CircuitBreaker {
  return new CircuitBreaker('oauth-test', {
    failureThreshold: 3,
    resetTimeoutMs: 100,
    backoffMultiplier: 2,
    maxResetTimeoutMs: 400,
  });
}

describe('recordPermanentOAuthFailure', () => {
  it('opens a closed circuit immediately', () => {
    const breaker = makeBreaker();

    recordPermanentOAuthFailure(breaker);

    expect(breaker.getState()).toBe('open');
    expect(breaker.canExecute()).toBe(false);
  });

  it('reopens a consumed half-open probe instead of leaving retry at 0ms', () => {
    vi.useFakeTimers();
    try {
      const breaker = makeBreaker();
      recordPermanentOAuthFailure(breaker);
      vi.advanceTimersByTime(100);

      expect(breaker.canExecute()).toBe(true);
      recordPermanentOAuthFailure(breaker);

      expect(breaker.getState()).toBe('open');
      expect(breaker.canExecute()).toBe(false);
      expect(breaker.getTimeUntilRetryMs()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent while already open — repeated failures do not inflate backoff', () => {
    vi.useFakeTimers();
    try {
      const breaker = makeBreaker(); // resetTimeoutMs 100, backoff 2, max 400
      recordPermanentOAuthFailure(breaker);
      const firstRetry = breaker.getTimeUntilRetryMs(); // ~100ms base window

      // Hammer it while still open, within the retry window. The old
      // three-recordFailure() implementation re-ran open() each call and would
      // inflate the backoff to the 400ms cap; forceOpen() must leave it alone.
      recordPermanentOAuthFailure(breaker);
      recordPermanentOAuthFailure(breaker);

      expect(breaker.getState()).toBe('open');
      expect(breaker.getTimeUntilRetryMs()).toBeLessThanOrEqual(firstRetry);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isPermanentOAuthRefreshError', () => {
  it('recognizes permanent Google and Microsoft refresh failures', () => {
    expect(isPermanentOAuthRefreshError(new OAuthRefreshError(401, 'invalid_grant'))).toBe(true);
    expect(isPermanentOAuthRefreshError(new MicrosoftOAuthRefreshError(400, 'invalid_grant'))).toBe(true);
  });

  it('rejects transient and unrelated failures', () => {
    expect(isPermanentOAuthRefreshError(new OAuthRefreshError(500, 'unavailable'))).toBe(false);
    expect(isPermanentOAuthRefreshError(new MicrosoftOAuthRefreshError(429, 'slow_down'))).toBe(false);
    expect(isPermanentOAuthRefreshError(new Error('invalid_grant'))).toBe(false);
  });
});
