import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyCache } from '../key-cache.js';
import { randomBytes } from 'node:crypto';

function makeKey(): Buffer {
  return randomBytes(32);
}

describe('KeyCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a key for a user', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });
    const key = makeKey();

    cache.set('user-1', key);

    const retrieved = cache.get('user-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.equals(key)).toBe(true);
  });

  it('returns null for an unknown user', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });
    expect(cache.get('nobody')).toBeNull();
  });

  it('has() returns true when key is present', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });
    cache.set('user-has', makeKey());
    expect(cache.has('user-has')).toBe(true);
  });

  it('has() returns false when key is absent', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });
    expect(cache.has('absent-user')).toBe(false);
  });

  it('evicts the key after TTL expires', () => {
    const ttlMs = 5_000;
    const cache = new KeyCache({ ttlMs });

    cache.set('user-ttl', makeKey());
    expect(cache.has('user-ttl')).toBe(true);

    // Advance time past TTL
    vi.advanceTimersByTime(ttlMs + 1);

    expect(cache.get('user-ttl')).toBeNull();
    expect(cache.has('user-ttl')).toBe(false);
  });

  it('evict() immediately removes the key (lock operation)', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });

    cache.set('user-lock', makeKey());
    expect(cache.has('user-lock')).toBe(true);

    cache.evict('user-lock');

    expect(cache.has('user-lock')).toBe(false);
    expect(cache.get('user-lock')).toBeNull();
  });

  it('evict() on a missing user is a no-op', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });
    expect(() => cache.evict('ghost-user')).not.toThrow();
  });

  it('clear() removes all cached keys', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });

    cache.set('user-a', makeKey());
    cache.set('user-b', makeKey());
    expect(cache.size()).toBe(2);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.has('user-a')).toBe(false);
    expect(cache.has('user-b')).toBe(false);
  });

  it('set() replaces an existing entry and resets TTL', () => {
    const ttlMs = 10_000;
    const cache = new KeyCache({ ttlMs });

    const key1 = makeKey();
    const key2 = makeKey();

    cache.set('user-replace', key1);
    expect(cache.get('user-replace')!.equals(key1)).toBe(true);

    // Advance partway through TTL
    vi.advanceTimersByTime(ttlMs / 2);

    // Replace the key — new TTL starts from now
    cache.set('user-replace', key2);
    expect(cache.get('user-replace')!.equals(key2)).toBe(true);

    // Advance to where the original would have expired (but new TTL keeps it alive)
    vi.advanceTimersByTime(ttlMs / 2 + 1);
    expect(cache.has('user-replace')).toBe(true);

    // Advance past the NEW TTL
    vi.advanceTimersByTime(ttlMs);
    expect(cache.has('user-replace')).toBe(false);
  });

  it('size() reflects current entry count', () => {
    const cache = new KeyCache({ ttlMs: 60_000 });

    expect(cache.size()).toBe(0);
    cache.set('u1', makeKey());
    expect(cache.size()).toBe(1);
    cache.set('u2', makeKey());
    expect(cache.size()).toBe(2);
    cache.evict('u1');
    expect(cache.size()).toBe(1);
  });
});
