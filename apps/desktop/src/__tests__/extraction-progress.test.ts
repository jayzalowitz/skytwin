import { describe, it, expect } from 'vitest';
import { extractionDone, extractionProgress } from '../extraction-progress.js';

describe('extractionProgress', () => {
  it('returns 0% / unpacking on a fresh run', () => {
    const p = extractionProgress(0, 10000);
    expect(p.percent).toBe(0);
    expect(p.phase).toBe('unpacking');
    expect(p.label).toContain('Unpacking');
  });

  it('caps at 99% even when filesExtracted matches totalFiles', () => {
    // The 100% / "Ready!" terminal state is owned by extractionDone(),
    // not by the counter — otherwise a still-flushing tar would land
    // the user on a black screen before extraction actually finishes.
    const p = extractionProgress(10000, 10000);
    expect(p.percent).toBe(99);
  });

  it('caps at 99% on counter overshoot (bsdtar trailing junk)', () => {
    const p = extractionProgress(12345, 10000);
    expect(p.percent).toBe(99);
    expect(p.phase).toBe('almost-ready');
  });

  it('switches to "almost-ready" once past 30%', () => {
    const below = extractionProgress(2999, 10000);
    const above = extractionProgress(3500, 10000);
    expect(below.phase).toBe('unpacking');
    expect(above.phase).toBe('almost-ready');
  });

  it('handles totalFiles = 0 (counter failed) with an unpacking 0% fallback', () => {
    const p = extractionProgress(123, 0);
    expect(p.percent).toBe(0);
    expect(p.phase).toBe('unpacking');
    expect(p.label).toContain('Unpacking');
  });

  it('clamps negative filesExtracted to zero', () => {
    const p = extractionProgress(-5, 100);
    expect(p.percent).toBe(0);
  });

  it('rejects non-finite totals gracefully', () => {
    expect(extractionProgress(50, Number.NaN).percent).toBe(0);
    expect(extractionProgress(50, Number.POSITIVE_INFINITY).phase).toBe('unpacking');
  });
});

describe('extractionDone', () => {
  it('returns the terminal 100% / ready state', () => {
    const p = extractionDone();
    expect(p.percent).toBe(100);
    expect(p.phase).toBe('ready');
    expect(p.label).toBe('Ready!');
  });
});
