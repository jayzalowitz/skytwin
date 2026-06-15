import { describe, it, expect } from 'vitest';
import { buildDigest, type DigestItem } from '../digest.js';

function item(p: Partial<DigestItem> & Pick<DigestItem, 'ref'>): DigestItem {
  return {
    text: p.ref,
    actionRequired: false,
    domain: 'work',
    ...p,
  };
}

describe('buildDigest (spec 01)', () => {
  it('splits action-required to-dos from FYI topics with no overlap (AC1/AC2)', () => {
    const items = [
      item({ ref: 't1', actionRequired: true, domain: 'work' }),
      item({ ref: 't2', actionRequired: true, domain: 'finance' }),
      item({ ref: 't3', actionRequired: true, domain: 'work' }),
      ...Array.from({ length: 7 }, (_, i) => item({ ref: `f${i}`, domain: i % 2 ? 'finance' : 'work' })),
    ];
    const d = buildDigest(items, { knownDomains: ['work', 'finance'] });
    expect(d.todos).toHaveLength(3);
    const topicRefs = d.topics.flatMap((t) => t.items.map((i) => i.ref));
    expect(topicRefs).toHaveLength(7);
    // no overlap
    const todoRefs = d.todos.map((t) => t.ref);
    expect(topicRefs.some((r) => todoRefs.includes(r))).toBe(false);
  });

  it('urgency-orders to-dos and caps at maxTodos (AC1)', () => {
    const items = [
      item({ ref: 'low', actionRequired: true, urgency: 'low' }),
      item({ ref: 'crit', actionRequired: true, urgency: 'critical' }),
      item({ ref: 'med', actionRequired: true, urgency: 'medium' }),
      item({ ref: 'high', actionRequired: true, urgency: 'high' }),
    ];
    const d = buildDigest(items, { maxTodos: 3 });
    expect(d.todos.map((t) => t.ref)).toEqual(['crit', 'high', 'med']);
  });

  it('drops hidden items before partitioning (spec 11 wired)', () => {
    const items = [
      item({ ref: 'visible', actionRequired: true }),
      item({ ref: 'hidden-todo', actionRequired: true, meta: { userOverride: 'hidden' } }),
      item({ ref: 'hidden-fyi', meta: { hidden_at: 1 } }),
      item({ ref: 'visible-fyi' }),
    ];
    const d = buildDigest(items);
    const allRefs = [...d.todos.map((t) => t.ref), ...d.topics.flatMap((t) => t.items.map((i) => i.ref))];
    expect(allRefs).toContain('visible');
    expect(allRefs).toContain('visible-fyi');
    expect(allRefs).not.toContain('hidden-todo');
    expect(allRefs).not.toContain('hidden-fyi');
  });

  it('surfaces a pinned to-do ahead of higher-urgency unpinned ones (#270/#485)', () => {
    const items = [
      item({ ref: 'crit', actionRequired: true, urgency: 'critical' }),
      item({ ref: 'pinned-low', actionRequired: true, urgency: 'low', meta: { userOverride: 'pinned' } }),
      item({ ref: 'high', actionRequired: true, urgency: 'high' }),
    ];
    const d = buildDigest(items);
    // Pinned-first is the primary key; urgency only breaks ties within a group.
    expect(d.todos.map((t) => t.ref)).toEqual(['pinned-low', 'crit', 'high']);
  });

  it('keeps urgency order among to-dos when none are pinned (no regression)', () => {
    const items = [
      item({ ref: 'low', actionRequired: true, urgency: 'low' }),
      item({ ref: 'crit', actionRequired: true, urgency: 'critical' }),
    ];
    const d = buildDigest(items);
    expect(d.todos.map((t) => t.ref)).toEqual(['crit', 'low']);
  });

  it('surfaces a pinned FYI item ahead of unpinned ones in its topic (#270)', () => {
    const items = [
      item({ ref: 'a', domain: 'finance' }),
      item({ ref: 'pinned', domain: 'finance', meta: { userOverride: 'pinned' } }),
      item({ ref: 'b', domain: 'finance' }),
    ];
    const d = buildDigest(items, { knownDomains: ['finance'] });
    const finance = d.topics.find((t) => t.domain === 'finance')!;
    expect(finance.items[0]!.ref).toBe('pinned');
  });

  it('carries sourceType + deadline onto to-dos (spec 07/03 for the UI)', () => {
    const d = buildDigest([
      item({ ref: 'x', actionRequired: true, sourceType: 'voice', deadline: '2026-03-05' }),
    ]);
    expect(d.todos[0]).toMatchObject({ ref: 'x', sourceType: 'voice', deadline: '2026-03-05' });
  });

  it('emits signalRefs[] for citation chips (review #4: UI + v2 prompt expect an array)', () => {
    const d = buildDigest([
      item({ ref: 'a', actionRequired: true }),
      item({ ref: 'b', domain: 'work' }),
    ], { knownDomains: ['work'] });
    expect(d.todos[0]!.signalRefs).toEqual(['a']);
    expect(d.topics[0]!.items[0]!.signalRefs).toEqual(['b']);
  });

  it('groups topics by domain', () => {
    const d = buildDigest(
      [item({ ref: 'a', domain: 'finance' }), item({ ref: 'b', domain: 'finance' }), item({ ref: 'c', domain: 'work' })],
      { knownDomains: ['finance', 'work'] },
    );
    const finance = d.topics.find((t) => t.domain === 'finance')!;
    expect(finance.items.map((i) => i.ref).sort()).toEqual(['a', 'b']);
  });
});
