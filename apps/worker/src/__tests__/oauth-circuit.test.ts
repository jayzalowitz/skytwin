import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '@skytwin/core';
import { recordPermanentOAuthFailure } from '../oauth-circuit.js';

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
});
