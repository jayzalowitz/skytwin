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
   * Flush all buffered tool call records into 1-minute DB buckets, grouped
   * by (serverId, minute) so records that span multiple minutes — including
   * older records left over from a missed rollup tick — bucket correctly.
   * Typically called by the worker job every 60s.
   *
   * The repository upserts on (server_id, bucket_started_at, bucket_duration)
   * with ON CONFLICT accumulation, so late-arriving records for an already-
   * written bucket safely add to the existing row.
   *
   * Returns the number of distinct (serverId, minute) buckets written.
   */
  async rollup(): Promise<number> {
    const byServer = this.collector.drainAll();

    if (byServer.size === 0) {
      return 0;
    }

    let written = 0;
    for (const [serverId, records] of byServer) {
      // Group this server's records by the minute they fall into so that a
      // single rollup() call can write multiple buckets for the same server
      // (e.g. on missed-tick recovery the buffer holds 2+ minutes of data).
      const byMinute = new Map<number, ToolCallRecord[]>();
      for (const record of records) {
        const minuteKey = roundToMinute(record.ts).getTime();
        let bucket = byMinute.get(minuteKey);
        if (!bucket) {
          bucket = [];
          byMinute.set(minuteKey, bucket);
        }
        bucket.push(record);
      }

      for (const [minuteKey, minuteRecords] of byMinute) {
        try {
          const bucket = aggregateRecords(minuteRecords);
          await this.repository.writeBucket({
            serverId,
            bucketStartedAt: new Date(minuteKey),
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
            bucketStartedAt: new Date(minuteKey).toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
  // Treat undefined as "unattributed" — sum only known costs. This was
  // implicitly NaN when callers omitted spendCents and the field became
  // optional; explicit ?? 0 makes the intent clear.
  const spendCents = records.reduce((sum, r) => sum + (r.spendCents ?? 0), 0);

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
