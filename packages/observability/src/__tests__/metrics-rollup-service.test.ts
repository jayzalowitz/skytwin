import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetricsCollector } from '../metrics-collector.js';
import { MetricsRollupService } from '../metrics-rollup-service.js';
import type { McpServerMetricsRepository, WriteBucketInput, MetricsBucketRow, SparklinePoint } from '../types.js';

function makeRepo(overrides?: Partial<McpServerMetricsRepository>): McpServerMetricsRepository {
  return {
    writeBucket: vi.fn().mockResolvedValue(undefined),
    getRecent: vi.fn().mockResolvedValue([] as MetricsBucketRow[]),
    getSparkline: vi.fn().mockResolvedValue([] as SparklinePoint[]),
    ...overrides,
  };
}

describe('MetricsRollupService', () => {
  let collector: MetricsCollector;
  let repo: McpServerMetricsRepository;
  let service: MetricsRollupService;

  beforeEach(() => {
    collector = new MetricsCollector({ maxEntries: 1000 });
    repo = makeRepo();
    service = new MetricsRollupService(collector, repo);
  });

  it('returns 0 and does not call writeBucket when buffer is empty', async () => {
    const written = await service.rollup();
    expect(written).toBe(0);
    expect(repo.writeBucket).not.toHaveBeenCalled();
  });

  it('calls writeBucket once per distinct server with records in the window', async () => {
    const ts = new Date();
    collector.record({ serverId: 'srv-1', skillName: 'foo', latencyMs: 50, success: true, spendCents: 0, ts });
    collector.record({ serverId: 'srv-1', skillName: 'bar', latencyMs: 200, success: false, spendCents: 5, ts });
    collector.record({ serverId: 'srv-2', skillName: 'baz', latencyMs: 100, success: true, spendCents: 1, ts });

    const written = await service.rollup();
    expect(written).toBe(2);
    expect(repo.writeBucket).toHaveBeenCalledTimes(2);
  });

  it('passes correct aggregated spend_cents to writeBucket', async () => {
    const ts = new Date();
    collector.record({ serverId: 'srv-1', skillName: 'foo', latencyMs: 100, success: true, spendCents: 3, ts });
    collector.record({ serverId: 'srv-1', skillName: 'bar', latencyMs: 200, success: true, spendCents: 7, ts });

    await service.rollup();

    const call = (repo.writeBucket as ReturnType<typeof vi.fn>).mock.calls[0] as [WriteBucketInput];
    expect(call[0].spendCents).toBe(10);
    expect(call[0].invocationsTotal).toBe(2);
    expect(call[0].invocationsFailed).toBe(0);
  });

  it('counts invocationsFailed correctly', async () => {
    const ts = new Date();
    collector.record({ serverId: 'srv-1', skillName: 'foo', latencyMs: 100, success: true, spendCents: 0, ts });
    collector.record({ serverId: 'srv-1', skillName: 'bar', latencyMs: 100, success: false, spendCents: 0, ts });
    collector.record({ serverId: 'srv-1', skillName: 'baz', latencyMs: 100, success: false, spendCents: 0, ts });

    await service.rollup();

    const call = (repo.writeBucket as ReturnType<typeof vi.fn>).mock.calls[0] as [WriteBucketInput];
    expect(call[0].invocationsFailed).toBe(2);
    expect(call[0].invocationsTotal).toBe(3);
  });

  it('drains the buffer after rollup so a second rollup finds nothing', async () => {
    const ts = new Date();
    collector.record({ serverId: 'srv-1', skillName: 'foo', latencyMs: 100, success: true, spendCents: 0, ts });

    await service.rollup();
    vi.mocked(repo.writeBucket).mockClear();

    const written2 = await service.rollup();
    expect(written2).toBe(0);
    expect(repo.writeBucket).not.toHaveBeenCalled();
  });

  it('continues rolling up other servers when one writeBucket call throws', async () => {
    const ts = new Date();
    collector.record({ serverId: 'bad-srv', skillName: 'foo', latencyMs: 100, success: true, spendCents: 0, ts });
    collector.record({ serverId: 'good-srv', skillName: 'bar', latencyMs: 100, success: true, spendCents: 0, ts });

    let callCount = 0;
    (repo.writeBucket as ReturnType<typeof vi.fn>).mockImplementation(async (input: WriteBucketInput) => {
      callCount++;
      if (input.serverId === 'bad-srv') throw new Error('DB error');
    });

    // Should not throw, should write 1 bucket (for good-srv)
    const written = await service.rollup();
    expect(written).toBe(1);
    expect(callCount).toBe(2); // both were attempted
  });

  it('missed-tick recovery: records spanning multiple minutes write per-minute buckets', async () => {
    // Regression: previously a missed rollup tick left old records stranded
    // in the buffer because drainAll filtered by `since = now - 60s`.
    const now = Date.now();
    const oldMinute = new Date(now - 180_000); // 3 minutes ago
    const recentMinute = new Date(now - 30_000); // 30 seconds ago

    collector.record({ serverId: 'srv-1', skillName: 'a', latencyMs: 100, success: true, spendCents: 0, ts: oldMinute });
    collector.record({ serverId: 'srv-1', skillName: 'b', latencyMs: 200, success: true, spendCents: 0, ts: oldMinute });
    collector.record({ serverId: 'srv-1', skillName: 'c', latencyMs: 50,  success: true, spendCents: 0, ts: recentMinute });

    const written = await service.rollup();

    // 1 server but 2 distinct minutes → 2 bucket rows
    expect(written).toBe(2);
    const calls = (repo.writeBucket as ReturnType<typeof vi.fn>).mock.calls as Array<[WriteBucketInput]>;
    const bucketStartTimes = calls.map((c) => c[0].bucketStartedAt.getTime());
    expect(new Set(bucketStartTimes).size).toBe(2);
    // Buffer is fully drained
    expect(collector.size()).toBe(0);
  });
});
