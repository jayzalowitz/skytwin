/**
 * Normalized text accessor for any RawSignal, regardless of source (#spec 07).
 *
 * Every capability that reads signal content — commitment extraction (spec 02),
 * deadline extraction (spec 03), the security classifier (spec 06) — should
 * consume `SignalText` rather than reaching into a source-specific `data` shape.
 * That's what makes those capabilities source-agnostic: a commitment spoken into
 * a voice note or a deadline in a project-file TODO is read the same way as one
 * in an email.
 *
 * Pure and side-effect-free so it can be unit-tested without a connector. The
 * per-source field mapping lives here; unknown sources fall back to best-effort
 * field lookups and `authoredByUser = false` (fail safe — never assume the user
 * authored content we can't classify).
 */

import type { RawSignal, AuthoringTier } from '@skytwin/connectors';

export interface SignalText {
  /** Channel string from the originating RawSignal (e.g. 'gmail', 'voice'). */
  source: string;
  /** Subject / event title / file name / "Voice note". */
  title: string;
  /** Body / event description / file excerpt / transcript. */
  body: string;
  /** AuthoringTier if the connector stamped one (email + calendar do today). */
  authoringTier?: AuthoringTier;
  /** Derived: did the user author this content? Fail-safe false when unknown. */
  authoredByUser: boolean;
  /** Timestamp anchor for relative deadline/temporal resolution. */
  occurredAt: Date;
  /** Recipients / attendees / collaborators (bare-ish address strings). */
  participants: string[];
}

/**
 * Tiers that mean "the user authored this content." Maps both the email
 * `user_sent_*` tiers and the channel-agnostic `authored_originated` tier
 * (#251 extension). Everything else — inbound, received, automated, or
 * unknown — is NOT user-authored.
 */
const AUTHORED_TIERS: ReadonlySet<AuthoringTier> = new Set<AuthoringTier>([
  'user_sent_originated',
  'user_sent_reply',
  'authored_originated',
]);

/** True only for tiers that denote user-authored content. Fail-safe: undefined → false. */
export function isAuthoredByUser(tier: AuthoringTier | undefined): boolean {
  return tier !== undefined && AUTHORED_TIERS.has(tier);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** First non-empty string among the candidates. */
function firstStr(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return '';
}

/** Split a raw address-list header ("A <a@x>, b@y") into trimmed parts. */
function splitAddresses(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => str(x)).filter((s) => s.length > 0);
  }
  return str(v)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pull attendee/organizer emails from a calendar `data` payload. */
function calendarParticipants(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const organizer = str(data['organizer']) || str(data['from']);
  if (organizer) out.push(organizer);
  const attendees = data['attendees'];
  if (Array.isArray(attendees)) {
    for (const a of attendees) {
      if (a && typeof a === 'object' && 'email' in a) {
        const email = str((a as Record<string, unknown>)['email']);
        if (email) out.push(email);
      } else {
        const email = str(a);
        if (email) out.push(email);
      }
    }
  }
  // de-dup, preserve order
  return [...new Set(out)];
}

function coerceDate(ts: unknown): Date {
  if (ts instanceof Date) return ts;
  if (typeof ts === 'string' || typeof ts === 'number') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0); // epoch fallback — deterministic, never NaN
}

/**
 * Normalize a RawSignal into channel-agnostic SignalText. The per-source
 * mapping covers the connectors that exist today (gmail, google_calendar,
 * their mocks, filesystem from idle-miner, voice transcripts); any other
 * source falls through to a best-effort generic mapping with
 * `authoredByUser = false`.
 */
export function toSignalText(signal: RawSignal): SignalText {
  const data: Record<string, unknown> =
    signal.data && typeof signal.data === 'object'
      ? (signal.data as Record<string, unknown>)
      : {};

  const tierRaw = data['authoringTier'];
  const authoringTier =
    typeof tierRaw === 'string' ? (tierRaw as AuthoringTier) : undefined;

  let title = '';
  let body = '';
  let participants: string[] = [];

  switch (signal.source) {
    case 'gmail':
    case 'outlook':
    case 'email':
      title = str(data['subject']);
      // Gmail signals carry `snippet` (a body proxy); mocks may carry `body`.
      body = firstStr(data['body'], data['snippet'], data['text']);
      participants = [
        ...splitAddresses(data['to']),
        ...splitAddresses(data['cc']),
        ...splitAddresses(data['from']),
      ];
      participants = [...new Set(participants)];
      break;

    case 'google_calendar':
    case 'outlook_calendar':
    case 'calendar':
      title = firstStr(data['title'], data['summary']);
      body = str(data['description']);
      participants = calendarParticipants(data);
      break;

    case 'filesystem':
      title = firstStr(data['fileName'], data['path'], data['title']);
      body = firstStr(data['excerpt'], data['body'], data['content'], data['snippet']);
      break;

    case 'voice':
      title = firstStr(data['title']) || 'Voice note';
      body = firstStr(data['transcript'], data['text'], data['body']);
      break;

    default:
      // Unknown/future source — best-effort, fail safe on authorship.
      title = firstStr(data['title'], data['subject'], data['name'], data['summary']);
      body = firstStr(
        data['body'],
        data['description'],
        data['snippet'],
        data['transcript'],
        data['text'],
      );
      participants = [
        ...splitAddresses(data['to']),
        ...splitAddresses(data['from']),
      ];
      participants = [...new Set(participants)];
      break;
  }

  return {
    source: signal.source,
    title,
    body,
    authoringTier,
    authoredByUser: isAuthoredByUser(authoringTier),
    occurredAt: coerceDate(signal.timestamp),
    participants,
  };
}
