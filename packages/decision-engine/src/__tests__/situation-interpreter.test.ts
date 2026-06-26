import { describe, it, expect } from 'vitest';
import { SituationInterpreter } from '../situation-interpreter.js';
import { SituationType } from '@skytwin/shared-types';

describe('SituationInterpreter', () => {
  const interpreter = new SituationInterpreter();

  describe('calendar event sub-classification', () => {
    it('classifies actual time overlap as CALENDAR_CONFLICT', () => {
      const result = interpreter.interpretRuleBased({
        source: 'google_calendar',
        type: 'calendar_event',
        title: 'Team standup',
        data: { hasConflict: true, requiresResponse: false },
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_CONFLICT);
      expect(result.urgency).toBe('high');
    });

    it('classifies type "calendar_conflict" as CALENDAR_CONFLICT', () => {
      const result = interpreter.interpretRuleBased({
        source: 'calendar',
        type: 'calendar_conflict',
        title: 'Team standup vs 1:1 with manager',
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_CONFLICT);
    });

    it('classifies meeting invite requiring response as CALENDAR_INVITE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'google_calendar',
        type: 'meeting_invite',
        title: 'Weekly sync',
        data: { requiresResponse: true, hasConflict: false },
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_INVITE);
      expect(result.urgency).toBe('medium');
    });

    it('classifies invite type without data object as CALENDAR_INVITE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'calendar',
        type: 'meeting_invite',
        title: 'Coffee chat',
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_INVITE);
    });

    it('classifies plain calendar event with no conflict or invite as CALENDAR_UPDATE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'google_calendar',
        type: 'calendar_event',
        title: 'Sprint review',
        data: { hasConflict: false, requiresResponse: false },
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_UPDATE);
      expect(result.urgency).toBe('low');
    });

    it('classifies calendar event with no data signals as CALENDAR_UPDATE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'calendar',
        type: 'event',
        title: 'Office hours',
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_UPDATE);
    });

    it('classifies email with meeting subject as CALENDAR_INVITE not CONFLICT', () => {
      const result = interpreter.interpretRuleBased({
        source: 'email',
        type: 'email',
        subject: 'Meeting invitation: Q2 planning',
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_INVITE);
    });

    it('conflict takes priority over invite when both flags are set', () => {
      const result = interpreter.interpretRuleBased({
        source: 'google_calendar',
        type: 'meeting_invite',
        title: 'Overlapping meeting',
        data: { hasConflict: true, requiresResponse: true },
      });

      expect(result.situationType).toBe(SituationType.CALENDAR_CONFLICT);
    });
  });

  describe('summary generation', () => {
    it('generates invite summary for CALENDAR_INVITE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'calendar',
        type: 'meeting_invite',
        title: 'Coffee chat',
        startTime: '3:00 PM',
      });

      expect(result.summary).toContain('New calendar invite');
      expect(result.summary).toContain('Coffee chat');
      expect(result.summary).toContain('3:00 PM');
    });

    it('generates conflict summary for CALENDAR_CONFLICT', () => {
      const result = interpreter.interpretRuleBased({
        source: 'calendar',
        type: 'calendar_conflict',
        title: 'Standup vs 1:1',
      });

      expect(result.summary).toContain('Calendar conflict detected');
    });

    it('generates update summary for CALENDAR_UPDATE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'calendar',
        type: 'calendar_event',
        title: 'Sprint review',
      });

      expect(result.summary).toContain('Calendar update');
      expect(result.summary).toContain('Sprint review');
    });
  });

  describe('domain mapping', () => {
    it('maps all calendar sub-types to calendar domain', () => {
      const invite = interpreter.interpretRuleBased({
        source: 'calendar', type: 'meeting_invite', title: 'A',
      });
      const conflict = interpreter.interpretRuleBased({
        source: 'calendar', type: 'calendar_conflict', title: 'B',
      });
      const update = interpreter.interpretRuleBased({
        source: 'calendar', type: 'calendar_event', title: 'C',
      });

      expect(invite.domain).toBe('calendar');
      expect(conflict.domain).toBe('calendar');
      expect(update.domain).toBe('calendar');
    });
  });

  describe('provenance derivation (documentary-poisoning defense)', () => {
    it('stamps user_originated when the email tier says the user sent it', async () => {
      const d = await interpreter.interpret({
        source: 'gmail',
        type: 'email',
        authoringTier: 'user_sent_originated',
      });
      expect(d.provenance).toBe('user_originated');
    });

    it('stamps untrusted_external for every inbox tier', async () => {
      for (const tier of ['inbox_personal', 'inbox_broadcast', 'inbox_newsletter', 'inbox_automated']) {
        const d = await interpreter.interpret({ source: 'gmail', type: 'email', authoringTier: tier });
        expect(d.provenance).toBe('untrusted_external');
      }
    });

    it('reads authoringTier from a nested data envelope (connector signal shape)', async () => {
      // Gmail connector emits { source, type, data: { ..., authoringTier } }.
      const d = await interpreter.interpret({
        source: 'gmail',
        type: 'email',
        data: { authoringTier: 'user_sent_reply' },
      });
      expect(d.provenance).toBe('user_originated');
    });

    it('fails safe to untrusted_external for a tier-less inbound signal', async () => {
      const d = await interpreter.interpret({ source: 'gmail', type: 'email' });
      expect(d.provenance).toBe('untrusted_external');
    });

    it('fails safe to untrusted_external for an unknown source', async () => {
      const d = await interpreter.interpret({ source: 'some-future-connector', type: 'event' });
      expect(d.provenance).toBe('untrusted_external');
    });

    it('maps filesystem-crawl signals to untrusted_external', async () => {
      const d = await interpreter.interpret({ source: 'idle-miner', type: 'file' });
      expect(d.provenance).toBe('untrusted_external');
    });

    it('rule-based interpretation also stamps provenance', () => {
      const d = interpreter.interpretRuleBased({ source: 'gmail', type: 'email' });
      expect(d.provenance).toBe('untrusted_external');
    });

    it('derives provenance on the strategy path when the strategy did not set it', async () => {
      // A SituationStrategy may return a DecisionObject without provenance;
      // interpret() must still stamp it from the raw event (fail safe).
      const strategyInterpreter = new SituationInterpreter({
        interpret: async (raw) => ({
          id: 'strat-1',
          situationType: SituationType.EMAIL_TRIAGE,
          domain: 'email',
          urgency: 'low' as const,
          summary: 'strategy-produced',
          rawData: raw,
          interpretedAt: new Date(),
          // deliberately no `provenance`
        }),
      });
      const d = await strategyInterpreter.interpret({
        source: 'gmail',
        type: 'email',
        authoringTier: 'inbox_personal',
      });
      expect(d.provenance).toBe('untrusted_external');
    });

    it('does not override provenance the strategy set itself', async () => {
      const strategyInterpreter = new SituationInterpreter({
        interpret: async (raw) => ({
          id: 'strat-2',
          situationType: SituationType.EMAIL_TRIAGE,
          domain: 'email',
          urgency: 'low' as const,
          summary: 'strategy-produced',
          rawData: raw,
          interpretedAt: new Date(),
          provenance: 'user_originated' as const,
        }),
      });
      const d = await strategyInterpreter.interpret({ source: 'gmail', type: 'email' });
      expect(d.provenance).toBe('user_originated');
    });
  });

  describe('email source classification (#251 newsletter-aware)', () => {
    it('classifies a gmail newsletter as EMAIL_TRIAGE, not GENERIC', () => {
      const result = interpreter.interpretRuleBased({
        source: 'gmail',
        type: 'newsletter',
        subject: 'Breaking news: House votes to end the conflict',
        authoringTier: 'inbox_newsletter',
      });
      expect(result.situationType).toBe(SituationType.EMAIL_TRIAGE);
    });

    it('classifies an outlook newsletter as EMAIL_TRIAGE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'outlook',
        type: 'newsletter',
        subject: 'Your weekly product digest',
        authoringTier: 'inbox_newsletter',
      });
      expect(result.situationType).toBe(SituationType.EMAIL_TRIAGE);
    });

    it('routes inbound mail to EMAIL_TRIAGE via authoring tier even from an unrecognized source', () => {
      const result = interpreter.interpretRuleBased({
        source: 'imap',
        type: 'broadcast',
        subject: 'Quarterly investor update',
        authoringTier: 'inbox_broadcast',
      });
      expect(result.situationType).toBe(SituationType.EMAIL_TRIAGE);
    });

    it('reads the authoring tier from the data envelope (real connector shape)', () => {
      const result = interpreter.interpretRuleBased({
        source: 'imap',
        type: 'broadcast',
        subject: 'Monthly community roundup',
        data: { authoringTier: 'inbox_newsletter' },
      });
      expect(result.situationType).toBe(SituationType.EMAIL_TRIAGE);
    });

    // Regression: the inbox_* tier clause must not swallow real calendar invites
    // (which also carry an inbox_ tier) into email triage.
    it('keeps a real calendar invite (carrying an inbox_ tier) as CALENDAR_INVITE, not EMAIL_TRIAGE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'google_calendar',
        type: 'meeting_invite',
        title: 'Q3 planning sync',
        authoringTier: 'inbox_broadcast',
        data: { requiresResponse: true, hasConflict: false },
      });
      expect(result.situationType).toBe(SituationType.CALENDAR_INVITE);
    });

    it('keeps an automated calendar event (inbox_automated) as CALENDAR_UPDATE, not EMAIL_TRIAGE', () => {
      const result = interpreter.interpretRuleBased({
        source: 'google_calendar',
        type: 'calendar_event',
        title: 'Recurring birthday',
        authoringTier: 'inbox_automated',
        data: { hasConflict: false, requiresResponse: false },
      });
      expect(result.situationType).toBe(SituationType.CALENDAR_UPDATE);
    });
  });
});
