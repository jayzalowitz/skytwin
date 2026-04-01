import { describe, it, expect } from 'vitest';
import { CrossDomainCorrelator } from '../cross-domain-correlator.js';
import type { StoredSignal } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

// ── Helpers ──────────────────────────────────────────────────────

function makeSignal(overrides: Partial<StoredSignal> & { id: string }): StoredSignal {
  const now = new Date();
  return {
    userId: 'user_1',
    source: 'test',
    type: 'event',
    domain: 'email',
    data: {},
    timestamp: now,
    retentionUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    createdAt: now,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('CrossDomainCorrelator', () => {
  const correlator = new CrossDomainCorrelator();

  it('finds calendar-email link when email mentions calendar event title', () => {
    const calendarSignal = makeSignal({
      id: 'sig_cal_1',
      domain: 'calendar',
      source: 'google_calendar',
      data: { title: 'Project Kickoff Meeting', startTime: '2026-04-01T10:00:00Z', endTime: '2026-04-01T11:00:00Z' },
    });

    const emailSignal = makeSignal({
      id: 'sig_email_1',
      domain: 'email',
      source: 'gmail',
      data: { subject: 'Agenda for Project Kickoff Meeting', body: 'Please review the agenda before the project kickoff meeting tomorrow.' },
    });

    const correlations = correlator.findCorrelations(emailSignal, [calendarSignal]);

    expect(correlations.length).toBeGreaterThanOrEqual(1);
    const calEmailCorr = correlations.find(c => c.correlationType === 'calendar_email_link');
    expect(calEmailCorr).toBeDefined();
    expect(calEmailCorr!.confidence).toBe(ConfidenceLevel.MODERATE);
    expect(calEmailCorr!.signalIds).toContain('sig_cal_1');
    expect(calEmailCorr!.signalIds).toContain('sig_email_1');
    expect(calEmailCorr!.description).toBe('Email references calendar event');
  });

  it('finds same-sender threading for multiple emails from same source within 24h', () => {
    const now = new Date();

    const currentSignal = makeSignal({
      id: 'sig_1',
      domain: 'email',
      source: 'alice@example.com',
      timestamp: now,
      data: { subject: 'Follow-up' },
    });

    const recentSignals = [
      makeSignal({
        id: 'sig_2',
        domain: 'email',
        source: 'alice@example.com',
        timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
        data: { subject: 'Initial message' },
      }),
      makeSignal({
        id: 'sig_3',
        domain: 'email',
        source: 'alice@example.com',
        timestamp: new Date(now.getTime() - 4 * 60 * 60 * 1000), // 4 hours ago
        data: { subject: 'Earlier message' },
      }),
    ];

    const correlations = correlator.findCorrelations(currentSignal, recentSignals);

    const threadCorr = correlations.find(c => c.correlationType === 'same_sender_thread');
    expect(threadCorr).toBeDefined();
    expect(threadCorr!.confidence).toBe(ConfidenceLevel.HIGH);
    expect(threadCorr!.signalIds).toContain('sig_1');
    expect(threadCorr!.signalIds).toContain('sig_2');
    expect(threadCorr!.signalIds).toContain('sig_3');
    expect(threadCorr!.description).toContain('3 signals from alice@example.com within 24h');
  });

  it('detects calendar conflict when events overlap', () => {
    const eventA = makeSignal({
      id: 'sig_cal_a',
      domain: 'calendar',
      source: 'google_calendar',
      data: {
        title: 'Team Standup',
        startTime: '2026-04-01T10:00:00Z',
        endTime: '2026-04-01T10:30:00Z',
      },
    });

    const eventB = makeSignal({
      id: 'sig_cal_b',
      domain: 'calendar',
      source: 'google_calendar',
      data: {
        title: 'Dentist Appointment',
        startTime: '2026-04-01T10:15:00Z',
        endTime: '2026-04-01T11:00:00Z',
      },
    });

    const correlations = correlator.findCorrelations(eventA, [eventB]);

    const conflictCorr = correlations.find(c => c.correlationType === 'calendar_conflict');
    expect(conflictCorr).toBeDefined();
    expect(conflictCorr!.confidence).toBe(ConfidenceLevel.CONFIRMED);
    expect(conflictCorr!.signalIds).toContain('sig_cal_a');
    expect(conflictCorr!.signalIds).toContain('sig_cal_b');
    expect(conflictCorr!.description).toBe('Calendar events overlap in time');
  });

  it('links subscription email to financial signals', () => {
    const subscriptionEmail = makeSignal({
      id: 'sig_sub_1',
      domain: 'email',
      source: 'netflix@email.com',
      data: { subject: 'Your subscription renewal is coming up', body: 'Your monthly billing will process on April 5.' },
    });

    const financialSignal = makeSignal({
      id: 'sig_fin_1',
      domain: 'finance',
      source: 'bank_api',
      data: { type: 'recurring_charge', vendor: 'Netflix', amount: 15.99 },
    });

    const correlations = correlator.findCorrelations(subscriptionEmail, [financialSignal]);

    const subFinCorr = correlations.find(c => c.correlationType === 'subscription_financial');
    expect(subFinCorr).toBeDefined();
    expect(subFinCorr!.confidence).toBe(ConfidenceLevel.MODERATE);
    expect(subFinCorr!.signalIds).toContain('sig_sub_1');
    expect(subFinCorr!.signalIds).toContain('sig_fin_1');
    expect(subFinCorr!.description).toBe('Subscription renewal linked to financial activity');
  });

  it('returns empty for unrelated signals', () => {
    const emailSignal = makeSignal({
      id: 'sig_unrelated_1',
      domain: 'email',
      source: 'bob@example.com',
      data: { subject: 'Weekend plans', body: 'Want to go hiking?' },
    });

    const calendarSignal = makeSignal({
      id: 'sig_unrelated_2',
      domain: 'calendar',
      source: 'google_calendar',
      data: {
        title: 'Quarterly Review',
        startTime: '2026-04-10T14:00:00Z',
        endTime: '2026-04-10T15:00:00Z',
      },
    });

    const correlations = correlator.findCorrelations(emailSignal, [calendarSignal]);

    // "Weekend plans" does not reference "Quarterly Review",
    // they are different sources/domains so no same-sender threading,
    // email is not a calendar event so no conflict,
    // and "Weekend plans" is not subscription-related.
    expect(correlations).toEqual([]);
  });
});
