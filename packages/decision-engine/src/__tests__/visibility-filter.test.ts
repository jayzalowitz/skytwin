import { describe, it, expect } from 'vitest';
import { isHidden, filterVisible } from '../visibility-filter.js';

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
