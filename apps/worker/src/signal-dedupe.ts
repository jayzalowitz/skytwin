import type { RawSignal } from '@skytwin/connectors';

/**
 * In-memory deduplication for signals already forwarded to the API.
 *
 * Each user has its own Map<signalKey, seenAtMs> with two bounds:
 * - TTL: entries expire after `ttlMs`
 * - Capacity: when a user's map exceeds `maxPerUser`, expired entries
 *   are evicted first; if still over the cap, oldest insertion-order
 *   entries are dropped (rough LRU)
 *
 * Pure module — no globals, no side effects on import. Test it directly
 * by constructing a SignalDeduper with custom bounds and a clock.
 */

export interface DeduperOptions {
  ttlMs?: number;
  maxPerUser?: number;
  /** Time source — exposed so tests can advance it deterministically. */
  now?: () => number;
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_PER_USER = 5_000;

export class SignalDeduper {
  private readonly ttlMs: number;
  private readonly maxPerUser: number;
  private readonly now: () => number;
  private readonly seenByUser = new Map<string, Map<string, number>>();

  constructor(opts: DeduperOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerUser = opts.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.now = opts.now ?? Date.now;
  }

  /** True if this signal has been forwarded for this user within the TTL window. */
  has(signal: RawSignal, userId: string): boolean {
    const map = this.seenByUser.get(userId);
    if (!map) return false;
    const seenAt = map.get(this.key(signal));
    return Boolean(seenAt && this.now() - seenAt < this.ttlMs);
  }

  /** Record that a signal was forwarded for this user. */
  mark(signal: RawSignal, userId: string): void {
    const map = this.getOrCreate(userId);
    map.set(this.key(signal), this.now());
  }

  /** Test/observability helper: how many entries are currently held for a user. */
  size(userId: string): number {
    return this.seenByUser.get(userId)?.size ?? 0;
  }

  /** Test helper: drop a user's map entirely. */
  reset(userId: string): void {
    this.seenByUser.delete(userId);
  }

  /**
   * Drop dedupe state for any user not in `activeUserIds`. Used by the
   * worker's user-discovery loop to release memory when a user is no
   * longer tracked (e.g. their account was disconnected).
   */
  pruneUsers(activeUserIds: Set<string>): void {
    for (const userId of this.seenByUser.keys()) {
      if (!activeUserIds.has(userId)) {
        this.seenByUser.delete(userId);
      }
    }
  }

  /**
   * Compose the unique key for a signal. Source is included so that two
   * connectors with overlapping numeric ids (e.g. gmail and slack each
   * starting at "1") do not collide.
   */
  private key(signal: RawSignal): string {
    return `${signal.source}:${signal.id}`;
  }

  private getOrCreate(userId: string): Map<string, number> {
    let map = this.seenByUser.get(userId);
    if (!map) {
      map = new Map();
      this.seenByUser.set(userId, map);
    }

    // Pre-emptively evict when about to exceed the cap. Using >= here means
    // the cap is a hard ceiling: callers can't push the size above maxPerUser
    // even by one. Walking the map on every set would be O(n) per signal —
    // too costly under load — so the sweep only runs when the size is at the
    // cap and a new entry is about to land.
    if (map.size >= this.maxPerUser) {
      this.evict(map);
    }
    return map;
  }

  private evict(map: Map<string, number>): void {
    const cutoff = this.now() - this.ttlMs;

    // First pass: drop expired entries.
    for (const [k, seenAt] of map) {
      if (seenAt < cutoff) {
        map.delete(k);
      }
    }

    // Free at least one slot so the next insert lands within the cap.
    // Map iteration is insertion-ordered → the first key is the oldest.
    while (map.size >= this.maxPerUser && map.size > 0) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }
}
