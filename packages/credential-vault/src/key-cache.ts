/**
 * key-cache.ts — in-process derived-key cache.
 *
 * Derived keys are expensive to compute (scrypt). The KeyCache stores them
 * in memory for a configurable TTL, then evicts them automatically.
 *
 * Security constraints:
 *   - Keys are NEVER persisted to disk or any external store.
 *   - Keys are evicted after TTL expires.
 *   - Calling lock() immediately evicts the key for a given user.
 */

export interface KeyCacheOptions {
  /** Time-to-live for a cached key, in milliseconds. Default: 1 hour. */
  ttlMs?: number;
}

interface CacheEntry {
  key: Buffer;
  expiresAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * In-process cache of per-user scrypt-derived AES keys.
 *
 * One instance should be used as a module-level singleton per process.
 * The API routes share a single KeyCache instance to avoid per-request
 * key derivation while still evicting after TTL.
 */
export class KeyCache {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: KeyCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000; // 1 hour default
  }

  /**
   * Store a derived key for the given userId.
   * Any existing entry is evicted first (its timeout is cleared).
   */
  set(userId: string, key: Buffer): void {
    this.evict(userId);

    const expiresAt = Date.now() + this.ttlMs;
    const timeoutHandle = setTimeout(() => {
      this.evict(userId);
    }, this.ttlMs);

    // Allow Node to exit even if a key is cached
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    this.cache.set(userId, { key, expiresAt, timeoutHandle });
  }

  /**
   * Retrieve the cached key for userId, or null if not present or expired.
   */
  get(userId: string): Buffer | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.evict(userId);
      return null;
    }
    return entry.key;
  }

  /**
   * Check whether a key for userId is currently cached (vault is unlocked).
   */
  has(userId: string): boolean {
    return this.get(userId) !== null;
  }

  /**
   * Immediately evict the key for userId (vault lock operation).
   */
  evict(userId: string): void {
    const entry = this.cache.get(userId);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      this.cache.delete(userId);
    }
  }

  /**
   * Evict all cached keys (useful during shutdown or testing).
   */
  clear(): void {
    for (const userId of this.cache.keys()) {
      this.evict(userId);
    }
  }

  /** Number of currently cached entries (for testing/observability). */
  size(): number {
    return this.cache.size;
  }
}
