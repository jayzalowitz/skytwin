import type { TemporalProfile, TwinEvidence } from '@skytwin/shared-types';

/**
 * Analyzes evidence timestamps to build a temporal profile of user behavior.
 * Identifies active hours, day-of-week patterns, and response times.
 */
export class TemporalAnalyzer {
  /**
   * Build a temporal profile from evidence history.
   */
  analyzeTemporalPatterns(evidence: TwinEvidence[]): TemporalProfile {
    if (evidence.length === 0) {
      return this.emptyProfile('');
    }

    const userId = evidence[0]!.userId;

    // Bin by hour of day
    const hourCounts = new Array(24).fill(0) as number[];
    for (const ev of evidence) {
      const hour = ev.timestamp.getHours();
      hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    }

    // Find active hours (contiguous hours with above-average activity)
    const avgPerHour = evidence.length / 24;
    let startHour = 0;
    let endHour = 23;
    for (let h = 0; h < 24; h++) {
      if (hourCounts[h]! > avgPerHour * 0.5) {
        startHour = h;
        break;
      }
    }
    for (let h = 23; h >= 0; h--) {
      if (hourCounts[h]! > avgPerHour * 0.5) {
        endHour = h;
        break;
      }
    }

    // Bin by day of week
    const dayActions = new Map<number, string[]>();
    for (const ev of evidence) {
      const day = ev.timestamp.getDay();
      const actions = dayActions.get(day) ?? [];
      const action = ev.data['action'] as string ?? ev.type;
      actions.push(action);
      dayActions.set(day, actions);
    }

    // Find most common actions per day
    const weekdayPatterns: Record<number, string[]> = {};
    for (const [day, actions] of dayActions) {
      const counts = new Map<string, number>();
      for (const a of actions) {
        counts.set(a, (counts.get(a) ?? 0) + 1);
      }
      weekdayPatterns[day] = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([action]) => action);
    }

    // Calculate response times per domain
    const peakResponseTimes: Record<string, number> = {};
    const domainTimes = new Map<string, number[]>();
    for (const ev of evidence) {
      const responseMs = ev.data['responseTimeMs'] as number | undefined;
      if (responseMs !== undefined) {
        const times = domainTimes.get(ev.domain) ?? [];
        times.push(responseMs);
        domainTimes.set(ev.domain, times);
      }
    }
    for (const [domain, times] of domainTimes) {
      times.sort((a, b) => a - b);
      peakResponseTimes[domain] = times[Math.floor(times.length / 2)]!; // median
    }

    return {
      userId,
      activeHours: { start: startHour, end: endHour },
      peakResponseTimes,
      weekdayPatterns,
      urgencyThresholds: {},
    };
  }

  /**
   * Check if a timestamp falls within the user's active hours.
   */
  isActiveHour(profile: TemporalProfile, timestamp: Date): boolean {
    const hour = timestamp.getHours();
    if (profile.activeHours.start <= profile.activeHours.end) {
      return hour >= profile.activeHours.start && hour <= profile.activeHours.end;
    }
    // Wraps midnight
    return hour >= profile.activeHours.start || hour <= profile.activeHours.end;
  }

  private emptyProfile(userId: string): TemporalProfile {
    return {
      userId,
      activeHours: { start: 8, end: 22 },
      peakResponseTimes: {},
      weekdayPatterns: {},
      urgencyThresholds: {},
    };
  }
}
