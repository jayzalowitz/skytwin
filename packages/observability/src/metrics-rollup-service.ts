import { createLogger } from '@skytwin/core';
import type { MetricsCollector, ToolCallRecord } from './metrics-collector.js';
import type { McpServerMetricsRepository } from './types.js';

const log = createLogger('observability:metrics-rollup');

/** Duration label for the 1-minute bucket. */
const BUCKET_DURATION = '1m' as const;

/**
 * MetricsRollupService — drains the in-memory MetricsCollector buffer and
 * writes 1-minute rollup rows to mcp_server_metrics.
 *
 * The rollup service is intentionally stateless: each call to rollup()
 * is idempotent given that the repository upserts on the composite PK
 * (server_id, bucket_started_at, bucket_duration).
 */
export class MetricsRollupService {
  constructor(
    private readonly collector: MetricsCollector,
    private readonly repository: McpServerMetricsRepository,
  ) {}

  /**
   * Flush all buffered tool call records into 1-minute DB buckets.
   * Typically called by the worker job every 60s.
   *
   * Returns the number of distinct server buckets written.
   */
  async rollup(): Promise<number> {
    const since = new Date(Date.now() - 60 * 1000);
    const byServer = this.collector.drainAll(since);

    if (byServer.size === 0) {
      return 0;
    }

    let written = 0;
    for (const [serverId, records] of byServer) {
      try {
        const bucket = aggregateRecords(records);
        const bucketStartedAt = roundToMinute(records[0]?.ts ?? new Date());

        await this.repository.writeBucket({
          serverId,
          bucketStartedAt,
          bucketDuration: BUCKET_DURATION,
          invocationsTotal: bucket.total,
          invocationsFailed: bucket.failed,
          latencyP50Ms: bucket.p50,
          latencyP95Ms: bucket.p95,
          latencyP99Ms: bucket.p99,
          bytesIn: 0,
          bytesOut: 0,
          spendCents: bucket.spendCents,
        });
        written++;
      } catch (err) {
        log.warn('Failed to write metrics bucket', {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (written > 0) {
      log.info(`Metrics rollup: wrote ${written} bucket(s)`);
    }

    return written;
  }
}

/**
 * Compute aggregate stats from a list of records for one server.
 */
function aggregateRecords(records: ToolCallRecord[]): {
  total: number;
  failed: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  spendCents: number;
} {
  const total = records.length;
  const failed = records.filter((r) => !r.success).length;
  const spendCents = records.reduce((sum, r) => sum + r.spendCents, 0);

  const latencies = records.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    total,
    failed,
    p50: latencies.length > 0 ? percentile(latencies, 0.5) : null,
    p95: latencies.length > 0 ? percentile(latencies, 0.95) : null,
    p99: latencies.length > 0 ? percentile(latencies, 0.99) : null,
    spendCents,
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  const clamped = Math.min(idx, sorted.length - 1);
  return sorted[clamped] ?? 0;
}

function roundToMinute(d: Date): Date {
  const ms = d.getTime();
  return new Date(ms - (ms % 60_000));
}
