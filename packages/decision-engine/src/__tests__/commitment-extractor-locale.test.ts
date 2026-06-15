import { describe, it, expect, vi } from 'vitest';
import {
  extractCommitmentsLocaleAware,
  type CommitmentStrategy,
} from '../commitment-extractor.js';
import type { SignalText } from '../signal-text.js';

function authored(body: string, source = 'gmail', participants = ['a@x.com']): SignalText {
  return {
    source,
    title: '',
    body,
    authoringTier: source === 'voice' ? 'authored_originated' : 'user_sent_originated',
    occurredAt: new Date('2026-03-01T12:00:00Z'),
    authoredByUser: true,
    participants,
  };
}

describe('extractCommitmentsLocaleAware (#486 routing)', () => {
  it('English content via the rule fallback is NOT degraded (AC7, no regression)', () => {
    const r = extractCommitmentsLocaleAware(authored("I'll send the draft tomorrow."), {
      locale: 'en',
    });
    expect(r.degraded).toBeUndefined();
    expect(r.commitments).toHaveLength(1);
    expect(r.commitments[0]!.text).toBe('Send the draft tomorrow');
  });

  it('unset locale defaults to English — fallback runs un-degraded', () => {
    const r = extractCommitmentsLocaleAware(authored("I'll review it tonight."));
    expect(r.degraded).toBeUndefined();
    expect(r.commitments).toHaveLength(1);
  });

  it('non-English content on the rule fallback marks degraded:locale and logs (AC4)', () => {
    const log = vi.fn();
    // Spanish commitment the English regex cannot catch ("te lo envío mañana").
    const r = extractCommitmentsLocaleAware(authored('Te lo envío mañana.'), {
      locale: 'es',
      log,
    });
    expect(r.degraded).toBe('locale');
    // It does NOT silently return empty as if there were no commitments —
    // the degraded marker is the visible signal of the coverage gap.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ degraded: 'locale', locale: 'es' });
  });

  it('non-English content WITH an LLM strategy is handled natively, never degraded (AC3)', () => {
    const strategy: CommitmentStrategy = {
      extract: (input) =>
        input.body.includes('mañana')
          ? [
              {
                text: 'Send it tomorrow',
                rawSpan: input.body,
                deadlineHint: 'mañana',
                committedTo: input.participants,
                confidence: 0.9,
              },
            ]
          : [],
    };
    const log = vi.fn();
    const r = extractCommitmentsLocaleAware(authored('Te lo envío mañana.'), {
      locale: 'es',
      strategy,
      log,
    });
    expect(r.degraded).toBeUndefined();
    expect(r.commitments).toHaveLength(1);
    expect(r.commitments[0]!.text).toBe('Send it tomorrow');
    expect(log).not.toHaveBeenCalled();
  });

  it('respects authorship gating regardless of locale (safety #8)', () => {
    const inbound: SignalText = {
      source: 'gmail',
      title: '',
      body: 'Te lo envío mañana.',
      authoringTier: 'inbox_personal',
      authoredByUser: false,
      occurredAt: new Date('2026-03-01T12:00:00Z'),
      participants: [],
    };
    const r = extractCommitmentsLocaleAware(inbound, { locale: 'es' });
    expect(r.commitments).toEqual([]);
    expect(r.degraded).toBeUndefined();
  });
});
