import { MetricsCollector } from './metrics-collector.js';

/**
 * Process-wide MetricsCollector singleton. Both the API process (which
 * records via the McpHost onToolCall hook) and the worker process (which
 * drains via MetricsRollupService) import this same instance so the buffer
 * is genuinely shared within a process.
 *
 * In a multi-process deployment each process has its own buffer; that is
 * intentional — buckets are upserted per (server_id, bucket_started_at,
 * bucket_duration), so concurrent rollups across processes accumulate
 * cleanly into the same bucket row.
 */
export const sharedMetricsCollector = new MetricsCollector({ maxEntries: 50_000 });
