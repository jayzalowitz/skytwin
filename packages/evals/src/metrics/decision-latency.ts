/**
 * Decision latency metric.
 *
 * Tracks the time it takes to go from signal ingestion to
 * decision outcome. Reports P50, P90, P99 percentiles.
 */
export interface LatencyRecord {
  decisionId: string;
  latencyMs: number;
  domain: string;
  timestamp: Date;
}

export interface LatencyResult {
  totalDecisions: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  meanMs: number;
  maxMs: number;
  minMs: number;
}

/**
 * Decision latency tracker with percentile calculations.
 */
export class DecisionLatencyTracker {
  private records: LatencyRecord[] = [];

  record(entry: LatencyRecord): void {
    this.records.push({ ...entry });
  }

  calculate(domain?: string): LatencyResult {
    const filtered = domain
      ? this.records.filter(r => r.domain === domain)
      : this.records;

    if (filtered.length === 0) {
      return {
        totalDecisions: 0,
        p50Ms: 0,
        p90Ms: 0,
        p99Ms: 0,
        meanMs: 0,
        maxMs: 0,
        minMs: 0,
      };
    }

    const sorted = filtered.map(r => r.latencyMs).sort((a, b) => a - b);
    const total = sorted.length;

    return {
      totalDecisions: total,
      p50Ms: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
      p99Ms: percentile(sorted, 0.99),
      meanMs: sorted.reduce((s, v) => s + v, 0) / total,
      maxMs: sorted[total - 1]!,
      minMs: sorted[0]!,
    };
  }
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(p * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)]!;
}
