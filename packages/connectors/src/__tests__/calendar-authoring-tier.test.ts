/**
 * Tests for the calendar authoring-tier classifier (#251 Phase 3).
 */

import { describe, it, expect } from 'vitest';
import { classifyCalendarAuthoringTier } from '../calendar-authoring-tier.js';

describe('classifyCalendarAuthoringTier', () => {
  it('returns user_sent_originated when the user organized the event', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'me@example.com',
        selfEmail: 'me@example.com',
        attendeeCount: 3,
      }),
    ).toBe('user_sent_originated');
  });

  it('is case-insensitive on the email comparison', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'Me@Example.com',
        selfEmail: 'me@EXAMPLE.com',
        attendeeCount: 5,
      }),
    ).toBe('user_sent_originated');
  });

  it('returns inbox_automated for Google Contacts birthdays feed', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'addressbook#contacts@group.v.calendar.google.com',
        selfEmail: 'me@example.com',
        attendeeCount: 0,
      }),
    ).toBe('inbox_automated');
  });

  it('returns inbox_automated for holiday calendar', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'en.usa#holiday@group.v.calendar.google.com',
        selfEmail: 'me@example.com',
        attendeeCount: 0,
      }),
    ).toBe('inbox_automated');
  });

  it('returns inbox_automated for weather-feed organizer', () => {
    // Matches the /^.+#weather@/i pattern in AUTOMATED_ORGANIZER_PATTERNS.
    // Without this case the regex could regress silently — only birthdays
    // and holidays were exercised previously.
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'en.usa#weather@group.v.calendar.google.com',
        selfEmail: 'me@example.com',
        attendeeCount: 0,
      }),
    ).toBe('inbox_automated');
  });

  it('returns inbox_broadcast for multi-attendee invites the user is on', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'organizer@example.com',
        selfEmail: 'me@example.com',
        attendeeCount: 5,
      }),
    ).toBe('inbox_broadcast');
  });

  it('returns inbox_personal for 1-on-1 invites from a known organizer', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'colleague@example.com',
        selfEmail: 'me@example.com',
        attendeeCount: 2,
      }),
    ).toBe('inbox_personal');
  });

  it('returns inbox_personal for solo events with a known organizer', () => {
    // E.g. a calendar entry someone shared with the user but didn't
    // formally invite anyone else.
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'colleague@example.com',
        selfEmail: '',
        attendeeCount: 0,
      }),
    ).toBe('inbox_personal');
  });

  it('handles empty self email — defaults to organizer being someone else', () => {
    expect(
      classifyCalendarAuthoringTier({
        organizerEmail: 'someone@example.com',
        selfEmail: '',
        attendeeCount: 3,
      }),
    ).toBe('inbox_broadcast');
  });
});
