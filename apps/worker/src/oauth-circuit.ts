import type { CircuitBreaker } from '@skytwin/core';

/**
 * Permanent OAuth failures are not transient outages. Force the circuit open in
 * one idempotent step so a half-open probe cannot be consumed, and so repeated
 * permanent failures do not inflate the exponential backoff the way three
 * unconditional recordFailure() calls would (#595 review).
 */
export function recordPermanentOAuthFailure(breaker: CircuitBreaker): void {
  breaker.forceOpen();
}
