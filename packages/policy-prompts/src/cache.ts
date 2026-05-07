import type { PromptCache } from './types.js';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  insertedAt: number;
}

export class InMemoryPromptCache implements PromptCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(opts: { maxSize?: number; defaultTtlMs?: number } = {}) {
    this.maxSize = opts.maxSize ?? 512;
    this.defaultTtlMs = opts.defaultTtlMs ?? 3_600_000;
  }

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    if (this.store.size >= this.maxSize) {
      this.evictOldest();
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
      insertedAt: Date.now(),
    });
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.store.entries()) {
      if (v.insertedAt < oldestTime) {
        oldestTime = v.insertedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) {
      this.store.delete(oldestKey);
    }
  }
}
