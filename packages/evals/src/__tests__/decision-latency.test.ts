import { describe, it, expect } from 'vitest';
import { DecisionLatencyTracker } from '../metrics/decision-latency.js';

describe('DecisionLatencyTracker', () => {
  it('calculates percentiles correctly', () => {
    const tracker = new DecisionLatencyTracker();
    const now = new Date();

    // 100 records with latencies 1-100ms
    for (let i = 1; i <= 100; i++) {
      tracker.record({ decisionId: `d${i}`, latencyMs: i, domain: 'email', timestamp: now });
    }

    const result = tracker.calculate();

    expect(result.totalDecisions).toBe(100);
    expect(result.p50Ms).toBe(50);
    expect(result.p90Ms).toBe(90);
    expect(result.p99Ms).toBe(99);
    expect(result.meanMs).toBe(50.5);
    expect(result.minMs).toBe(1);
    expect(result.maxMs).toBe(100);
  });

  it('filters by domain', () => {
    const tracker = new DecisionLatencyTracker();
    const now = new Date();

    tracker.record({ decisionId: 'd1', latencyMs: 10, domain: 'email', timestamp: now });
    tracker.record({ decisionId: 'd2', latencyMs: 50, domain: 'email', timestamp: now });
    tracker.record({ decisionId: 'd3', latencyMs: 200, domain: 'calendar', timestamp: now });

    const emailResult = tracker.calculate('email');
    expect(emailResult.totalDecisions).toBe(2);
    expect(emailResult.maxMs).toBe(50);

    const allResult = tracker.calculate();
    expect(allResult.totalDecisions).toBe(3);
    expect(allResult.maxMs).toBe(200);
  });

  it('handles empty tracker', () => {
    const tracker = new DecisionLatencyTracker();
    const result = tracker.calculate();

    expect(result.totalDecisions).toBe(0);
    expect(result.p50Ms).toBe(0);
    expect(result.meanMs).toBe(0);
  });

  it('handles single record', () => {
    const tracker = new DecisionLatencyTracker();
    tracker.record({ decisionId: 'd1', latencyMs: 42, domain: 'email', timestamp: new Date() });

    const result = tracker.calculate();
    expect(result.p50Ms).toBe(42);
    expect(result.p90Ms).toBe(42);
    expect(result.p99Ms).toBe(42);
    expect(result.meanMs).toBe(42);
  });
});
