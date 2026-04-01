import { describe, it, expect } from 'vitest';
import { EscalationCorrectnessTracker } from '../metrics/escalation-correctness.js';

describe('EscalationCorrectnessTracker', () => {
  it('calculates perfect precision and recall', () => {
    const tracker = new EscalationCorrectnessTracker();
    tracker.record({ decisionId: '1', wasEscalated: true, userFeedback: 'reject' });
    tracker.record({ decisionId: '2', wasEscalated: false, userFeedback: 'approve' });

    const result = tracker.calculate();

    expect(result.truePositives).toBe(1);
    expect(result.trueNegatives).toBe(1);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1Score).toBe(1);
  });

  it('detects false positives (unnecessary escalation)', () => {
    const tracker = new EscalationCorrectnessTracker();
    tracker.record({ decisionId: '1', wasEscalated: true, userFeedback: 'approve' });
    tracker.record({ decisionId: '2', wasEscalated: true, userFeedback: 'approve' });
    tracker.record({ decisionId: '3', wasEscalated: true, userFeedback: 'reject' });

    const result = tracker.calculate();

    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(2);
    expect(result.precision).toBeCloseTo(1 / 3, 5);
  });

  it('detects false negatives (missed escalation)', () => {
    const tracker = new EscalationCorrectnessTracker();
    tracker.record({ decisionId: '1', wasEscalated: false, userFeedback: 'reject' });
    tracker.record({ decisionId: '2', wasEscalated: false, userFeedback: 'undo' });

    const result = tracker.calculate();

    expect(result.falseNegatives).toBe(2);
    expect(result.recall).toBe(0);
  });

  it('handles empty tracker', () => {
    const tracker = new EscalationCorrectnessTracker();
    const result = tracker.calculate();

    expect(result.totalDecisions).toBe(0);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it('updates existing decisions with feedback', () => {
    const tracker = new EscalationCorrectnessTracker();
    tracker.record({ decisionId: '1', wasEscalated: true, userFeedback: null });
    tracker.record({ decisionId: '1', wasEscalated: true, userFeedback: 'reject' });

    const result = tracker.calculate();
    expect(result.truePositives).toBe(1);
    expect(result.totalDecisions).toBe(1);
  });
});
