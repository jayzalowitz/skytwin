import type { CircuitBreaker } from '@skytwin/core';
import { MicrosoftOAuthRefreshError, OAuthRefreshError } from '@skytwin/connectors';

export function isPermanentOAuthRefreshError(
  error: unknown,
): error is OAuthRefreshError | MicrosoftOAuthRefreshError {
  return (error instanceof OAuthRefreshError || error instanceof MicrosoftOAuthRefreshError) && error.permanent;
}

/**
 * Permanent OAuth failures are not transient outages. Force the circuit open in
 * one idempotent step so a half-open probe cannot be consumed, and so repeated
 * permanent failures do not inflate the exponential backoff the way three
 * unconditional recordFailure() calls would (#595 review).
 */
export function recordPermanentOAuthFailure(breaker: CircuitBreaker): void {
  breaker.forceOpen();
}
