/**
 * Approval routing engine.
 *
 * Determines expiry times based on urgency, manages batch grouping,
 * and provides the expiry check logic for the worker cron.
 *
 * This is pure logic — no database dependency. The caller provides
 * the current time and urgency, and the router returns the computed
 * expiry timestamp.
 */

/**
 * Urgency levels for approval requests, mapped to expiry durations.
 */
const EXPIRY_DURATIONS_MS: Record<string, number> = {
  immediate: 15 * 60 * 1000,         // 15 minutes
  normal: 24 * 60 * 60 * 1000,       // 24 hours
  low: 72 * 60 * 60 * 1000,          // 72 hours
};

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Port interface for approval persistence.
 * The router depends on this, not on a concrete repository.
 */
export interface ApprovalRepositoryPort {
  expirePending(): Promise<number>;
  batchRespond(
    ids: string[],
    action: 'approve' | 'reject',
    userId: string,
    reason?: string,
  ): Promise<unknown[]>;
}

export class ApprovalRouter {
  constructor(private readonly repository: ApprovalRepositoryPort) {}

  /**
   * Compute the expiry timestamp for a given urgency level.
   */
  computeExpiry(urgency: string, now: Date = new Date()): Date {
    const durationMs = EXPIRY_DURATIONS_MS[urgency] ?? DEFAULT_EXPIRY_MS;
    return new Date(now.getTime() + durationMs);
  }

  /**
   * Check if an approval has expired.
   */
  isExpired(expiresAt: Date, now: Date = new Date()): boolean {
    return now >= expiresAt;
  }

  /**
   * Run the expiry sweep. Call this from the worker cron.
   * Returns the number of expired requests.
   */
  async expirePendingApprovals(): Promise<number> {
    return this.repository.expirePending();
  }

  /**
   * Respond to multiple approvals at once.
   */
  async batchRespond(
    ids: string[],
    action: 'approve' | 'reject',
    userId: string,
    reason?: string,
  ): Promise<{ processed: number }> {
    const results = await this.repository.batchRespond(ids, action, userId, reason);
    return { processed: results.length };
  }

  /**
   * Get the expiry duration in milliseconds for a given urgency.
   */
  getExpiryDurationMs(urgency: string): number {
    return EXPIRY_DURATIONS_MS[urgency] ?? DEFAULT_EXPIRY_MS;
  }
}
