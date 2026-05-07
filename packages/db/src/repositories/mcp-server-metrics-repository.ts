import { query } from '../connection.js';

/**
 * Repository for mcp_server_metrics — per-server 1-minute rollup buckets.
 *
 * Schema: packages/db/src/migrations/027-capability-acquisition.sql
 * Issue #183 — observability.
 */

export interface WriteBucketInput {
  serverId: string;
  bucketStartedAt: Date;
  bucketDuration: '1m' | '1h' | '1d';
  invocationsTotal: number;
  invocationsFailed: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  bytesIn: number;
  bytesOut: number;
  spendCents: number;
}

export interface MetricsBucketRow {
  server_id: string;
  bucket_started_at: Date;
  bucket_duration: string;
  invocations_total: number;
  invocations_failed: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  bytes_in: number;
  bytes_out: number;
  spend_cents: number;
}

export interface SparklinePoint {
  bucketStartedAt: Date;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  successRate: number;
}

export const mcpServerMetricsRepository = {
  /**
   * Upsert a metrics bucket.
   * ON CONFLICT updates aggregate columns; existing rows accumulate counts.
   */
  async writeBucket(input: WriteBucketInput): Promise<void> {
    await query(
      `INSERT INTO mcp_server_metrics
         (server_id, bucket_started_at, bucket_duration,
          invocations_total, invocations_failed,
          latency_p50_ms, latency_p95_ms, latency_p99_ms,
          bytes_in, bytes_out, spend_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (server_id, bucket_started_at, bucket_duration)
       DO UPDATE SET
         invocations_total  = mcp_server_metrics.invocations_total  + EXCLUDED.invocations_total,
         invocations_failed = mcp_server_metrics.invocations_failed + EXCLUDED.invocations_failed,
         latency_p50_ms     = EXCLUDED.latency_p50_ms,
         latency_p95_ms     = EXCLUDED.latency_p95_ms,
         latency_p99_ms     = EXCLUDED.latency_p99_ms,
         bytes_in           = mcp_server_metrics.bytes_in  + EXCLUDED.bytes_in,
         bytes_out          = mcp_server_metrics.bytes_out + EXCLUDED.bytes_out,
         spend_cents        = mcp_server_metrics.spend_cents + EXCLUDED.spend_cents`,
      [
        input.serverId,
        input.bucketStartedAt,
        input.bucketDuration,
        input.invocationsTotal,
        input.invocationsFailed,
        input.latencyP50Ms,
        input.latencyP95Ms,
        input.latencyP99Ms,
        input.bytesIn,
        input.bytesOut,
        input.spendCents,
      ],
    );
  },

  /**
   * Return the N most recent bucket rows for a given server (any duration).
   */
  async getRecent(serverId: string, limit = 60): Promise<MetricsBucketRow[]> {
    const result = await query<MetricsBucketRow>(
      `SELECT server_id, bucket_started_at, bucket_duration,
              invocations_total, invocations_failed,
              latency_p50_ms, latency_p95_ms, latency_p99_ms,
              bytes_in, bytes_out, spend_cents
       FROM mcp_server_metrics
       WHERE server_id = $1
       ORDER BY bucket_started_at DESC
       LIMIT $2`,
      [serverId, limit],
    );
    return result.rows;
  },

  /**
   * Return sparkline data points for the last `hours` hours, using 1-minute buckets.
   */
  async getSparkline(serverId: string, hours = 24): Promise<SparklinePoint[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const result = await query<MetricsBucketRow>(
      `SELECT server_id, bucket_started_at, bucket_duration,
              invocations_total, invocations_failed,
              latency_p50_ms, latency_p95_ms, latency_p99_ms,
              bytes_in, bytes_out, spend_cents
       FROM mcp_server_metrics
       WHERE server_id = $1
         AND bucket_duration = '1m'
         AND bucket_started_at >= $2
       ORDER BY bucket_started_at ASC`,
      [serverId, since],
    );

    return result.rows.map((row): SparklinePoint => {
      const total = row.invocations_total;
      const failed = row.invocations_failed;
      const successRate = total > 0 ? (total - failed) / total : 1;
      return {
        bucketStartedAt: row.bucket_started_at,
        latencyP50Ms: row.latency_p50_ms,
        latencyP95Ms: row.latency_p95_ms,
        successRate,
      };
    });
  },
};
