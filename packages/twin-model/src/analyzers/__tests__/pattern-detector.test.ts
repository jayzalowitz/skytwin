import { describe, it, expect } from 'vitest';
import { PatternDetector } from '../pattern-detector.js';
import type { TwinEvidence } from '@skytwin/shared-types';

function makeEvidence(
  overrides: Partial<TwinEvidence> & { userId?: string },
  count: number,
): TwinEvidence[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ev_${i}`,
    userId: overrides.userId ?? 'user1',
    source: overrides.source ?? 'email',
    type: overrides.type ?? 'newsletter',
    data: overrides.data ?? { action: 'archive' },
    domain: overrides.domain ?? 'email',
    timestamp: new Date(Date.now() - i * 86400000),
  }));
}

describe('PatternDetector', () => {
  const detector = new PatternDetector();

  it('does not create pattern with fewer than 3 occurrences', () => {
    const evidence = makeEvidence({ source: 'email', type: 'newsletter' }, 2);
    const patterns = detector.detectHabits(evidence, []);
    expect(patterns).toHaveLength(0);
  });

  it('creates a habit pattern with 3+ occurrences', () => {
    const evidence = makeEvidence({
      source: 'email',
      type: 'newsletter',
      data: { action: 'archive' },
      domain: 'email',
    }, 5);

    const patterns = detector.detectHabits(evidence, []);
    expect(patterns.length).toBeGreaterThanOrEqual(1);

    const habit = patterns.find((p) => p.observedAction === 'archive');
    expect(habit).toBeDefined();
    expect(habit!.frequency).toBe(5);
    expect(habit!.patternType).toBe('habit');
  });

  it('creates contextual pattern when same sender', () => {
    const evidence = makeEvidence({
      source: 'email',
      type: 'newsletter',
      data: { action: 'archive', from: 'news@example.com' },
      domain: 'email',
    }, 4);

    const patterns = detector.detectHabits(evidence, []);
    const contextual = patterns.find((p) => p.trigger.senderPattern);
    expect(contextual).toBeDefined();
    expect(contextual!.trigger.senderPattern).toBe('news@example.com');
    expect(contextual!.patternType).toBe('contextual');
  });

  it('updates existing patterns instead of duplicating', () => {
    const existingPatterns = detector.detectHabits(
      makeEvidence({ source: 'email', type: 'newsletter', data: { action: 'archive' }, domain: 'email' }, 5),
      [],
    );

    const moreEvidence = makeEvidence({
      source: 'email',
      type: 'newsletter',
      data: { action: 'archive' },
      domain: 'email',
    }, 10);

    const updated = detector.detectHabits(moreEvidence, existingPatterns);
    const archivePatterns = updated.filter((p) => p.observedAction === 'archive');
    expect(archivePatterns).toHaveLength(1);
    expect(archivePatterns[0]!.frequency).toBe(10);
  });

  it('assigns confidence based on frequency', () => {
    const low = detector.detectHabits(
      makeEvidence({ data: { action: 'label' }, domain: 'email' }, 3),
      [],
    );
    expect(low[0]?.confidence).toBe('low');

    const high = detector.detectHabits(
      makeEvidence({ data: { action: 'label' }, domain: 'email' }, 10),
      [],
    );
    expect(high[0]?.confidence).toBe('high');
  });
});
