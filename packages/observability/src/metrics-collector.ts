/**
 * MetricsCollector — in-memory ring buffer of recent tool call outcomes.
 *
 * Records per-server telemetry: latency, success/failure, and spend.
 * The buffer is intentionally bounded (maxEntries) so the worker process
 * cannot accumulate unbounded memory between rollup ticks.
 *
 * Threshold constants are exported so the UI can display warning states
 * without hard-coding numbers that would require a rebuild to change.
 */

/** Fraction of max capacity that triggers a "near-full" log warning. */
export const BUFFER_NEAR_FULL_FRACTION = 0.8;

/** Warn threshold for success-rate UI display (fraction, 0–1). */
export const SUCCESS_RATE_WARN_THRESHOLD = 0.9;

/** Warn threshold for p95 latency (ms). */
export const LATENCY_P95_WARN_MS = 2000;

export interface ToolCallRecord {
  serverId: string;
  skillName: string;
  latencyMs: number;
  success: boolean;
  spendCents: number;
  ts: Date;
}

export interface MetricsCollectorOptions {
  /** Maximum entries to hold before oldest are evicted. Default: 10_000. */
  maxEntries?: number;
}

/**
 * Thread-unsafe (single-process, single-thread Node.js) ring buffer of
 * recent tool call records. Safe for the SkyTwin worker which is a single
 * Node process.
 */
export class MetricsCollector {
  private readonly buffer: ToolCallRecord[] = [];
  private readonly maxEntries: number;

  constructor(options: MetricsCollectorOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /**
   * Record a single tool call outcome.
   * Evicts the oldest entry when the buffer is full.
   */
  record(entry: ToolCallRecord): void {
    if (this.buffer.length >= this.maxEntries) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  /**
   * Drain all entries for a given server since `since` and clear them from the buffer.
   * Entries from other servers are left in place.
   */
  drainForServer(serverId: string, since: Date): ToolCallRecord[] {
    const drained: ToolCallRecord[] = [];
    let i = 0;
    while (i < this.buffer.length) {
      const entry = this.buffer[i];
      if (!entry) {
        i++;
        continue;
      }
      if (entry.serverId === serverId && entry.ts >= since) {
        drained.push(entry);
        this.buffer.splice(i, 1);
      } else {
        i++;
      }
    }
    return drained;
  }

  /**
   * Drain ALL entries since `since`, grouped by serverId.
   * Removes drained entries from the buffer.
   */
  drainAll(since: Date): Map<string, ToolCallRecord[]> {
    const byServer = new Map<string, ToolCallRecord[]>();
    const retained: ToolCallRecord[] = [];

    for (const entry of this.buffer) {
      if (entry.ts >= since) {
        let bucket = byServer.get(entry.serverId);
        if (!bucket) {
          bucket = [];
          byServer.set(entry.serverId, bucket);
        }
        bucket.push(entry);
      } else {
        retained.push(entry);
      }
    }

    this.buffer.length = 0;
    for (const e of retained) {
      this.buffer.push(e);
    }

    return byServer;
  }

  /** Snapshot of all current entries (for diagnostics). Does not drain. */
  snapshot(): ReadonlyArray<ToolCallRecord> {
    return this.buffer as ReadonlyArray<ToolCallRecord>;
  }

  /** Current number of buffered entries. */
  size(): number {
    return this.buffer.length;
  }
}
