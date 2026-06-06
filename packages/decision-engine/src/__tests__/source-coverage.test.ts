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
    expect(statusOf(cov, 'security')).toBe('available'); // gmail is its only real source
    expect(statusOf(cov, 'deadlines')).toBe('partial'); // could also use calendar/fs/voice
    expect(cov.missing).toContain('google_calendar');
  });

  it('calendar-only: security UNAVAILABLE (no inbound mail), deadlines partial', () => {
    const cov = computeCoverage([acct('google_calendar')]);
    expect(statusOf(cov, 'security')).toBe('unavailable');
    expect(statusOf(cov, 'commitments')).toBe('partial');
    expect(cov.missing).toContain('gmail');
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
});
