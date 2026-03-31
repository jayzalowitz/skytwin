import { describe, it, expect } from 'vitest';
import { AccuracyTracker } from '../accuracy-tracker.js';

describe('AccuracyTracker', () => {
  it('calculates accuracy from decision records', () => {
    const tracker = new AccuracyTracker();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);

    // 3 auto-executed decisions
    tracker.recordOutcome({ decisionId: 'd1', userId: 'u1', domain: 'email', autoExecuted: true, timestamp: now });
    tracker.recordOutcome({ decisionId: 'd2', userId: 'u1', domain: 'email', autoExecuted: true, timestamp: now });
    tracker.recordOutcome({ decisionId: 'd3', userId: 'u1', domain: 'email', autoExecuted: true, timestamp: now });

    // 1 approved
    tracker.recordOutcome({ decisionId: 'd4', userId: 'u1', domain: 'email', autoExecuted: false, feedbackType: 'approve', timestamp: now });

    // 1 rejected (user disagreed)
    tracker.recordOutcome({ decisionId: 'd5', userId: 'u1', domain: 'email', autoExecuted: true, feedbackType: 'reject', timestamp: now });

    const metric = tracker.calculateAccuracy('u1', 'email', yesterday, new Date(now.getTime() + 1000));
    expect(metric.totalDecisions).toBe(5);
    expect(metric.autoExecuted).toBe(4);
    expect(metric.approvedByUser).toBe(1);
    expect(metric.rejectedByUser).toBe(1);
    // accuracy = (1 approved + 3 auto-without-rejection) / 5 = 4/5 = 0.8
    expect(metric.accuracyRate).toBeCloseTo(0.8, 1);
  });

  it('updates existing records when feedback arrives later', () => {
    const tracker = new AccuracyTracker();
    const now = new Date();

    tracker.recordOutcome({ decisionId: 'd1', userId: 'u1', domain: 'email', autoExecuted: true, timestamp: now });
    // Feedback arrives later
    tracker.recordOutcome({ decisionId: 'd1', userId: 'u1', domain: 'email', autoExecuted: true, feedbackType: 'approve', timestamp: now });

    expect(tracker.getRecords()).toHaveLength(1);
    expect(tracker.getRecords()[0]!.feedbackType).toBe('approve');
  });

  it('returns zero accuracy for empty period', () => {
    const tracker = new AccuracyTracker();
    const metric = tracker.calculateAccuracy('u1', 'email', new Date(), new Date());
    expect(metric.accuracyRate).toBe(0);
    expect(metric.totalDecisions).toBe(0);
  });

  it('filters by domain', () => {
    const tracker = new AccuracyTracker();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);

    tracker.recordOutcome({ decisionId: 'd1', userId: 'u1', domain: 'email', autoExecuted: true, timestamp: now });
    tracker.recordOutcome({ decisionId: 'd2', userId: 'u1', domain: 'calendar', autoExecuted: true, timestamp: now });

    const email = tracker.calculateAccuracy('u1', 'email', yesterday, new Date(now.getTime() + 1000));
    expect(email.totalDecisions).toBe(1);

    const all = tracker.getOverallAccuracy('u1', yesterday, new Date(now.getTime() + 1000));
    expect(all.totalDecisions).toBe(2);
  });
});
