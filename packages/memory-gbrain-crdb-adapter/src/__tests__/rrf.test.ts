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
});
