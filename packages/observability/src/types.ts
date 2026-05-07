/**
 * Port interfaces for observability — all external I/O goes through these.
 *
 * The concrete implementation lives in @skytwin/db
 * (packages/db/src/repositories/mcp-server-metrics-repository.ts).
 * Mirrored types avoid a circular dependency between observability and db.
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

/** Port interface — implemented by mcpServerMetricsRepository in @skytwin/db. */
export interface McpServerMetricsRepository {
  writeBucket(input: WriteBucketInput): Promise<void>;
  getRecent(serverId: string, limit?: number): Promise<MetricsBucketRow[]>;
  getSparkline(serverId: string, hours?: number): Promise<SparklinePoint[]>;
}
