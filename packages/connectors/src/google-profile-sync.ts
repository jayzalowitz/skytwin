/**
 * Google profile sync — capture per-user language + timezone from the
 * connector identity (#spec 12, #486).
 *
 * On Google OAuth connect we already hold an access token long enough to
 * read two cheap, high-signal facts about *who the user is*:
 *
 *   - their UI `locale` (from the OpenID userinfo endpoint) → `users.language`,
 *     which drives the daily-briefing prose locale (was hardcoded 'en') and the
 *     locale-aware extraction routing.
 *   - their primary calendar's `timeZone` → `users.timezone`, which resolves
 *     relative deadlines ("by Friday", "end of day") against the user's clock
 *     instead of UTC.
 *
 * Safe fallbacks, never silent guesses:
 *   - `language` falls back to 'en' (the `languageDefaulted` flag tells the
 *     caller it was a fallback).
 *   - `timezone` falls back to UTC and sets `timezoneDefaulted` so the caller
 *     MUST log a warning — we never invent a timezone for someone.
 *
 * Pure-ish: the two network reads go through the injectable `fetchImpl`
 * (defaults to global `fetch`) so this is unit-testable without a live Google
 * account. Best-effort by contract: every network/parse failure resolves to the
 * defaulted result rather than throwing, because profile sync must never block
 * the sign-in path.
 */

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const PRIMARY_CALENDAR_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary';

/** Minimal fetch surface so callers can inject a stub in tests. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface GoogleProfileSyncResult {
  /** BCP-47-ish language tag from the Google profile (e.g. 'es', 'ja', 'en-GB'). */
  language: string;
  /** IANA timezone from the primary calendar (e.g. 'Asia/Tokyo'), or 'UTC'. */
  timezone: string;
  /** True when `language` fell back to 'en' (profile had no usable locale). */
  languageDefaulted: boolean;
  /**
   * True when `timezone` fell back to 'UTC' (no primary-calendar timezone).
   * The caller MUST log a warning in this case — we never silently guess a tz.
   */
  timezoneDefaulted: boolean;
}

interface UserInfoShape {
  locale?: unknown;
}

interface PrimaryCalendarShape {
  timeZone?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Fetch the Google `locale` (→ language) and primary-calendar `timeZone`
 * (→ timezone) for the just-authorized account. Resolves to safe defaults on
 * any failure — never throws, never blocks sign-in.
 *
 * The two reads are independent: a missing/forbidden calendar scope still
 * yields the language, and a userinfo failure still yields the timezone.
 */
export async function fetchGoogleProfileSync(
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<GoogleProfileSyncResult> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  let language = '';
  try {
    const res = await fetchImpl(USERINFO_URL, { headers });
    if (res.ok) {
      const data = (await res.json()) as UserInfoShape;
      language = str(data.locale);
    }
  } catch {
    // Network/parse failure — fall through to the 'en' default below.
  }

  let timezone = '';
  try {
    const res = await fetchImpl(PRIMARY_CALENDAR_URL, { headers });
    if (res.ok) {
      const data = (await res.json()) as PrimaryCalendarShape;
      timezone = str(data.timeZone);
    }
  } catch {
    // Network/parse failure — fall through to the UTC default below.
  }

  const languageDefaulted = language.length === 0;
  const timezoneDefaulted = timezone.length === 0;

  return {
    language: languageDefaulted ? 'en' : language,
    timezone: timezoneDefaulted ? 'UTC' : timezone,
    languageDefaulted,
    timezoneDefaulted,
  };
}
