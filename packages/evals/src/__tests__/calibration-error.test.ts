import { describe, it, expect } from 'vitest';
import { CalibrationErrorTracker } from '../metrics/calibration-error.js';

describe('CalibrationErrorTracker', () => {
  it('returns zero ECE for perfectly calibrated predictions', () => {
    const tracker = new CalibrationErrorTracker();
    // 80% confidence, 8 out of 10 correct = perfectly calibrated in that bin
    for (let i = 0; i < 8; i++) tracker.record({ predictedConfidence: 0.8, wasCorrect: true });
    for (let i = 0; i < 2; i++) tracker.record({ predictedConfidence: 0.8, wasCorrect: false });

    const result = tracker.calculate(10);

    // All samples in the 0.7-0.8 bin, avgConfidence=0.8, accuracy=0.8
    expect(result.ece).toBeCloseTo(0, 1);
    expect(result.totalSamples).toBe(10);
  });

  it('detects poorly calibrated predictions', () => {
    const tracker = new CalibrationErrorTracker();
    // Says 90% confident but only correct 20% of the time
    for (let i = 0; i < 2; i++) tracker.record({ predictedConfidence: 0.95, wasCorrect: true });
    for (let i = 0; i < 8; i++) tracker.record({ predictedConfidence: 0.95, wasCorrect: false });

    const result = tracker.calculate(10);

    // Gap should be ~0.75 (0.95 confidence vs 0.20 accuracy)
    expect(result.ece).toBeGreaterThan(0.5);
    expect(result.maxCalibrationError).toBeGreaterThan(0.5);
  });

  it('handles empty tracker', () => {
    const tracker = new CalibrationErrorTracker();
    const result = tracker.calculate();

    expect(result.ece).toBe(0);
    expect(result.totalSamples).toBe(0);
    expect(result.bins).toHaveLength(0);
  });

  it('distributes samples across bins correctly', () => {
    const tracker = new CalibrationErrorTracker();
    tracker.record({ predictedConfidence: 0.15, wasCorrect: true });
    tracker.record({ predictedConfidence: 0.55, wasCorrect: false });
    tracker.record({ predictedConfidence: 0.85, wasCorrect: true });

    const result = tracker.calculate(10);

    const nonEmptyBins = result.bins.filter(b => b.count > 0);
    expect(nonEmptyBins).toHaveLength(3);
    expect(result.totalSamples).toBe(3);
  });
});
