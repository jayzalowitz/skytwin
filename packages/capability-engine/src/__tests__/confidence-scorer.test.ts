import { describe, it, expect } from 'vitest';
import { scoreConfidence } from '../confidence-scorer.js';

describe('scoreConfidence', () => {
  it('returns 0 for zero evidence count', () => {
    expect(scoreConfidence(0, 0)).toBe(0);
  });

  it('returns 0 for negative evidence count', () => {
    expect(scoreConfidence(-1, 2)).toBe(0);
  });

  it('returns a low score for 1 mention / 1 kind', () => {
    const score = scoreConfidence(1, 1);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5);
  });

  it('returns a mid-range score for 3 mentions / 2 kinds', () => {
    const score = scoreConfidence(3, 2);
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.9);
  });

  it('caps at 1.0 for very high mention counts', () => {
    expect(scoreConfidence(100, 5)).toBe(1);
  });

  it('caps at 1.0 for extremely high counts and kinds', () => {
    expect(scoreConfidence(10_000, 100)).toBe(1);
  });

  it('score increases as evidence count increases (same kinds)', () => {
    expect(scoreConfidence(5, 2)).toBeGreaterThan(scoreConfidence(2, 2));
  });

  it('score increases as distinct kinds increase (same count)', () => {
    expect(scoreConfidence(3, 3)).toBeGreaterThan(scoreConfidence(3, 1));
  });
});
