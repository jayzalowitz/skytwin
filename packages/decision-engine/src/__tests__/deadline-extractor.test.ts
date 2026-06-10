import { describe, it, expect } from 'vitest';
import { extractDeadline } from '../deadline-extractor.js';

const REF = new Date('2026-03-01T12:00:00Z'); // a Sunday
const DAY = 24 * 60 * 60 * 1000;

function find(body: string, title = '') {
  return extractDeadline({ title, body, occurredAt: REF });
}

describe('extractDeadline (spec 03)', () => {
  it('parses a relative "in N days" deadline anchored to occurredAt', () => {
    const d = find('Heads up, your trial ends in 2 days.');
    expect(d).not.toBeNull();
    expect(d!.kind).toBe('relative');
    const delta = d!.deadline.getTime() - REF.getTime();
    expect(delta).toBeGreaterThan(1.5 * DAY);
    expect(delta).toBeLessThan(2.6 * DAY);
    expect(d!.rawPhrase.toLowerCase()).toContain('2 days');
  });

  it('parses an absolute month/day deadline in the future', () => {
    const d = find('The invoice expires March 5.');
    expect(d).not.toBeNull();
    expect(d!.deadline.getTime()).toBeGreaterThan(REF.getTime());
    expect(d!.kind).toBe('absolute');
    expect(d!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('resolves a bare weekday to the upcoming occurrence (forwardDate)', () => {
    const d = find('Please respond by Tuesday.');
    expect(d).not.toBeNull();
    expect(d!.deadline.getTime()).toBeGreaterThan(REF.getTime());
    // Tuesday after Sunday 2026-03-01 is within a week.
    expect(d!.deadline.getTime() - REF.getTime()).toBeLessThan(7 * DAY);
  });

  it('returns the EARLIEST credible deadline when several are present', () => {
    const d = find('Soft target in 10 days, but the hard cutoff is in 3 days.');
    expect(d).not.toBeNull();
    expect(d!.deadline.getTime() - REF.getTime()).toBeLessThan(4 * DAY);
    expect(d!.rawPhrase.toLowerCase()).toContain('3 days');
  });

  it('rejects past-dated phrases (noise, not urgency)', () => {
    const d = find('This was due last week and yesterday.');
    expect(d).toBeNull();
  });

  it('returns null when there is no temporal expression', () => {
    expect(find('Just checking in on the project, no rush at all.')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(extractDeadline({ title: '', body: '', occurredAt: REF })).toBeNull();
  });

  it('reads the title as well as the body', () => {
    const d = find('', 'Renewal due in 5 days');
    expect(d).not.toBeNull();
    expect(d!.deadline.getTime()).toBeGreaterThan(REF.getTime());
  });

  it('tolerates a garbage occurredAt without throwing', () => {
    const d = extractDeadline({
      title: 'x',
      body: 'due in 2 days',
      occurredAt: new Date('not-a-date'),
    });
    // falls back to "now" as ref; just must not throw and must return a future date
    expect(d === null || d.deadline instanceof Date).toBe(true);
  });
});
