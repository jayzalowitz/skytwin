import type { AccuracyMetric } from '@skytwin/shared-types';

/**
 * Record of a decision outcome for accuracy tracking.
 */
export interface DecisionRecord {
  decisionId: string;
  userId: string;
  domain: string;
  autoExecuted: boolean;
  feedbackType?: 'approve' | 'reject' | 'correct' | 'ignore';
  timestamp: Date;
}

/**
 * Tracks decision accuracy from real-world feedback.
 * Accuracy = (approved + auto-executed-without-rejection) / total
 */
export class AccuracyTracker {
  private readonly records: DecisionRecord[] = [];

  /**
   * Record a decision outcome.
   */
  recordOutcome(record: DecisionRecord): void {
    // Update existing record if feedback arrives later
    const existing = this.records.find(
      (r) => r.decisionId === record.decisionId,
    );
    if (existing) {
      if (record.feedbackType) {
        existing.feedbackType = record.feedbackType;
      }
    } else {
      this.records.push({ ...record });
    }
  }

  /**
   * Calculate accuracy for a specific user and domain in a time period.
   */
  calculateAccuracy(
    userId: string,
    domain: string,
    periodStart: Date,
    periodEnd: Date,
  ): AccuracyMetric {
    const filtered = this.records.filter(
      (r) =>
        r.userId === userId &&
        (domain === '*' || r.domain === domain) &&
        r.timestamp >= periodStart &&
        r.timestamp <= periodEnd,
    );

    const total = filtered.length;
    const autoExecuted = filtered.filter((r) => r.autoExecuted).length;
    const approved = filtered.filter((r) => r.feedbackType === 'approve').length;
    const rejected = filtered.filter((r) => r.feedbackType === 'reject').length;
    const corrected = filtered.filter((r) => r.feedbackType === 'correct').length;

    // Accuracy: decisions the user agreed with or didn't override
    // (approved + auto-executed that weren't rejected or corrected) / total
    const autoWithoutRejection = filtered.filter(
      (r) => r.autoExecuted && r.feedbackType !== 'reject' && r.feedbackType !== 'correct',
    ).length;
    const accuracyRate = total > 0 ? (approved + autoWithoutRejection) / total : 0;

    return {
      id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      userId,
      domain: domain === '*' ? 'all' : domain,
      totalDecisions: total,
      autoExecuted,
      approvedByUser: approved,
      rejectedByUser: rejected,
      correctedByUser: corrected,
      accuracyRate,
      periodStart,
      periodEnd,
    };
  }

  /**
   * Calculate overall accuracy across all domains.
   */
  getOverallAccuracy(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
  ): AccuracyMetric {
    return this.calculateAccuracy(userId, '*', periodStart, periodEnd);
  }

  /**
   * Get all stored records (for testing/export).
   */
  getRecords(): readonly DecisionRecord[] {
    return this.records;
  }
}
