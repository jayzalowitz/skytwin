import { describe, it, expect, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  withCircuitBreaker,
} from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeoutMs: 100,
      backoffMultiplier: 2,
      maxResetTimeoutMs: 400,
    });
  });

  it('starts in closed state', () => {
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
  });

  it('stays closed on successes', () => {
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after threshold failures', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.canExecute()).toBe(false);
  });

  it('transitions to half_open after reset timeout', async () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 120));

    expect(breaker.getState()).toBe('half_open');
    expect(breaker.canExecute()).toBe(true);
  });

  it('closes on success after half_open', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.canExecute()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('reopens with backoff on failure in half_open', async () => {
    // First open
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.getState()).toBe('half_open');

    // Probe fails — should reopen with longer timeout
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    // Still open after original timeout
    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.getState()).toBe('open'); // backoff doubled to 200ms

    // Wait for backoff timeout
    await new Promise((r) => setTimeout(r, 100));
    expect(breaker.getState()).toBe('half_open');
  });

  it('reports time until retry', () => {
    expect(breaker.getTimeUntilRetryMs()).toBe(0);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    const remaining = breaker.getTimeUntilRetryMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(100);
  });

  it('resets fully', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    breaker.reset();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getTimeUntilRetryMs()).toBe(0);
  });
});

describe('withCircuitBreaker', () => {
  it('executes fn when circuit is closed', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3, resetTimeoutMs: 100 });
    const result = await withCircuitBreaker(breaker, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('throws CircuitOpenError when circuit is open', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 100 });
    breaker.recordFailure();

    await expect(
      withCircuitBreaker(breaker, async () => 'should not run'),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('records success on fn success', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3, resetTimeoutMs: 100 });
    await withCircuitBreaker(breaker, async () => 'ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('records failure on fn error', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3, resetTimeoutMs: 100 });
    try {
      await withCircuitBreaker(breaker, async () => {
        throw new Error('boom');
      });
    } catch { /* expected */ }

    // One failure recorded — not yet open
    expect(breaker.getState()).toBe('closed');
  });
});
