import { describe, it, expect } from 'vitest';
import type { RawSignal } from '@skytwin/connectors';
import { SignalDeduper, DEFAULT_TTL_MS, DEFAULT_MAX_PER_USER } from '../signal-dedupe.js';

function makeSignal(id: string, source = 'gmail'): RawSignal {
  return {
    id,
    source,
    type: 'email_received',
    data: {},
    timestamp: new Date(),
  };
}

describe('SignalDeduper', () => {
  it('returns false for an unseen signal', () => {
    const dedup = new SignalDeduper();
    expect(dedup.has(makeSignal('s1'), 'user1')).toBe(false);
  });

  it('returns true after a signal is marked', () => {
    const dedup = new SignalDeduper();
    const sig = makeSignal('s1');
    dedup.mark(sig, 'user1');
    expect(dedup.has(sig, 'user1')).toBe(true);
  });

  it('isolates dedupe state per user', () => {
    const dedup = new SignalDeduper();
    const sig = makeSignal('s1');
    dedup.mark(sig, 'user1');
    expect(dedup.has(sig, 'user2')).toBe(false);
  });

  it('isolates dedupe state by signal source', () => {
    const dedup = new SignalDeduper();
    // Same id, different source → different dedupe key
    const gmailSig = makeSignal('1', 'gmail');
    const slackSig = makeSignal('1', 'slack');
    dedup.mark(gmailSig, 'user1');
    expect(dedup.has(gmailSig, 'user1')).toBe(true);
    expect(dedup.has(slackSig, 'user1')).toBe(false);
  });

  it('expires entries past the TTL window', () => {
    let now = 1_000_000;
    const dedup = new SignalDeduper({ ttlMs: 1000, now: () => now });
    const sig = makeSignal('s1');

    dedup.mark(sig, 'user1');
    expect(dedup.has(sig, 'user1')).toBe(true);

    now += 999; // still within TTL
    expect(dedup.has(sig, 'user1')).toBe(true);

    now += 2; // past TTL
    expect(dedup.has(sig, 'user1')).toBe(false);
  });

  it('mark() is idempotent — calling twice does not double-count', () => {
    const dedup = new SignalDeduper();
    const sig = makeSignal('s1');
    dedup.mark(sig, 'user1');
    dedup.mark(sig, 'user1');
    expect(dedup.size('user1')).toBe(1);
  });

  it('reset() clears a single user without affecting others', () => {
    const dedup = new SignalDeduper();
    dedup.mark(makeSignal('s1'), 'user1');
    dedup.mark(makeSignal('s2'), 'user2');
    dedup.reset('user1');
    expect(dedup.size('user1')).toBe(0);
    expect(dedup.size('user2')).toBe(1);
  });

  // ── Eviction ─────────────────────────────────────────────────────

  it('drops expired entries first when over capacity', () => {
    let now = 0;
    const dedup = new SignalDeduper({ ttlMs: 100, maxPerUser: 5, now: () => now });

    // Insert 5 expired entries
    for (let i = 0; i < 5; i++) {
      dedup.mark(makeSignal(`old-${i}`), 'u');
    }
    now = 1000; // far past TTL

    // Insert one more — pushes size to 6, triggers eviction
    dedup.mark(makeSignal('new'), 'u');

    // All 5 expired entries should have been swept; only the fresh one survives
    expect(dedup.size('u')).toBe(1);
    expect(dedup.has(makeSignal('new'), 'u')).toBe(true);
  });

  it('drops oldest insertion-order entries when all are within TTL', () => {
    let now = 0;
    const dedup = new SignalDeduper({ ttlMs: 10_000, maxPerUser: 3, now: () => now });

    // Insert 3 entries within TTL
    for (let i = 0; i < 3; i++) {
      dedup.mark(makeSignal(`s${i}`), 'u');
      now += 1; // distinct timestamps for clarity
    }
    expect(dedup.size('u')).toBe(3);

    // Insert one more — exceeds cap, no expirations to sweep, oldest is dropped
    dedup.mark(makeSignal('newest'), 'u');

    // We had s0, s1, s2; insertion of newest pushes size to 4, evict drops s0
    expect(dedup.size('u')).toBe(3);
    expect(dedup.has(makeSignal('s0'), 'u')).toBe(false);
    expect(dedup.has(makeSignal('s1'), 'u')).toBe(true);
    expect(dedup.has(makeSignal('s2'), 'u')).toBe(true);
    expect(dedup.has(makeSignal('newest'), 'u')).toBe(true);
  });

  it('eviction does not run while size is at or below the cap', () => {
    let now = 0;
    const dedup = new SignalDeduper({ ttlMs: 1, maxPerUser: 5, now: () => now });

    for (let i = 0; i < 5; i++) dedup.mark(makeSignal(`s${i}`), 'u');
    now = 10_000; // entries are technically expired

    // Size is at the cap (5), so the eviction sweep does NOT run on insert.
    // Test the read path: has() still respects the TTL.
    expect(dedup.has(makeSignal('s0'), 'u')).toBe(false);
    // But the entries are still in the map until eviction triggers.
    expect(dedup.size('u')).toBe(5);
  });

  it('exposes default TTL and capacity constants', () => {
    expect(DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_MAX_PER_USER).toBe(5_000);
  });
});
