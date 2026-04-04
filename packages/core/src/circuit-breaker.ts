/**
 * Generalized circuit breaker for protecting against cascading failures.
 *
 * States:
 * - CLOSED: requests pass through normally
 * - OPEN: requests are rejected immediately (fail-fast)
 * - HALF_OPEN: one probe request allowed to test recovery
 *
 * Based on the pattern used in @skytwin/ironclaw-adapter but generalized
 * for use across connectors, workers, and other services.
 */

export interface CircuitBreakerConfig {
  /** Number of consecutive failures to open the circuit. Default: 3 */
  failureThreshold: number;
  /** Time in ms to wait before allowing a probe request. Default: 300000 (5 min) */
  resetTimeoutMs: number;
  /** Multiplier for reset timeout on repeated opens. Default: 2 */
  backoffMultiplier: number;
  /** Maximum reset timeout after backoff. Default: 1200000 (20 min) */
  maxResetTimeoutMs: number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 300_000, // 5 minutes
  backoffMultiplier: 2,
  maxResetTimeoutMs: 1_200_000, // 20 minutes
};

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private consecutiveFailures = 0;
  private state: CircuitState = 'closed';
  private openedAt: number | null = null;
  private currentResetTimeout: number;
  private openCount = 0;
  readonly name: string;

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentResetTimeout = this.config.resetTimeoutMs;
  }

  /**
   * Check if the circuit allows a request to proceed.
   */
  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= this.currentResetTimeout) {
        this.state = 'half_open';
        return true;
      }
      return false;
    }

    // half_open — allow one probe
    return true;
  }

  /**
   * Record a successful operation. Resets failure count and closes the circuit.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== 'closed') {
      this.state = 'closed';
      this.openCount = 0;
      this.currentResetTimeout = this.config.resetTimeoutMs;
    }
  }

  /**
   * Record a failed operation. Opens the circuit after threshold failures.
   */
  recordFailure(): void {
    this.consecutiveFailures++;

    if (this.state === 'half_open') {
      // Probe failed — reopen with increased backoff
      this.open();
      return;
    }

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
    }
  }

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitState {
    // Re-evaluate in case timeout has passed
    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= this.currentResetTimeout) {
        return 'half_open';
      }
    }
    return this.state;
  }

  /**
   * Get time remaining until circuit transitions from open to half_open.
   * Returns 0 if circuit is not open.
   */
  getTimeUntilRetryMs(): number {
    if (this.state !== 'open' || !this.openedAt) return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.currentResetTimeout - elapsed);
  }

  /**
   * Force the circuit to a specific state. Useful for testing and manual intervention.
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.openedAt = null;
    this.openCount = 0;
    this.currentResetTimeout = this.config.resetTimeoutMs;
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.openCount++;

    // Apply exponential backoff to reset timeout
    if (this.openCount > 1) {
      this.currentResetTimeout = Math.min(
        this.currentResetTimeout * this.config.backoffMultiplier,
        this.config.maxResetTimeoutMs,
      );
    }
  }
}

/**
 * Error thrown when a circuit breaker is open and rejects a request.
 */
export class CircuitOpenError extends Error {
  readonly circuitName: string;
  readonly retryAfterMs: number;

  constructor(circuitName: string, retryAfterMs: number) {
    super(`Circuit breaker '${circuitName}' is open. Retry after ${Math.round(retryAfterMs / 1000)}s.`);
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Execute a function through a circuit breaker.
 * Throws CircuitOpenError if the circuit is open.
 */
export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
): Promise<T> {
  if (!breaker.canExecute()) {
    throw new CircuitOpenError(breaker.name, breaker.getTimeUntilRetryMs());
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}
