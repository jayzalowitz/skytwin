import { describe, it, expect } from 'vitest';
import { isHidden, isPinned, filterVisible, sortPinnedFirst } from '../visibility-filter.js';

describe('isHidden (spec 11)', () => {
  it('true for userOverride=hidden', () => {
    expect(isHidden({ userOverride: 'hidden' })).toBe(true);
  });
  it('true for a hidden_at / hiddenAt timestamp (snake or camel)', () => {
    expect(isHidden({ hidden_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isHidden({ hiddenAt: new Date() })).toBe(true);
  });
  it('false for visible content, null, or undefined meta', () => {
    expect(isHidden({ userOverride: 'pinned' })).toBe(false);
    expect(isHidden({})).toBe(false);
    expect(isHidden(null)).toBe(false);
    expect(isHidden(undefined)).toBe(false);
  });
});

describe('isPinned (#270)', () => {
  it('true only for userOverride=pinned', () => {
    expect(isPinned({ userOverride: 'pinned' })).toBe(true);
  });
  it('false for non-pinned, null, or undefined meta', () => {
    expect(isPinned({})).toBe(false);
    expect(isPinned({ userOverride: 'hidden' })).toBe(false);
    expect(isPinned(null)).toBe(false);
    expect(isPinned(undefined)).toBe(false);
  });
  it('hidden always wins over a stray pinned signal (fail safe)', () => {
    // A page that is both hidden_at AND userOverride=pinned must not be pinned.
    expect(isPinned({ userOverride: 'pinned', hidden_at: 1 })).toBe(false);
  });
});

describe('filterVisible (spec 11)', () => {
  it('drops hidden items and preserves order', () => {
    const items = [
      { ref: 'a', meta: {} },
      { ref: 'b', meta: { userOverride: 'hidden' } },
      { ref: 'c', meta: { hidden_at: 1 } },
      { ref: 'd', meta: { userOverride: 'pinned' } },
    ];
    const visible = filterVisible(items, (i) => i.meta);
    expect(visible.map((i) => i.ref)).toEqual(['a', 'd']);
  });
});

describe('sortPinnedFirst (#270)', () => {
  it('moves pinned items to the front, preserving order within each group', () => {
    const items = [
      { ref: 'a', meta: {} },
      { ref: 'b', meta: { userOverride: 'pinned' } },
      { ref: 'c', meta: {} },
      { ref: 'd', meta: { userOverride: 'pinned' } },
    ];
    const sorted = sortPinnedFirst(items, (i) => i.meta);
    expect(sorted.map((i) => i.ref)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('is a no-op when nothing is pinned', () => {
    const items = [{ ref: 'a', meta: {} }, { ref: 'b', meta: null }];
    const sorted = sortPinnedFirst(items, (i) => i.meta);
    expect(sorted.map((i) => i.ref)).toEqual(['a', 'b']);
  });
  it('does not mutate the input array', () => {
    const items = [{ ref: 'a', meta: {} }, { ref: 'b', meta: { userOverride: 'pinned' } }];
    const before = items.map((i) => i.ref);
    sortPinnedFirst(items, (i) => i.meta);
    expect(items.map((i) => i.ref)).toEqual(before);
  });
});
