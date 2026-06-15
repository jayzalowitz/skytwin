import { describe, it, expect } from 'vitest';
import { buildDigest, type DigestItem } from '../digest.js';
import type { ResolvedEntity } from '../entity-linking.js';

function entity(p: Partial<ResolvedEntity> & Pick<ResolvedEntity, 'entityId' | 'signalRefs'>): ResolvedEntity {
  return {
    kind: 'person',
    normalized: p.entityId,
    surfaces: [],
    confidence: 0.9,
    ...p,
  };
}

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

describe('buildDigest — entity collapse (spec 05, #478 AC5)', () => {
  it('collapses one matter spanning 3 signals across 2 clusters into one line with 3 citations', () => {
    const items = [
      item({ ref: 's1', domain: 'work', text: 'Acme contract' }),
      item({ ref: 's2', domain: 'finance', text: 'Acme invoice' }),
      item({ ref: 's3', domain: 'work', text: 'Acme call notes' }),
    ];
    const entityLinks = [entity({ entityId: 'org:acme', kind: 'org', signalRefs: ['s1', 's2', 's3'] })];

    const d = buildDigest(items, { knownDomains: ['work', 'finance'], entityLinks });

    // The matter renders exactly once, not once per cluster.
    const allItems = d.topics.flatMap((t) => t.items);
    expect(allItems).toHaveLength(1);
    // ...with all three signals as citations.
    expect(allItems[0]!.signalRefs.sort()).toEqual(['s1', 's2', 's3']);
    // The canonical line is the first occurrence (work cluster comes first).
    expect(allItems[0]!.ref).toBe('s1');
    // No empty "husk" cluster left behind once finance's only signal collapsed.
    expect(d.topics.every((t) => t.items.length > 0)).toBe(true);
  });

  it('does NOT collapse when no entityLinks are supplied (ENTITY_LINKING=off parity)', () => {
    const items = [
      item({ ref: 's1', domain: 'work', text: 'Acme contract' }),
      item({ ref: 's2', domain: 'finance', text: 'Acme invoice' }),
    ];
    const d = buildDigest(items, { knownDomains: ['work', 'finance'] });
    expect(d.topics.flatMap((t) => t.items)).toHaveLength(2);
  });

  it('does NOT collapse signals linked only to a singleton entity (no false merge)', () => {
    const items = [
      item({ ref: 's1', domain: 'work', text: 'Acme contract' }),
      item({ ref: 's2', domain: 'work', text: 'Globex proposal' }),
    ];
    // Each entity touches exactly one signal — nothing to collapse.
    const entityLinks = [
      entity({ entityId: 'org:acme', kind: 'org', signalRefs: ['s1'] }),
      entity({ entityId: 'org:globex', kind: 'org', signalRefs: ['s2'] }),
    ];
    const d = buildDigest(items, { knownDomains: ['work'], entityLinks });
    expect(d.topics.flatMap((t) => t.items)).toHaveLength(2);
  });

  it('never collapses to-dos — each action-required item stays its own line', () => {
    const items = [
      item({ ref: 't1', actionRequired: true, urgency: 'high', text: 'Reply to Acme' }),
      item({ ref: 't2', actionRequired: true, urgency: 'high', text: 'Sign Acme contract' }),
    ];
    const entityLinks = [entity({ entityId: 'org:acme', kind: 'org', signalRefs: ['t1', 't2'] })];
    const d = buildDigest(items, { entityLinks });
    expect(d.todos.map((t) => t.ref).sort()).toEqual(['t1', 't2']);
    expect(d.todos.every((t) => t.signalRefs.length === 1)).toBe(true);
  });

  it('a PINNED mention is never collapsed away — it leads + owns the matter (#485 × #478)', () => {
    // Same matter, one cluster. Without a pin, s1 (first) would be the canonical
    // line. s2 is PINNED, so it sorts first, becomes the canonical line, and s1
    // folds INTO it — the user's pinned signal is never the one dropped.
    const items = [
      item({ ref: 's1', domain: 'work', text: 'Acme contract' }),
      item({ ref: 's2', domain: 'work', text: 'Acme invoice', meta: { userOverride: 'pinned' } }),
    ];
    const entityLinks = [entity({ entityId: 'org:acme', kind: 'org', signalRefs: ['s1', 's2'] })];
    const d = buildDigest(items, { knownDomains: ['work'], entityLinks });
    const allItems = d.topics.flatMap((t) => t.items);
    // Matter still renders once, but the canonical line is the PINNED signal.
    expect(allItems).toHaveLength(1);
    expect(allItems[0]!.ref).toBe('s2');
    expect(allItems[0]!.signalRefs.sort()).toEqual(['s1', 's2']);
  });

  it('picks the higher-citation entity as primary when a signal touches two', () => {
    const items = [
      item({ ref: 's1', domain: 'work', text: 'Acme + Bob' }),
      item({ ref: 's2', domain: 'work', text: 'Acme renewal' }),
      item({ ref: 's3', domain: 'finance', text: 'Bob lunch' }),
    ];
    // s1 touches both Acme (3 signals) and Bob (2 signals). Acme wins primary.
    const entityLinks = [
      entity({ entityId: 'org:acme', kind: 'org', signalRefs: ['s1', 's2', 's3'] }),
      entity({ entityId: 'person:bob@x', kind: 'person', signalRefs: ['s1', 's3'] }),
    ];
    const d = buildDigest(items, { knownDomains: ['work', 'finance'], entityLinks });
    const allItems = d.topics.flatMap((t) => t.items);
    // All three collapse under Acme (the 3-signal entity), one canonical line.
    expect(allItems).toHaveLength(1);
    expect(allItems[0]!.ref).toBe('s1');
    expect(allItems[0]!.signalRefs.sort()).toEqual(['s1', 's2', 's3']);
  });
});
