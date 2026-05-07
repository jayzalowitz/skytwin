import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, SUCCESS_RATE_WARN_THRESHOLD, LATENCY_P95_WARN_MS } from '../metrics-collector.js';

function makeRecord(serverId: string, overrides?: Partial<{
  latencyMs: number;
  success: boolean;
  spendCents: number;
  ts: Date;
}>) {
  return {
    serverId,
    skillName: 'test-skill',
    latencyMs: overrides?.latencyMs ?? 100,
    success: overrides?.success ?? true,
    spendCents: overrides?.spendCents ?? 0,
    ts: overrides?.ts ?? new Date(),
  };
}

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector({ maxEntries: 10 });
  });

  it('records entries and reports correct size', () => {
    collector.record(makeRecord('server-1'));
    collector.record(makeRecord('server-2'));
    expect(collector.size()).toBe(2);
  });

  it('evicts oldest entry when buffer is full', () => {
    for (let i = 0; i < 10; i++) {
      collector.record(makeRecord('server-1', { latencyMs: i }));
    }
    expect(collector.size()).toBe(10);
    // add one more — should evict the oldest
    collector.record(makeRecord('server-1', { latencyMs: 99 }));
    expect(collector.size()).toBe(10);
    // oldest (latencyMs=0) should be gone
    const entries = collector.snapshot();
    expect(entries.some((e) => e.latencyMs === 0)).toBe(false);
    expect(entries.some((e) => e.latencyMs === 99)).toBe(true);
  });

  it('drainForServer removes only matching server entries since the given date', () => {
    const past = new Date(Date.now() - 10_000);
    const now = new Date();
    collector.record(makeRecord('server-A', { ts: past }));
    collector.record(makeRecord('server-A', { ts: now }));
    collector.record(makeRecord('server-B', { ts: now }));

    // drain server-A entries since past
    const drained = collector.drainForServer('server-A', past);
    expect(drained).toHaveLength(2);
    // server-B should remain
    expect(collector.size()).toBe(1);
    expect(collector.snapshot()[0]?.serverId).toBe('server-B');
  });

  it('drainAll groups entries by serverId and removes them', () => {
    const now = new Date();
    collector.record(makeRecord('alpha', { ts: now }));
    collector.record(makeRecord('alpha', { ts: now }));
    collector.record(makeRecord('beta', { ts: now }));

    const byServer = collector.drainAll();

    expect(byServer.size).toBe(2);
    expect(byServer.get('alpha')).toHaveLength(2);
    expect(byServer.get('beta')).toHaveLength(1);
    expect(collector.size()).toBe(0);
  });

  it('drainAll drains records of every age — older records are NOT retained', () => {
    // Regression: records older than (now - 60s) used to be left in the buffer
    // indefinitely. Now drainAll takes everything; the rollup service buckets
    // them by their actual minute via writeBucket's ON CONFLICT accumulation.
    const old = new Date(Date.now() - 120_000);
    const recent = new Date();
    collector.record(makeRecord('server-1', { ts: old }));
    collector.record(makeRecord('server-1', { ts: recent }));

    const byServer = collector.drainAll();

    expect(byServer.get('server-1')).toHaveLength(2);
    expect(collector.size()).toBe(0);
  });

  it('exports threshold constants with expected ranges', () => {
    expect(SUCCESS_RATE_WARN_THRESHOLD).toBeGreaterThan(0);
    expect(SUCCESS_RATE_WARN_THRESHOLD).toBeLessThanOrEqual(1);
    expect(LATENCY_P95_WARN_MS).toBeGreaterThan(0);
  });
});
