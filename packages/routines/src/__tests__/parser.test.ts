import { describe, it, expect } from 'vitest';
import { parseRoutineSpec } from '../parser.js';

/** Narrow helper: assert matched and return the spec. */
function spec(text: string) {
  const r = parseRoutineSpec(text);
  if (!r.matched) throw new Error(`expected match for: ${text} (reason: ${r.reason})`);
  return r;
}

describe('parseRoutineSpec — recurrence gate', () => {
  it('returns matched:false for ordinary chat with no recurrence cue', () => {
    for (const msg of [
      'what meetings do I have today?',
      'draft a reply to Sarah',
      'summarize this thread', // one-shot summary, not recurring
      '',
      '   ',
    ]) {
      expect(parseRoutineSpec(msg).matched).toBe(false);
    }
  });

  it('matches when a recurrence cue is present', () => {
    for (const msg of [
      'every morning summarize my email',
      'daily digest of my calendar',
      'check my inbox hourly',
      'each week recap my meetings',
      'whenever an email from finance@acme.com arrives, alert me',
    ]) {
      expect(parseRoutineSpec(msg).matched).toBe(true);
    }
  });
});

describe('parseRoutineSpec — cadence', () => {
  it('detects hourly (explicit and event-driven)', () => {
    expect(spec('check my inbox hourly').spec.cadence).toBe('hourly');
    expect(spec('every hour summarize new mail').spec.cadence).toBe('hourly');
    expect(spec('whenever a meeting invite arrives, notify me').spec.cadence).toBe('hourly');
  });

  it('detects daily and defaults the hour to morning (8)', () => {
    const s = spec('every day summarize my email').spec;
    expect(s.cadence).toBe('daily');
    expect(s.hourOfDay).toBe(8);
  });

  it('detects weekly with a day of week', () => {
    const s = spec('every monday recap my meetings').spec;
    expect(s.cadence).toBe('weekly');
    expect(s.dayOfWeek).toBe(1);
  });

  it('treats a plural day name ("on fridays") as weekly', () => {
    const s = spec('on fridays send me a digest of my calendar').spec;
    expect(s.cadence).toBe('weekly');
    expect(s.dayOfWeek).toBe(5);
  });

  it('a bare "every …" with no unit defaults to daily', () => {
    expect(spec('every time summarize my inbox').spec.cadence).toBe('daily');
  });
});

describe('parseRoutineSpec — time of day', () => {
  it('maps named times of day', () => {
    expect(spec('every evening summarize my email').spec.hourOfDay).toBe(18);
    expect(spec('each afternoon recap my calendar').spec.hourOfDay).toBe(14);
  });
  it('parses explicit clock times incl am/pm/noon/midnight', () => {
    expect(spec('every day at 9am summarize my inbox').spec.hourOfDay).toBe(9);
    expect(spec('daily at 5pm digest my email').spec.hourOfDay).toBe(17);
    expect(spec('every day at 17:30 recap my calendar').spec.hourOfDay).toBe(17);
    expect(spec('daily at noon summarize mail').spec.hourOfDay).toBe(12);
    expect(spec('daily at midnight digest my inbox').spec.hourOfDay).toBe(0);
  });
  it('leaves hourly cadence without an hour-of-day', () => {
    expect(spec('hourly digest of my inbox').spec.hourOfDay).toBeUndefined();
  });
});

describe('parseRoutineSpec — action', () => {
  it('summary language → digest', () => {
    expect(spec('every morning summarize my email').spec.action).toBe('digest');
    expect(spec('daily recap of my meetings').spec.action).toBe('digest');
  });
  it('alert language → notify', () => {
    expect(spec('whenever an email from boss@acme.com arrives, flag it').spec.action).toBe('notify');
    expect(spec('every hour, alert me about new calendar invites').spec.action).toBe('notify');
  });
  it('defaults to digest when neither is explicit', () => {
    expect(spec('every day, my email').spec.action).toBe('digest');
  });
});

describe('parseRoutineSpec — source filter', () => {
  it('email cue → both email sources', () => {
    expect(spec('daily summarize my email').spec.filter.sources).toEqual(['gmail', 'outlook']);
  });
  it('calendar cue → both calendar sources', () => {
    expect(spec('every morning recap my meetings').spec.filter.sources).toEqual([
      'google_calendar',
      'outlook_calendar',
    ]);
  });
  it('narrows to a named vendor', () => {
    expect(spec('daily digest of my gmail').spec.filter.sources).toEqual(['gmail']);
    expect(spec('every morning summarize my outlook mail').spec.filter.sources).toEqual(['outlook']);
  });
  it('email + calendar cues include all four sources', () => {
    const s = spec('every morning summarize my email and calendar').spec;
    expect(s.filter.sources).toEqual(['gmail', 'outlook', 'google_calendar', 'outlook_calendar']);
  });
});

describe('parseRoutineSpec — from / keywords / domains', () => {
  it('captures a literal sender after "from"', () => {
    const s = spec('whenever an email from finance@acme.com arrives, alert me').spec;
    expect(s.filter.fromContains).toEqual(['finance@acme.com']);
  });

  it('flags a fuzzy sender with a warning and keeps the literal remainder', () => {
    const r = spec('every morning flag anything from my biggest client');
    expect(r.warnings.some((w) => /vague sender/i.test(w))).toBe(true);
    // "my" stripped → "biggest client" kept as a best-effort substring.
    expect(r.spec.filter.fromContains).toEqual(['biggest client']);
  });

  it('captures quoted phrases and "about X" keywords', () => {
    const s = spec('daily summarize my email about "Q3 budget" and regarding hiring').spec;
    expect(s.filter.keywords).toEqual(expect.arrayContaining(['q3 budget', 'hiring']));
  });

  it('detects domains (security, scheduling)', () => {
    expect(spec('every hour alert me about suspicious emails').spec.filter.domains).toContain(
      'security',
    );
    expect(
      spec('every morning summarize my calendar conflicts').spec.filter.domains,
    ).toContain('scheduling');
  });
});

describe('parseRoutineSpec — warnings + naming', () => {
  it('warns when the filter matches everything', () => {
    const r = spec('every day summarize'); // no source/sender/keyword
    expect(r.warnings.some((w) => /match every signal/i.test(w))).toBe(true);
  });

  it('does not warn when the filter is narrowed', () => {
    const r = spec('every day summarize my email from finance@acme.com');
    expect(r.warnings.some((w) => /match every signal/i.test(w))).toBe(false);
  });

  it('generates a readable, bounded name', () => {
    expect(spec('every morning summarize my email').spec.name).toBe('Daily email digest');
    expect(spec('every monday recap my calendar').spec.name).toBe('Monday calendar digest');
    expect(spec('hourly flag mail from boss@acme.com').spec.name).toBe(
      'Hourly email alerts — from boss@acme.com',
    );
    expect(spec('every day summarize').spec.name.length).toBeLessThanOrEqual(60);
  });

  it('parses the headline example end-to-end', () => {
    const r = spec(
      'every morning, summarize my calendar conflicts and anything from finance@acme.com',
    );
    expect(r.spec.cadence).toBe('daily');
    expect(r.spec.hourOfDay).toBe(8);
    expect(r.spec.action).toBe('digest');
    expect(r.spec.filter.sources).toEqual(['google_calendar', 'outlook_calendar']);
    expect(r.spec.filter.fromContains).toEqual(['finance@acme.com']);
    expect(r.spec.filter.domains).toContain('scheduling');
  });
});
