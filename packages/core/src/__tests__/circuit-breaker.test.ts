import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  withCircuitBreaker,
} from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeoutMs: 100,
      backoffMultiplier: 2,
      maxResetTimeoutMs: 400,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('transitions to half_open after reset timeout', () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    // Advance past reset timeout
    vi.advanceTimersByTime(100);

    expect(breaker.getState()).toBe('half_open');
    expect(breaker.canExecute()).toBe(true);
  });

  it('closes on success after half_open', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.advanceTimersByTime(100);
    expect(breaker.canExecute()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('allows only one probe at a time in half_open state', () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // Wait for reset timeout to transition to half_open
    vi.advanceTimersByTime(100);

    // First probe should be allowed
    expect(breaker.canExecute()).toBe(true);
    // Second concurrent probe should be rejected (latch prevents stampede)
    expect(breaker.canExecute()).toBe(false);
    expect(breaker.canExecute()).toBe(false);

    // After success, probe latch resets and new probes are allowed
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
  });

  it('clears probe latch on failure in half_open', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.advanceTimersByTime(100);
    expect(breaker.canExecute()).toBe(true); // first probe

    // Probe fails — circuit reopens
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    // After backoff timeout (200ms = 100 * 2), a new probe should be allowed
    vi.advanceTimersByTime(200);
    expect(breaker.canExecute()).toBe(true);
  });

  it('reopens with backoff on failure in half_open', () => {
    // First open
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.advanceTimersByTime(100);
    expect(breaker.getState()).toBe('half_open');

    // Probe fails — should reopen with longer timeout
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    // Still open after original timeout (backoff doubled to 200ms)
    vi.advanceTimersByTime(100);
    expect(breaker.getState()).toBe('open');

    // Wait for remaining backoff
    vi.advanceTimersByTime(100);
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
