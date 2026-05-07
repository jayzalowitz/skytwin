import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryPromptCache } from '../cache.js';

describe('InMemoryPromptCache', () => {
  let cache: InMemoryPromptCache;

  beforeEach(() => {
    cache = new InMemoryPromptCache({ maxSize: 4, defaultTtlMs: 10_000 });
  });

  it('returns undefined for a missing key', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('stores and retrieves a value', async () => {
    await cache.set('k1', { data: 42 });
    const result = await cache.get('k1');
    expect(result).toEqual({ data: 42 });
  });

  it('stores and retrieves primitive values', async () => {
    await cache.set('str', 'hello');
    expect(await cache.get('str')).toBe('hello');

    await cache.set('num', 99);
    expect(await cache.get('num')).toBe(99);

    await cache.set('bool', false);
    expect(await cache.get('bool')).toBe(false);
  });

  it('returns undefined after TTL expires', async () => {
    vi.useFakeTimers();
    await cache.set('expiring', 'value', 1000);

    vi.advanceTimersByTime(999);
    expect(await cache.get('expiring')).toBe('value');

    vi.advanceTimersByTime(2);
    expect(await cache.get('expiring')).toBeUndefined();
    vi.useRealTimers();
  });

  it('evicts oldest entry when at capacity', async () => {
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    await cache.set('d', 4);
    // Now at maxSize=4; inserting one more should evict 'a'
    await cache.set('e', 5);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('e')).toBe(5);
  });

  it('reports correct size', async () => {
    expect(cache.size).toBe(0);
    await cache.set('x', 1);
    expect(cache.size).toBe(1);
  });

  it('clear() empties the cache', async () => {
    await cache.set('x', 1);
    await cache.set('y', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get('x')).toBeUndefined();
  });

  it('overwriting a key updates the value and TTL', async () => {
    vi.useFakeTimers();
    await cache.set('key', 'old', 500);
    vi.advanceTimersByTime(400);
    await cache.set('key', 'new', 10_000);
    vi.advanceTimersByTime(600);
    // old TTL would have expired; new one should still be alive
    expect(await cache.get('key')).toBe('new');
    vi.useRealTimers();
  });

  it('accepts null and undefined as values', async () => {
    await cache.set('null-val', null);
    expect(await cache.get('null-val')).toBeNull();
  });

  it('stores arrays', async () => {
    await cache.set('arr', [1, 2, 3]);
    expect(await cache.get('arr')).toEqual([1, 2, 3]);
  });
});
