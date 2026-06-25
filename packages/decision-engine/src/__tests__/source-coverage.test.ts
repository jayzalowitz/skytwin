import { describe, it, expect } from 'vitest';
import { computeCoverage, type ConnectedAccountInfo } from '../source-coverage.js';

function acct(provider: string, isActive = true): ConnectedAccountInfo {
  return { provider, scopes: [], isActive };
}

function statusOf(cov: ReturnType<typeof computeCoverage>, cap: string) {
  return cov.capabilityStatus.find((c) => c.capability === cap)!.status;
}

describe('computeCoverage (spec 13)', () => {
  it('email-only: security available, others partial, not cold-start (AC1/AC4)', () => {
    const cov = computeCoverage([acct('gmail')]);
    expect(cov.connected).toEqual(['gmail']);
    expect(cov.coldStart).toBe(false);
    expect(statusOf(cov, 'security')).toBe('available'); // email is its only group
    expect(statusOf(cov, 'deadlines')).toBe('partial'); // could also use calendar/files/voice
    // unlockedBy / missing are human-meaningful GROUP labels, not raw source ids.
    expect(cov.missing).toContain('a calendar');
    expect(cov.missing).not.toContain('google_calendar');
    expect(cov.missing).not.toContain('outlook'); // a Gmail user is never nudged to Outlook
  });

  it('calendar-only: security UNAVAILABLE (no inbound mail), deadlines partial', () => {
    const cov = computeCoverage([acct('google_calendar')]);
    expect(statusOf(cov, 'security')).toBe('unavailable');
    expect(statusOf(cov, 'commitments')).toBe('partial');
    expect(cov.missing).toContain('email');
  });

  it('filesystem-only: commitments unavailable (files arent promises), deadlines partial', () => {
    const cov = computeCoverage([acct('filesystem')]);
    expect(statusOf(cov, 'commitments')).toBe('unavailable');
    expect(statusOf(cov, 'security')).toBe('unavailable');
    expect(statusOf(cov, 'deadlines')).toBe('partial');
  });

  it('voice-only: commitments partial, security unavailable', () => {
    const cov = computeCoverage([acct('voice')]);
    expect(statusOf(cov, 'commitments')).toBe('partial');
    expect(statusOf(cov, 'security')).toBe('unavailable');
  });

  it('gmail + calendar: richer coverage, security available', () => {
    const cov = computeCoverage([acct('gmail'), acct('google_calendar')]);
    expect(cov.connected).toEqual(['gmail', 'google_calendar']);
    expect(statusOf(cov, 'security')).toBe('available');
    expect(statusOf(cov, 'commitments')).toBe('partial'); // voice still missing
    // A Google user is NOT told to connect Outlook — only the truly-missing groups.
    expect(cov.missing).not.toContain('outlook');
    expect(cov.missing).not.toContain('outlook_calendar');
  });

  it('zero sources: cold-start true, everything unavailable (AC3)', () => {
    const cov = computeCoverage([]);
    expect(cov.coldStart).toBe(true);
    expect(cov.connected).toEqual([]);
    expect(cov.capabilityStatus.every((c) => c.status === 'unavailable')).toBe(true);
  });

  it('inactive accounts do not count as connected', () => {
    const cov = computeCoverage([acct('gmail', false)]);
    expect(cov.connected).toEqual([]);
    expect(cov.coldStart).toBe(true);
  });

  it('the "google" provider expands to gmail + calendar', () => {
    const cov = computeCoverage([acct('google')]);
    expect(cov.connected).toEqual(['gmail', 'google_calendar']);
  });

  it('the "microsoft" provider expands to outlook + outlook_calendar with the SAME coverage a Google user gets', () => {
    const ms = computeCoverage([acct('microsoft')]);
    expect(ms.connected).toEqual(['outlook', 'outlook_calendar']);
    expect(ms.coldStart).toBe(false);
    // Outlook mail is inbound mail → security available, parity with Google.
    expect(statusOf(ms, 'security')).toBe('available');
    expect(statusOf(ms, 'commitments')).toBe('partial'); // voice still missing

    // Capability statuses must match a gmail+google_calendar user exactly —
    // alternative providers are peers, not second-class.
    const google = computeCoverage([acct('google')]);
    const statusMap = (c: ReturnType<typeof computeCoverage>) =>
      Object.fromEntries(c.capabilityStatus.map((s) => [s.capability, s.status]));
    expect(statusMap(ms)).toEqual(statusMap(google));
    // ...and a Microsoft user is never nudged to connect Google.
    expect(ms.missing).not.toContain('gmail');
    expect(ms.missing).not.toContain('google_calendar');
  });

  it('gmail + outlook (both email providers) does not over-credit beyond the email group', () => {
    const cov = computeCoverage([acct('gmail'), acct('outlook')]);
    expect(cov.connected).toEqual(['gmail', 'outlook']);
    // Both are the email group → security available; calendar/voice still missing.
    expect(statusOf(cov, 'security')).toBe('available');
    expect(statusOf(cov, 'commitments')).toBe('partial');
    expect(cov.missing).toContain('a calendar');
  });

  it('unlockedBy carries group labels, never raw source ids', () => {
    const cov = computeCoverage([acct('gmail')]);
    const deadlines = cov.capabilityStatus.find((c) => c.capability === 'deadlines')!;
    expect(deadlines.unlockedBy).toEqual(['a calendar', 'files', 'voice']);
  });
});
