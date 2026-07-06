import type { CircuitBreaker } from '@skytwin/core';

/**
 * Permanent OAuth failures are not transient outages. Record them directly so
 * a half-open probe cannot be consumed without closing or reopening the circuit.
 */
export function recordPermanentOAuthFailure(breaker: CircuitBreaker): void {
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
}
