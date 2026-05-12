import { describe, it, expect } from 'vitest';
import { rrfFold } from '../rrf.js';
import type { BrainPageRow } from '../types.js';

const now = new Date('2026-05-09T00:00:00Z');

function makePage(id: string, content = ''): BrainPageRow {
  return {
    id,
    user_id: 'u1',
    title: '',
    content,
    source: 'note',
    source_ref: null,
    metadata: {},
    embedding: null,
    embedding_model: null,
    embedding_dim: null,
    created_at: now,
    updated_at: now,
  };
}

describe('rrfFold', () => {
  it('returns [] for empty inputs', () => {
    expect(rrfFold([], [], 10, 60)).toEqual([]);
  });

  it('orders single-list hits by their list rank', () => {
    const hits = [
      { page: makePage('a'), score: 0.9 },
      { page: makePage('b'), score: 0.8 },
      { page: makePage('c'), score: 0.7 },
    ];
    const out = rrfFold(hits, [], 3, 60);
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('rewards documents present in BOTH lists', () => {
    const text = [
      { page: makePage('only-text'), score: 1 },
      { page: makePage('both'), score: 0.5 },
    ];
    const vec = [
      { page: makePage('only-vec'), score: 1 },
      { page: makePage('both'), score: 0.5 },
    ];
    const out = rrfFold(text, vec, 3, 60);
    // 'both' appears in both lists and so should rank above the single-list ones.
    expect(out[0]!.id).toBe('both');
  });

  it('preserves textRank/vectorRank for observability', () => {
    const text = [
      { page: makePage('a'), score: 0.5 },
      { page: makePage('b'), score: 0.4 },
    ];
    const vec = [{ page: makePage('a'), score: 0.9 }];
    const out = rrfFold(text, vec, 5, 60);
    const a = out.find((h) => h.id === 'a');
    expect(a?.textRank).toBe(1);
    expect(a?.vectorRank).toBe(1);
    const b = out.find((h) => h.id === 'b');
    expect(b?.textRank).toBe(2);
    expect(b?.vectorRank).toBe(null);
  });

  it('limits output to top-k', () => {
    const hits = [];
    for (let i = 0; i < 50; i++) {
      hits.push({ page: makePage(`p${i}`), score: 1 - i * 0.01 });
    }
    expect(rrfFold(hits, [], 5, 60)).toHaveLength(5);
  });

  it('rrfK affects ranking curve', () => {
    const text = [
      { page: makePage('a'), score: 1 },
      { page: makePage('b'), score: 0.9 },
    ];
    const vec = [
      { page: makePage('c'), score: 1 },
      { page: makePage('a'), score: 0.5 },
    ];
    const lowK = rrfFold(text, vec, 3, 1);
    const highK = rrfFold(text, vec, 3, 1000);
    // Either way 'a' should win (it's in both), but the gap differs.
    expect(lowK[0]!.id).toBe('a');
    expect(highK[0]!.id).toBe('a');
    const lowGap = lowK[0]!.rrfScore - (lowK[1]?.rrfScore ?? 0);
    const highGap = highK[0]!.rrfScore - (highK[1]?.rrfScore ?? 0);
    // Lower k makes top-1 stand out more.
    expect(lowGap).toBeGreaterThan(highGap);
  });

  describe('with tierWeight (#251 Layer 2)', () => {
    function pageWithTier(id: string, tier: string): BrainPageRow {
      const p = makePage(id);
      return { ...p, metadata: { authoringTier: tier } };
    }

    it('flips ranking when a lower-base-rank authored page outweighs a top-rank newsletter', () => {
      // Both pages match the query equally on text — newsletter happens
      // to rank first (e.g. the corpus had more of them). Without tier
      // weighting newsletter wins; with normal-band weighting authored wins.
      const text = [
        { page: pageWithTier('newsletter', 'inbox_newsletter'), score: 1 },
        { page: pageWithTier('authored', 'user_sent_originated'), score: 0.99 },
      ];
      const pure = rrfFold(text, [], 5, 60);
      expect(pure[0]!.id).toBe('newsletter');

      const weighted = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const t = (meta as { authoringTier?: string } | null)?.authoringTier;
          if (t === 'user_sent_originated') return 1.5;
          if (t === 'inbox_newsletter') return 0.4;
          return 1.0;
        },
      });
      expect(weighted[0]!.id).toBe('authored');
    });

    it('userOverride: hidden (weight 0) drops the page entirely', () => {
      const text = [
        { page: pageWithTier('keep', 'inbox_personal'), score: 1 },
        { page: pageWithTier('hide-me', 'user_sent_originated'), score: 0.5 },
      ];
      const out = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const o = (meta as { id?: string; authoringTier?: string } | null);
          // simulate "the hide-me page was marked hidden"
          if (text.find((t) => t.page.id === 'hide-me')?.page.metadata === o)
            return 0;
          return 1.0;
        },
      });
      expect(out.map((h) => h.id)).not.toContain('hide-me');
      expect(out[0]!.id).toBe('keep');
    });

    it('coerces non-finite or negative weights defensively (NaN → 1.0, <0 → 0)', () => {
      const text = [
        { page: pageWithTier('keep-nan', 'inbox_personal'), score: 1 },
        { page: pageWithTier('keep-undef', 'inbox_personal'), score: 0.9 },
        { page: pageWithTier('drop-neg', 'inbox_personal'), score: 0.8 },
      ];
      const out = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const id = (meta as { authoringTier?: string } | null);
          // Return progressively misbehaving values; the fold must survive.
          if (id === text[0]!.page.metadata) return Number.NaN;
          if (id === text[1]!.page.metadata) return undefined as unknown as number;
          if (id === text[2]!.page.metadata) return -5;
          return 1;
        },
      });
      const ids = out.map((h) => h.id);
      // NaN and undefined → identity (kept); negative → dropped like 'hidden'.
      expect(ids).toContain('keep-nan');
      expect(ids).toContain('keep-undef');
      expect(ids).not.toContain('drop-neg');
      // rrfScore should be a finite number for survivors.
      for (const hit of out) {
        expect(Number.isFinite(hit.rrfScore)).toBe(true);
        expect(hit.rrfScore).toBeGreaterThan(0);
      }
    });

    it('preserves textRank/vectorRank even after weighting', () => {
      const text = [
        { page: pageWithTier('a', 'inbox_newsletter'), score: 1 },
        { page: pageWithTier('b', 'user_sent_originated'), score: 0.9 },
      ];
      const out = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const t = (meta as { authoringTier?: string } | null)?.authoringTier;
          return t === 'user_sent_originated' ? 1.5 : 0.4;
        },
      });
      const a = out.find((h) => h.id === 'a');
      const b = out.find((h) => h.id === 'b');
      // Raw text ranks survive even though the multiplier reorders rrfScore.
      expect(a?.textRank).toBe(1);
      expect(b?.textRank).toBe(2);
      // b wins despite ranking #2 on text because of the tier multiplier.
      expect(out[0]!.id).toBe('b');
    });
  });
});
