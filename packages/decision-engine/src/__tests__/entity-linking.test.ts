import { describe, it, expect } from 'vitest';
import {
  extractEntities,
  resolveEntities,
  linkEntitiesAcrossSignals,
} from '../entity-linking.js';
import type { SignalText } from '../signal-text.js';

function sig(body: string, participants: string[] = [], title = ''): SignalText {
  return {
    source: 'gmail',
    title,
    body,
    authoredByUser: false,
    occurredAt: new Date('2026-03-01T00:00:00Z'),
    participants,
  };
}

describe('extractEntities (spec 05)', () => {
  it('extracts people from participant emails and orgs from suffix-tagged names', () => {
    const ents = extractEntities(sig('Kickoff with Acme Inc next week.', ['partner@acme.example']));
    expect(ents.some((e) => e.kind === 'person' && e.normalized === 'partner@acme.example')).toBe(true);
    expect(ents.some((e) => e.kind === 'org' && e.normalized === 'acme')).toBe(true);
  });
});

describe('resolveEntities — people merge on email (spec 05 AC1/AC2)', () => {
  it('two signals mentioning the same email resolve to ONE entity with both refs', () => {
    const resolved = linkEntitiesAcrossSignals([
      { ref: 's1', signal: sig('hi', ['alice@x.example']) },
      { ref: 's2', signal: sig('again', ['alice@x.example']) },
    ]);
    const people = resolved.filter((r) => r.kind === 'person');
    expect(people).toHaveLength(1);
    expect(people[0]!.signalRefs.sort()).toEqual(['s1', 's2']);
  });

  it('same display name but DIFFERENT emails resolve to TWO entities (no false merge)', () => {
    const resolved = linkEntitiesAcrossSignals([
      { ref: 's1', signal: sig('Alice says hi', ['alice@x.example']) },
      { ref: 's2', signal: sig('Alice says hi', ['alice@y.example']) },
    ]);
    expect(resolved.filter((r) => r.kind === 'person')).toHaveLength(2);
  });
});

describe('resolveEntities — orgs (conservative merge, spec 05 AC3)', () => {
  it('merges the same org across signals', () => {
    const resolved = linkEntitiesAcrossSignals([
      { ref: 's1', signal: sig('Acme Inc kickoff') },
      { ref: 's2', signal: sig('Acme Inc renewal') },
    ]);
    const orgs = resolved.filter((r) => r.kind === 'org');
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.signalRefs.sort()).toEqual(['s1', 's2']);
  });

  it('keeps clearly-different orgs separate (below the fuzzy floor → mint new)', () => {
    const resolved = linkEntitiesAcrossSignals([
      { ref: 's1', signal: sig('Acme Inc kickoff') },
      { ref: 's2', signal: sig('Globex LLC proposal') },
    ]);
    expect(resolved.filter((r) => r.kind === 'org')).toHaveLength(2);
  });

  it('a high floor forces a split rather than a risky merge (conservative)', () => {
    const ents = [
      { kind: 'org' as const, surface: 'Acme Global', normalized: 'acme global', signalRef: 's1', confidence: 0.8 },
      { kind: 'org' as const, surface: 'Acme Systems', normalized: 'acme systems', signalRef: 's2', confidence: 0.8 },
    ];
    // floor 0.9 → "acme global" vs "acme systems" share only "acme" → below → split
    expect(resolveEntities(ents, 0.9).filter((r) => r.kind === 'org')).toHaveLength(2);
  });
});

describe('linkEntitiesAcrossSignals — "everything touching X"', () => {
  it('aggregates all signal refs that touch a recurring entity', () => {
    const resolved = linkEntitiesAcrossSignals([
      { ref: 'email1', signal: sig('meet', ['p@acme.example']) },
      { ref: 'cal1', signal: sig('Acme Inc sync', ['p@acme.example']) },
      { ref: 'voice1', signal: sig('call p@acme.example about Acme Inc') },
    ]);
    const person = resolved.find((r) => r.entityId === 'person:p@acme.example')!;
    expect(person.signalRefs.sort()).toEqual(['cal1', 'email1', 'voice1']);
  });
});
