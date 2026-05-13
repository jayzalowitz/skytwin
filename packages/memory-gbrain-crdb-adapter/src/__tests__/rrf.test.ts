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

  describe('with tierWeight (#251 Layer 2 — additive)', () => {
    function pageWithTier(id: string, tier: string): BrainPageRow {
      const p = makePage(id);
      return { ...p, metadata: { authoringTier: tier } };
    }

    it('flips a close call: rank-2 authored beats rank-1 newsletter with additive bonus', () => {
      // Both pages match equally on text — newsletter happens to rank
      // first. Without weighting newsletter wins; with a small additive
      // authored bonus, the close gap flips.
      const text = [
        { page: pageWithTier('newsletter', 'inbox_newsletter'), score: 1 },
        { page: pageWithTier('authored', 'user_sent_originated'), score: 0.99 },
      ];
      const pure = rrfFold(text, [], 5, 60);
      expect(pure[0]!.id).toBe('newsletter');

      const weighted = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const t = (meta as { authoringTier?: string } | null)?.authoringTier;
          if (t === 'user_sent_originated') return 0.005; // additive
          if (t === 'inbox_newsletter') return -0.004; // additive
          return 0;
        },
      });
      expect(weighted[0]!.id).toBe('authored');
    });

    it('does NOT let a weak-match authored page leapfrog a strong primary', () => {
      // Strong primary: rank 1 in BOTH lists → rrfScore ≈ 2/(60+1) = 0.0328.
      // Weak authored distractor: rank 20 in text only → rrfScore ≈
      // 1/(60+20) = 0.0125. Even with +0.005 authored bonus the weak
      // distractor lands at 0.0175, well below the primary's worst case
      // of 0.0328 + (any received bonus). The 0.85 floor-ratio gate also
      // prevents the bonus from applying at this rank (0.0125 < 0.85 ×
      // 0.0328 = 0.0279), so the bonus isn't even computed for it.
      const text = Array.from({ length: 20 }, (_, i) => ({
        page: pageWithTier(`text-${i}`, i === 19 ? 'user_sent_originated' : 'inbox_personal'),
        score: 1 - i * 0.01,
      }));
      const newsletter = pageWithTier('strong-newsletter', 'inbox_newsletter');
      text.unshift({ page: newsletter, score: 1 });
      const vec = [{ page: newsletter, score: 1 }];
      const out = rrfFold(text, vec, 25, 60, {
        tierWeight: (meta) => {
          const t = (meta as { authoringTier?: string } | null)?.authoringTier;
          if (t === 'user_sent_originated') return 0.005;
          if (t === 'inbox_newsletter') return -0.004;
          return 0;
        },
      });
      expect(out[0]!.id).toBe('strong-newsletter');
      const weakAuthoredIdx = out.findIndex((h) => h.id === 'text-19');
      expect(weakAuthoredIdx).toBeGreaterThan(0);
    });

    it('userOverride: hidden (NEGATIVE_INFINITY sentinel) drops the page entirely', () => {
      const text = [
        { page: pageWithTier('keep', 'inbox_personal'), score: 1 },
        { page: pageWithTier('hide-me', 'user_sent_originated'), score: 0.5 },
      ];
      const out = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const m = meta as { authoringTier?: string } | null;
          if (text.find((t) => t.page.id === 'hide-me')?.page.metadata === m)
            return Number.NEGATIVE_INFINITY;
          return 0;
        },
      });
      expect(out.map((h) => h.id)).not.toContain('hide-me');
      expect(out[0]!.id).toBe('keep');
    });

    it('coerces non-finite returns defensively (NaN/undefined → 0, no contribution)', () => {
      const text = [
        { page: pageWithTier('keep-nan', 'inbox_personal'), score: 1 },
        { page: pageWithTier('keep-undef', 'inbox_personal'), score: 0.9 },
      ];
      const out = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const m = meta as { authoringTier?: string } | null;
          if (m === text[0]!.page.metadata) return Number.NaN;
          if (m === text[1]!.page.metadata) return undefined as unknown as number;
          return 0;
        },
      });
      const ids = out.map((h) => h.id);
      // Both NaN and undefined → 0 contribution → page kept at raw rrfScore.
      expect(ids).toContain('keep-nan');
      expect(ids).toContain('keep-undef');
      for (const hit of out) {
        expect(Number.isFinite(hit.rrfScore)).toBe(true);
        expect(hit.rrfScore).toBeGreaterThan(0);
      }
    });

    it('preserves textRank/vectorRank even after additive bonus', () => {
      const text = [
        { page: pageWithTier('a', 'inbox_newsletter'), score: 1 },
        { page: pageWithTier('b', 'user_sent_originated'), score: 0.9 },
      ];
      const out = rrfFold(text, [], 5, 60, {
        tierWeight: (meta) => {
          const t = (meta as { authoringTier?: string } | null)?.authoringTier;
          return t === 'user_sent_originated' ? 0.005 : -0.004;
        },
      });
      const a = out.find((h) => h.id === 'a');
      const b = out.find((h) => h.id === 'b');
      // Raw text ranks survive even though the bonus reorders rrfScore.
      expect(a?.textRank).toBe(1);
      expect(b?.textRank).toBe(2);
      // b wins despite ranking #2 on text because of the additive bonus.
      expect(out[0]!.id).toBe('b');
    });
  });
});
