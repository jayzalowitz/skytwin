import { describe, it, expect } from 'vitest';
import { TemporalAnalyzer } from '../temporal-analyzer.js';
import type { TwinEvidence } from '@skytwin/shared-types';

function makeEvidence(hour: number, day: number): TwinEvidence {
  const d = new Date(2026, 2, 1 + day, hour, 0, 0);
  return {
    id: `ev_${hour}_${day}`,
    userId: 'user1',
    source: 'email',
    type: 'action',
    data: { action: 'archive' },
    domain: 'email',
    timestamp: d,
  };
}

describe('TemporalAnalyzer', () => {
  const analyzer = new TemporalAnalyzer();

  it('returns default profile for empty evidence', () => {
    const profile = analyzer.analyzeTemporalPatterns([]);
    expect(profile.activeHours.start).toBe(8);
    expect(profile.activeHours.end).toBe(22);
  });

  it('detects active hours from evidence distribution', () => {
    // Simulate activity concentrated between 9am and 6pm
    const evidence: TwinEvidence[] = [];
    for (let day = 0; day < 7; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        evidence.push(makeEvidence(hour, day));
      }
    }

    const profile = analyzer.analyzeTemporalPatterns(evidence);
    expect(profile.activeHours.start).toBeGreaterThanOrEqual(8);
    expect(profile.activeHours.start).toBeLessThanOrEqual(10);
    expect(profile.activeHours.end).toBeGreaterThanOrEqual(16);
    expect(profile.activeHours.end).toBeLessThanOrEqual(18);
  });

  it('detects weekday patterns', () => {
    const evidence: TwinEvidence[] = [];
    // Monday (day 0 = Sunday in JS, so day=1 offset to get Monday)
    for (let i = 0; i < 5; i++) {
      const ev = makeEvidence(10, i);
      ev.data = { action: 'archive' };
      evidence.push(ev);
    }

    const profile = analyzer.analyzeTemporalPatterns(evidence);
    // Should have entries in weekdayPatterns
    const days = Object.keys(profile.weekdayPatterns);
    expect(days.length).toBeGreaterThan(0);
  });

  it('identifies response times per domain', () => {
    const evidence: TwinEvidence[] = [
      {
        id: 'ev1',
        userId: 'user1',
        source: 'email',
        type: 'action',
        data: { action: 'reply', responseTimeMs: 120000 },
        domain: 'email',
        timestamp: new Date(),
      },
      {
        id: 'ev2',
        userId: 'user1',
        source: 'email',
        type: 'action',
        data: { action: 'reply', responseTimeMs: 180000 },
        domain: 'email',
        timestamp: new Date(),
      },
    ];

    const profile = analyzer.analyzeTemporalPatterns(evidence);
    expect(profile.peakResponseTimes['email']).toBeDefined();
    // Median of [120000, 180000] = 120000 (floor of length/2 = index 1)
    expect(profile.peakResponseTimes['email']).toBe(180000);
  });

  it('correctly reports if hour is within active range', () => {
    const profile = {
      userId: 'user1',
      activeHours: { start: 9, end: 17 },
      peakResponseTimes: {},
      weekdayPatterns: {},
      urgencyThresholds: {},
    };

    expect(analyzer.isActiveHour(profile, new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(analyzer.isActiveHour(profile, new Date(2026, 0, 1, 3, 0))).toBe(false);
    expect(analyzer.isActiveHour(profile, new Date(2026, 0, 1, 20, 0))).toBe(false);
  });
});
