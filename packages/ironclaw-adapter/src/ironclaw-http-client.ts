import { createHmac } from 'node:crypto';
import type { ExecutionResult, ExecutionStatus, RollbackResult } from '@skytwin/shared-types';

/**
 * Configuration for the IronClaw HTTP client.
 */
export interface IronClawClientConfig {
  /** Base URL for the IronClaw server (e.g., http://localhost:4000) */
  apiUrl: string;

  /** HMAC-SHA256 secret for webhook authentication */
  webhookSecret: string;

  /** Owner ID for IronClaw's multi-tenant model */
  ownerId: string;

  /** Channel identifier sent to IronClaw. Default: 'skytwin' */
  channelId?: string;

  /** Request timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;

  /** Max retries for transient failures. Default: 2 */
  maxRetries?: number;

  /** Circuit breaker: max failures before opening. Default: 5 */
  circuitBreakerThreshold?: number;

  /** Circuit breaker: window in ms to count failures. Default: 300000 (5 min) */
  circuitBreakerWindowMs?: number;
}

/**
 * Message format for IronClaw's webhook endpoint.
 *
 * Maps to IronClaw's IncomingMessage (Rust):
 *   channel, user_id, owner_id, content, thread_id, attachments, metadata
 */
export interface IronClawMessage {
  channel: string;
  user_id: string;
  owner_id: string;
  content: string;
  thread_id?: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
}

/**
 * Response from IronClaw's webhook endpoint.
 *
 * Maps to IronClaw's OutgoingResponse (Rust):
 *   content, thread_id, attachments, metadata
 */
export interface IronClawResponse {
  content: string;
  thread_id?: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
}

interface CircuitBreakerState {
  failures: { timestamp: number }[];
  open: boolean;
  openedAt: number | null;
}

/**
 * HTTP client for communicating with an IronClaw server.
 *
 * Handles HMAC-SHA256 authentication, retries with linear backoff,
 * and circuit breaker protection.
 */
export class IronClawHttpClient {
  private readonly config: Required<IronClawClientConfig>;
  private readonly circuitBreaker: CircuitBreakerState = {
    failures: [],
    open: false,
    openedAt: null,
  };

  constructor(config: IronClawClientConfig) {
    this.config = {
      channelId: 'skytwin',
      timeoutMs: 30_000,
      maxRetries: 2,
      circuitBreakerThreshold: 5,
      circuitBreakerWindowMs: 300_000,
      ...config,
    };
  }

  /**
   * Send a message to IronClaw's webhook endpoint.
   */
  async sendMessage(message: IronClawMessage): Promise<IronClawResponse> {
    this.checkCircuitBreaker();

    const url = `${this.config.apiUrl}/webhook`;
    const body = JSON.stringify(message);
    const signature = this.sign(body);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        // Linear backoff: 1s, 2s, 3s...
        await this.delay(attempt * 1000);
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': `sha256=${signature}`,
            'X-IronClaw-Channel': this.config.channelId,
          },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const error = new Error(
            `IronClaw webhook returned HTTP ${response.status}: ${errorBody}`,
          );

          // Don't retry client errors (4xx) except 429 (rate limit)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            this.recordFailure();
            throw error;
          }

          lastError = error;
          continue;
        }

        this.resetCircuitBreaker();
        return (await response.json()) as IronClawResponse;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`IronClaw webhook timed out after ${this.config.timeoutMs}ms`);
        } else if (error instanceof Error) {
          lastError = error;
        } else {
          lastError = new Error(String(error));
        }

        // If it's a non-retryable error we already threw, this won't be reached
      }
    }

    this.recordFailure();
    throw lastError ?? new Error('IronClaw webhook request failed after all retries');
  }

  /**
   * Check IronClaw's health status.
   */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();

    try {
      const response = await fetch(`${this.config.apiUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - start;

      if (response.ok) {
        // If circuit breaker was open and health check passes, close it
        if (this.circuitBreaker.open) {
          this.resetCircuitBreaker();
        }
        return { healthy: true, latencyMs };
      }

      return { healthy: false, latencyMs };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Parse an IronClaw response into a SkyTwin ExecutionResult.
   *
   * IronClaw returns structured metadata when responding to SkyTwin-formatted
   * messages. We look for status/outputs/error in metadata first, then fall
   * back to inferring from the response content.
   */
  parseExecutionResult(planId: string, response: IronClawResponse, startedAt: Date): ExecutionResult {
    const metadata = response.metadata ?? {};

    // Check for structured status in metadata
    const metadataStatus = metadata['status'] as string | undefined;
    const metadataError = metadata['error'] as string | undefined;
    const metadataOutputs = metadata['outputs'] as Record<string, unknown> | undefined;

    let status: ExecutionStatus;
    if (metadataStatus === 'completed' || metadataStatus === 'success') {
      status = 'completed';
    } else if (metadataStatus === 'failed' || metadataStatus === 'error') {
      status = 'failed';
    } else if (metadataStatus === 'pending') {
      status = 'pending';
    } else if (metadataStatus === 'running') {
      status = 'running';
    } else {
      // Infer from content if no structured status
      const content = (response.content ?? '').toLowerCase();
      if (content.includes('error') || content.includes('failed') || content.includes('unable')) {
        status = 'failed';
      } else {
        status = 'completed';
      }
    }

    const result: ExecutionResult = {
      planId,
      status,
      startedAt,
      completedAt: status === 'completed' || status === 'failed' ? new Date() : undefined,
    };

    if (status === 'failed') {
      result.error = metadataError ?? response.content;
    }

    result.output = {
      ...metadataOutputs,
      ironclawResponse: response.content,
      ironclawThreadId: response.thread_id,
    };

    return result;
  }

  /**
   * Parse an IronClaw response into a RollbackResult.
   */
  parseRollbackResult(response: IronClawResponse): RollbackResult {
    const metadata = response.metadata ?? {};
    const metadataStatus = metadata['status'] as string | undefined;

    if (metadataStatus === 'completed' || metadataStatus === 'success') {
      return { success: true, message: response.content ?? 'Rollback completed.' };
    }

    if (metadataStatus === 'failed' || metadataStatus === 'error') {
      return {
        success: false,
        message: (metadata['error'] as string) ?? response.content ?? 'Rollback failed.',
      };
    }

    // Infer from content
    const content = (response.content ?? '').toLowerCase();
    if (content.includes('error') || content.includes('failed') || content.includes('unable')) {
      return { success: false, message: response.content };
    }

    return { success: true, message: response.content ?? 'Rollback completed.' };
  }

  /**
   * Whether the circuit breaker is currently open.
   */
  get isCircuitOpen(): boolean {
    return this.circuitBreaker.open;
  }

  // ── HMAC-SHA256 signing ──────────────────────────────────────────

  private sign(body: string): string {
    return createHmac('sha256', this.config.webhookSecret)
      .update(body)
      .digest('hex');
  }

  // ── Circuit breaker ──────────────────────────────────────────────

  private checkCircuitBreaker(): void {
    if (!this.circuitBreaker.open) return;

    // Allow a probe request after half the window has elapsed
    const elapsed = Date.now() - (this.circuitBreaker.openedAt ?? 0);
    if (elapsed > this.config.circuitBreakerWindowMs / 2) {
      // Half-open: allow the request through as a probe
      return;
    }

    throw new Error(
      'IronClaw circuit breaker is open — too many recent failures. ' +
      'Automated actions are temporarily paused.',
    );
  }

  private recordFailure(): void {
    const now = Date.now();

    // Prune old failures outside the window
    this.circuitBreaker.failures = this.circuitBreaker.failures.filter(
      (f) => now - f.timestamp < this.config.circuitBreakerWindowMs,
    );

    this.circuitBreaker.failures.push({ timestamp: now });

    if (this.circuitBreaker.failures.length >= this.config.circuitBreakerThreshold) {
      this.circuitBreaker.open = true;
      this.circuitBreaker.openedAt = now;
    }
  }

  private resetCircuitBreaker(): void {
    this.circuitBreaker.failures = [];
    this.circuitBreaker.open = false;
    this.circuitBreaker.openedAt = null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
