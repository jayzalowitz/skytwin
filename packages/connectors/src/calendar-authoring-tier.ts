/**
 * Calendar authoring-tier classification (#251 Phase 3).
 *
 * Calendar events get the same `AuthoringTier` vocabulary as Gmail —
 * the values are deliberately channel-agnostic (per the original #251
 * spec discussion). What "authored" means just shifts: for email it's
 * "the user typed and sent it"; for calendar it's "the user created
 * the event."
 *
 *   user_sent_originated — user organized the event (their email
 *                          appears as the organizer)
 *   user_sent_reply     — N/A on calendar; not used
 *   inbox_personal      — 1-on-1 invite (only self + one other
 *                         attendee) from a known organizer
 *   inbox_broadcast     — multi-attendee invite the user is on
 *   inbox_newsletter    — N/A on calendar; not used
 *   inbox_automated     — auto-generated event (recurring birthdays
 *                         feed, holidays calendar) — heuristic:
 *                         organizer is a known automated-domain
 *                         pattern, e.g. `addressbook#contacts@`
 *
 * Per Phase 1.1's promote-only configuration, only the authored tier
 * (the user organized this event) gets a positive bonus in retrieval.
 * Other tiers contribute nothing — the goal is to lift the user's own
 * agenda above broadcast invites, not to suppress invites.
 */

import type { AuthoringTier } from './authoring-tier.js';

export interface CalendarAuthoringInputs {
  /** Organizer's email (from `event.organizer.email`). */
  organizerEmail: string;
  /** Email of the `self: true` attendee, if any. Empty string if no self. */
  selfEmail: string;
  /** Total attendee count, including the self attendee. */
  attendeeCount: number;
}

/**
 * Heuristic patterns for organizer emails that indicate an auto-generated
 * event (recurring birthdays, automatic holiday calendars, addressbook
 * sync). The `addressbook#contacts@` pattern is the canonical Google
 * Contacts birthdays feed.
 */
const AUTOMATED_ORGANIZER_PATTERNS: RegExp[] = [
  /^addressbook#contacts@/i,
  /^holiday@/i,
  /^en\.usa#holiday@/i,
  /^.+#weather@/i,
];

function isAutomatedOrganizer(email: string): boolean {
  const trimmed = email.trim();
  return AUTOMATED_ORGANIZER_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Classify a calendar event into one of the AuthoringTier values.
 *
 * Order of checks:
 *
 *   1. User organized (selfEmail === organizerEmail) → user_sent_originated.
 *      The user explicitly created this event; high-trust signal.
 *   2. Automated organizer → inbox_automated. Birthdays / holidays.
 *   3. Multi-attendee invite (>2 total) → inbox_broadcast.
 *   4. Default: inbox_personal — 1-on-1 invite from a known organizer.
 */
export function classifyCalendarAuthoringTier(
  input: CalendarAuthoringInputs,
): AuthoringTier {
  const self = input.selfEmail.trim().toLowerCase();
  const organizer = input.organizerEmail.trim().toLowerCase();

  if (self.length > 0 && self === organizer) {
    return 'user_sent_originated';
  }

  if (isAutomatedOrganizer(organizer)) {
    return 'inbox_automated';
  }

  if (input.attendeeCount > 2) {
    return 'inbox_broadcast';
  }

  return 'inbox_personal';
}
