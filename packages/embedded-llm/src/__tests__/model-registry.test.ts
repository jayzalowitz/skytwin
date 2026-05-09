import { describe, expect, it } from 'vitest';
import {
  MODEL_REGISTRY,
  checkForUpgrade,
  findById,
  listByBracket,
  recommendDefault,
  type ModelEntry,
} from '../model-registry.js';

describe('MODEL_REGISTRY', () => {
  it('is a non-empty frozen list', () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
    expect(Object.isFrozen(MODEL_REGISTRY)).toBe(true);
  });

  it('every entry has a unique id', () => {
    const ids = new Set(MODEL_REGISTRY.map((m) => m.id));
    expect(ids.size).toBe(MODEL_REGISTRY.length);
  });

  it('every entry has plausible quality + size', () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.qualityScore).toBeGreaterThanOrEqual(0);
      expect(m.qualityScore).toBeLessThanOrEqual(100);
      expect(m.approxBytes).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });
});

describe('findById', () => {
  it('returns the matching entry', () => {
    const first = MODEL_REGISTRY[0]!;
    expect(findById(first.id)).toEqual(first);
  });

  it('returns null for unknown id', () => {
    expect(findById('does-not-exist')).toBeNull();
  });
});

describe('listByBracket', () => {
  it('returns only entries in the requested bracket', () => {
    const eight = listByBracket('8gb');
    expect(eight.length).toBeGreaterThan(0);
    for (const m of eight) {
      expect(m.ramBracket).toBe('8gb');
    }
  });

  it('returns a copy (mutation does not affect the registry)', () => {
    const list = listByBracket('8gb');
    const before = MODEL_REGISTRY.filter((m) => m.ramBracket === '8gb').length;
    list.pop();
    const after = MODEL_REGISTRY.filter((m) => m.ramBracket === '8gb').length;
    expect(before).toBe(after);
  });
});

describe('checkForUpgrade', () => {
  it('returns null when current model is unknown', () => {
    expect(checkForUpgrade('not-in-registry')).toBeNull();
  });

  it('returns null when current model is already best in bracket', () => {
    // Find the highest-quality model in any bracket and feed it back in.
    const buckets = new Set(MODEL_REGISTRY.map((m) => m.ramBracket));
    for (const b of buckets) {
      const inBracket = MODEL_REGISTRY.filter((m) => m.ramBracket === b);
      const best = inBracket.reduce((a, b) => (a.qualityScore > b.qualityScore ? a : b));
      expect(checkForUpgrade(best.id)).toBeNull();
    }
  });

  it('recommends a higher-quality model in the same bracket', () => {
    // Construct a synthetic registry so the test is independent of
    // the real model list's ordering.
    const synthRegistry: readonly ModelEntry[] = Object.freeze([
      {
        id: 'old',
        displayName: 'Old',
        ramBracket: '8gb',
        approxBytes: 2 * 1024 ** 3,
        contextWindow: 4096,
        qualityScore: 60,
        downloadUrl: 'https://example.com/old',
        sha256: '0'.repeat(64),
        version: 1,
      },
      {
        id: 'new',
        displayName: 'New',
        ramBracket: '8gb',
        approxBytes: 2 * 1024 ** 3,
        contextWindow: 4096,
        qualityScore: 85,
        downloadUrl: 'https://example.com/new',
        sha256: '1'.repeat(64),
        version: 1,
      },
    ]);
    const rec = checkForUpgrade('old', synthRegistry);
    expect(rec).not.toBeNull();
    expect(rec!.recommended.id).toBe('new');
    expect(rec!.qualityDeltaPct).toBeGreaterThan(0);
    expect(rec!.rationale).toContain('New');
  });

  it('does not cross brackets even when a better model exists in another bracket', () => {
    const synthRegistry: readonly ModelEntry[] = Object.freeze([
      {
        id: 'small',
        displayName: 'Small',
        ramBracket: '8gb',
        approxBytes: 2 * 1024 ** 3,
        contextWindow: 4096,
        qualityScore: 60,
        downloadUrl: 'x',
        sha256: '0'.repeat(64),
        version: 1,
      },
      {
        id: 'big',
        displayName: 'Big',
        ramBracket: '16gb',
        approxBytes: 9 * 1024 ** 3,
        contextWindow: 4096,
        qualityScore: 95,
        downloadUrl: 'x',
        sha256: '1'.repeat(64),
        version: 1,
      },
    ]);
    expect(checkForUpgrade('small', synthRegistry)).toBeNull();
  });

  it('picks the highest-scoring candidate when multiple upgrades exist', () => {
    const synth: readonly ModelEntry[] = Object.freeze([
      { id: 'a', displayName: 'A', ramBracket: '8gb', approxBytes: 2e9, contextWindow: 4096, qualityScore: 60, downloadUrl: 'x', sha256: '0'.repeat(64), version: 1 },
      { id: 'b', displayName: 'B', ramBracket: '8gb', approxBytes: 2e9, contextWindow: 4096, qualityScore: 75, downloadUrl: 'x', sha256: '0'.repeat(64), version: 1 },
      { id: 'c', displayName: 'C', ramBracket: '8gb', approxBytes: 2e9, contextWindow: 4096, qualityScore: 90, downloadUrl: 'x', sha256: '0'.repeat(64), version: 1 },
    ]);
    const rec = checkForUpgrade('a', synth);
    expect(rec!.recommended.id).toBe('c');
  });
});

describe('recommendDefault', () => {
  it('returns the highest-quality model in the bracket', () => {
    const def = recommendDefault('8gb');
    const inBracket = MODEL_REGISTRY.filter((m) => m.ramBracket === '8gb');
    const expected = inBracket.reduce((a, b) => (a.qualityScore > b.qualityScore ? a : b));
    expect(def.id).toBe(expected.id);
  });
});
