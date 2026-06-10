import { describe, it, expect, vi } from 'vitest';
import { clusterSignals, type ClusterSignal } from '../topic-clusterer.js';

function sigs(...specs: Array<[string, string | null]>): ClusterSignal[] {
  return specs.map(([ref, domain]) => ({ ref, domain, subject: ref }));
}

const KNOWN = ['finance', 'work', 'health'];

function allRefs(clusters: ReturnType<typeof clusterSignals>): string[] {
  return clusters.flatMap((c) => c.signalRefs).sort();
}

describe('clusterSignals (spec 04)', () => {
  it('partitions every signal into exactly one cluster (completeness + no overlap)', () => {
    const input = sigs(['a', 'finance'], ['b', 'work'], ['c', 'finance'], ['d', 'health']);
    const clusters = clusterSignals(input, { knownDomains: KNOWN });
    expect(allRefs(clusters)).toEqual(['a', 'b', 'c', 'd']);
    const counts: Record<string, number> = {};
    for (const c of clusters) for (const r of c.signalRefs) counts[r] = (counts[r] ?? 0) + 1;
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
  });

  it('anchors known-domain signals to their domain; only no-fit goes to "other"', () => {
    const input = sigs(['a', 'finance'], ['b', 'astrology']); // astrology not known
    const clusters = clusterSignals(input, { knownDomains: KNOWN });
    const finance = clusters.find((c) => c.domain === 'finance')!;
    const other = clusters.find((c) => c.domain === 'other')!;
    expect(finance.signalRefs).toEqual(['a']);
    expect(other.signalRefs).toEqual(['b']);
    // a known-domain signal is never put in "other"
    expect(other.signalRefs).not.toContain('a');
  });

  it('never exceeds maxClusters and merges overflow into "More updates" (logged)', () => {
    const input = sigs(
      ['a', 'd1'], ['b', 'd2'], ['c', 'd3'], ['d', 'd4'], ['e', 'd5'],
    );
    const onMerge = vi.fn();
    const clusters = clusterSignals(input, { maxClusters: 3, onMerge });
    expect(clusters.length).toBeLessThanOrEqual(3);
    expect(allRefs(clusters)).toEqual(['a', 'b', 'c', 'd', 'e']); // nothing dropped
    expect(clusters.some((c) => c.domain === 'other')).toBe(true);
    expect(onMerge).toHaveBeenCalled();
  });

  it('falls back to grouping by tagged domain when no knownDomains given', () => {
    const input = sigs(['a', 'travel'], ['b', 'travel'], ['c', 'shopping']);
    const clusters = clusterSignals(input, {});
    const travel = clusters.find((c) => c.domain === 'travel')!;
    expect(travel.signalRefs.sort()).toEqual(['a', 'b']);
    expect(clusters.find((c) => c.domain === 'shopping')!.signalRefs).toEqual(['c']);
  });

  it('routes null-domain signals to "other"', () => {
    const clusters = clusterSignals(sigs(['a', null], ['b', 'finance']), { knownDomains: KNOWN });
    expect(clusters.find((c) => c.domain === 'other')!.signalRefs).toEqual(['a']);
  });

  it('gives known-domain clusters higher confidence than "other"', () => {
    const clusters = clusterSignals(sigs(['a', 'finance'], ['b', null]), { knownDomains: KNOWN });
    const finance = clusters.find((c) => c.domain === 'finance')!;
    const other = clusters.find((c) => c.domain === 'other')!;
    expect(finance.confidence).toBeGreaterThan(other.confidence);
  });
});
