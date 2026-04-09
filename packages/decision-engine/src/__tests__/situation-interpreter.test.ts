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
});
