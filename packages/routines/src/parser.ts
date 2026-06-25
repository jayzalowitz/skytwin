import type {
  RoutineActionKind,
  RoutineCadence,
  RoutineFilter,
  RoutineParseResult,
  RoutineSpec,
} from '@skytwin/shared-types';

/**
 * Deterministic natural-language → `RoutineSpec` parser (#519).
 *
 * This is the "no-code" front door: a user types "every morning, summarize my
 * calendar conflicts and anything from finance@acme.com" and gets a structured,
 * schedulable routine back. It is intentionally DETERMINISTIC (no LLM) so the
 * authoring path has no provider dependency and a stable, testable contract; an
 * LLM-backed parse that resolves fuzzy references ("my biggest client") is a
 * follow-up that can layer on top, falling back to this when no LLM is wired —
 * the same deterministic-fallback shape `@skytwin/policy-prompts` uses.
 *
 * `matched: false` is the common case (most chat is not a routine) and is NOT
 * an error — the caller treats the message as ordinary chat.
 */

/**
 * Hard cap on input length before any regex runs. Routine asks are short; a
 * multi-kilobyte message is never a routine, and an unbounded `from …@`-style
 * string could otherwise drive the email matcher into quadratic backtracking
 * (a remote-input DoS once chat feeds this). Truncate (don't reject) so a
 * routine stated at the top of a longer message still parses.
 */
const MAX_INPUT = 2000;

/**
 * Email matcher with BOUNDED quantifiers ({1,64}/{1,255}/{2,24}) so a long
 * local-part with no TLD can't trigger catastrophic backtracking. Built fresh
 * (with /g) at each call site to avoid shared `lastIndex` state.
 */
const EMAIL_RE = '[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\\.[a-z]{2,24}';

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const TIME_OF_DAY: Record<string, number> = {
  morning: 8,
  afternoon: 14,
  evening: 18,
  night: 21,
};

/** A recurrence cue is required — without one, the text isn't a routine. */
const RECURRENCE =
  /\b(every|each|daily|weekly|hourly|recurring|routinely|whenever|anytime|any time|as soon as|the moment|bi-?weekly|fortnight(?:ly)?)\b/;

/**
 * True when the text signals recurrence. Beyond the explicit cues above, a
 * PLURAL day ("on fridays") or "every/each/on <day>" counts — but a bare
 * singular day ("meet me friday") does NOT, so a one-off isn't mistaken for a
 * standing routine.
 */
function hasRecurrence(t: string): boolean {
  if (RECURRENCE.test(t)) return true;
  // Only FULL day names gate as recurrence (length >= 6). A 3-letter
  // abbreviation like "tues" would false-positive one-off chat ("meet me tues");
  // "every tue" still matches via the RECURRENCE cue above.
  for (const name of Object.keys(DAYS)) {
    if (name.length < 6) continue;
    if (new RegExp(`\\b${name}s\\b`).test(t)) return true; // plural day = recurring
    if (new RegExp(`\\b(?:every|each|on)\\s+${name}\\b`).test(t)) return true;
  }
  return false;
}

/** Words that mean "the moment it happens" → poll frequently (hourly). */
const EVENT_DRIVEN = /\b(whenever|anytime|any time|as soon as|the moment)\b/;

function detectCadence(t: string): { cadence: RoutineCadence; dayOfWeek?: number } {
  if (/\b(hourly|every hour|each hour)\b/.test(t) || EVENT_DRIVEN.test(t)) {
    return { cadence: 'hourly' };
  }
  // A named day, or "every/each <day>", or an explicit weekly cue → weekly.
  const dow = detectDayOfWeek(t);
  if (dow !== undefined || /\b(weekly|every week|each week|bi-?weekly|fortnight(?:ly)?)\b/.test(t)) {
    return { cadence: 'weekly', dayOfWeek: dow };
  }
  // "daily", "every morning", or a bare "every/each …" with no unit → daily.
  return { cadence: 'daily' };
}

function detectDayOfWeek(t: string): number | undefined {
  // Match a day name as a whole word (also catches the plural "mondays").
  for (const [name, n] of Object.entries(DAYS)) {
    if (new RegExp(`\\b${name}s?\\b`).test(t)) return n;
  }
  return undefined;
}

/** How many DISTINCT days are named — used to warn that v1 schedules only one. */
function distinctDayCount(t: string): number {
  const found = new Set<number>();
  for (const [name, n] of Object.entries(DAYS)) {
    if (new RegExp(`\\b${name}s?\\b`).test(t)) found.add(n);
  }
  return found.size;
}

/** Interval cues v1's coarse hourly/daily/weekly cadence can't represent exactly. */
const UNSUPPORTED_INTERVAL =
  /\b(every\s+\d+\s+\w+|every other|bi-?weekly|fortnight(ly)?|twice (a|per) (day|week)|weekday|business day)\b/;

/** Hour of day for daily/weekly cadences. Undefined for hourly (it ignores it). */
function detectHourOfDay(t: string, cadence: RoutineCadence): number | undefined {
  if (cadence === 'hourly') return undefined;
  if (/\bnoon\b/.test(t)) return 12;
  if (/\bmidnight\b/.test(t)) return 0;
  // "at 9", "at 9am", "at 9:30 pm", "at 17:00"
  const m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (m) {
    let h = parseInt(m[1]!, 10);
    const ampm = m[3];
    if (ampm) {
      // With am/pm the hour must read 1-12; "13pm" is contradictory → fall
      // through to a named time / default rather than trust "13".
      if (h >= 1 && h <= 12) {
        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        return h;
      }
    } else if (h >= 0 && h <= 23) {
      return h;
    }
  }
  for (const [word, h] of Object.entries(TIME_OF_DAY)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return h;
  }
  return 8; // sensible default: morning
}

function detectAction(t: string): RoutineActionKind {
  const digestCue = /\b(summar(y|ize|ise)|digest|recap|brief(ing)?|overview|round[\s-]?up)\b/.test(t);
  if (digestCue) return 'digest';
  const notifyCue = /\b(notify|alert|tell me|ping me|flag|let me know|warn me|remind me)\b/.test(t);
  if (notifyCue) return 'notify';
  return 'digest';
}

function detectSources(t: string): string[] {
  const out = new Set<string>();
  const wantsEmail = /\b(e-?mail|e-?mails|mail|inbox|message|messages)\b/.test(t);
  const wantsCalendar = /\b(calendar|meeting|meetings|event|events|invite|invites|appointment|appointments)\b/.test(t);
  const saysGmail = /\bgmail\b/.test(t);
  const saysOutlook = /\boutlook\b/.test(t);
  const saysGoogleCal = /\bgoogle calendar\b/.test(t);

  if (wantsEmail || saysGmail || saysOutlook) {
    // Narrow to a vendor when one is named; otherwise both email sources.
    if (saysGmail && !saysOutlook) out.add('gmail');
    else if (saysOutlook && !saysGmail) out.add('outlook');
    else {
      out.add('gmail');
      out.add('outlook');
    }
  }
  if (wantsCalendar || saysGoogleCal) {
    if (saysGoogleCal && !saysOutlook) out.add('google_calendar');
    else if (saysOutlook && !saysGoogleCal && !/\bgoogle\b/.test(t)) out.add('outlook_calendar');
    else {
      out.add('google_calendar');
      out.add('outlook_calendar');
    }
  }
  return [...out];
}

/** Phrases that mark the end of a "from <sender>" capture. */
const FROM_STOP = /\s+(?:about|regarding|re:|every|each|daily|weekly|hourly|on |at |and |that |which |when |to )/;

/** Words signalling a fuzzy sender that a deterministic parse can't resolve. */
const FUZZY_SENDER = /\b(my|biggest|favou?rite|important|top|key|main|best)\b/;

/** A trailing "…arrives / comes in / shows up" verb after the sender, to drop. */
const ARRIVAL_VERB = /\s+(?:arrives?|comes?\s+in|shows?\s+up|lands?|hits?|appears?)\b.*$/;

function detectFrom(t: string): { values: string[]; fuzzy: boolean } {
  const values: string[] = [];
  let fuzzy = false;
  // Capture each "from <run>" up to a sentence boundary (period+space / period
  // at end), a semicolon, or end of string — dots inside an address are kept.
  const re = /\bfrom\s+(.+?)(?=\.\s|\.$|;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const run = m[1]!;
    // Emails are the cleanest signal — pull EVERY address from the run first,
    // so "from alice@x.com and bob@y.com" keeps both and a trailing clause
    // ("… arrives, alert me") is ignored.
    const emails = [...run.matchAll(new RegExp(EMAIL_RE, 'gi'))].map((e) => e[0].toLowerCase());
    if (emails.length) {
      values.push(...emails);
      continue;
    }
    // No address: drop a trailing clause / arrival verb, then keep the FIRST
    // listed sender (avoid swallowing "… alert me" after a comma/"and").
    let phrase = run;
    const stop = phrase.search(FROM_STOP);
    if (stop > 0) phrase = phrase.slice(0, stop);
    phrase = phrase.replace(ARRIVAL_VERB, '').trim();
    const first = phrase.split(/\s+and\s+|,\s*/)[0]?.trim();
    phrase = first ?? phrase;
    if (!phrase) continue;
    if (FUZZY_SENDER.test(phrase)) {
      fuzzy = true;
      // Keep the literal text as a best-effort substring, minus the filler word.
      phrase = phrase.replace(FUZZY_SENDER, '').replace(/\s+/g, ' ').trim();
      if (!phrase) continue;
    }
    values.push(phrase);
  }
  return { values: [...new Set(values)], fuzzy };
}

function detectKeywords(text: string): string[] {
  const out = new Set<string>();
  // Quoted phrases are taken verbatim. ONLY double quotes (straight + curly)
  // delimit a phrase — single quotes (straight `'` and curly `’`) are excluded
  // because they appear in contractions/possessives ("don't … it's"), which
  // would otherwise be captured as one nonsensical span. Unquoted phrases are
  // still picked up by the "about X" / "regarding X" capture below.
  for (const m of text.matchAll(/["“”]([^"“”]+)["“”]/g)) {
    out.add(m[1]!.trim().toLowerCase());
  }
  // "about X" / "regarding X" / "mentioning X" / "containing X" / "related to X"
  const t = text.toLowerCase();
  // Lazy capture stops at " and ", punctuation, or end — so "about X and
  // regarding Y" yields two keywords, not one greedy run.
  for (const m of t.matchAll(
    /\b(?:about|regarding|mentioning|containing|related to)\s+(.+?)(?=\s+and\b|[,.;]|$)/g,
  )) {
    // Strip surrounding quotes so `about "Q3 budget"` dedupes with the
    // quoted-phrase capture above rather than adding `"q3 budget"` verbatim.
    const phrase = m[1]!.trim().replace(/^["“”]|["“”]$/g, '').trim();
    if (phrase) out.add(phrase);
  }
  return [...out];
}

function detectDomains(t: string): string[] {
  const out = new Set<string>();
  if (/\b(security|phishing|suspicious|breach|compromis|fraud)\b/.test(t)) out.add('security');
  if (/\b(scheduling|conflict|conflicts|double[\s-]?book)\b/.test(t)) out.add('scheduling');
  return [...out];
}

const DOW_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function buildName(spec: Omit<RoutineSpec, 'name'>): string {
  const cadenceLabel =
    spec.cadence === 'hourly'
      ? 'Hourly'
      : spec.cadence === 'weekly'
        ? spec.dayOfWeek !== undefined
          ? DOW_NAME[spec.dayOfWeek]!
          : 'Weekly'
        : 'Daily';
  const f = spec.filter;
  let subject = 'activity';
  const hasEmail = (f.sources ?? []).some((s) => s === 'gmail' || s === 'outlook');
  const hasCal = (f.sources ?? []).some((s) => s === 'google_calendar' || s === 'outlook_calendar');
  if (hasEmail && !hasCal) subject = 'email';
  else if (hasCal && !hasEmail) subject = 'calendar';
  const actionLabel = spec.action === 'digest' ? 'digest' : 'alerts';
  let name = `${cadenceLabel} ${subject} ${actionLabel}`;
  if ((f.fromContains ?? []).length > 0) name += ` — from ${f.fromContains![0]}`;
  // Keep it short and tidy.
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/**
 * Parse a natural-language ask into a `RoutineSpec`. Returns `matched: false`
 * when the text carries no recurrence cue (ordinary chat).
 *
 * The recurrence gate is deliberately PERMISSIVE (a stray "every …" can match)
 * — the parser is a pure function and does not decide WHEN it runs. The caller
 * (the chat authoring layer, a later part) is responsible for invoking it only
 * on a routine intent and for showing the parsed spec for confirmation before
 * anything is persisted. The empty-filter warning below is the backstop.
 */
export function parseRoutineSpec(text: string): RoutineParseResult {
  if (!text || !text.trim()) return { matched: false, reason: 'empty input' };
  // Bound work before any regex runs (DoS guard — see MAX_INPUT).
  const input = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  const t = input.toLowerCase();

  if (!hasRecurrence(t)) {
    return { matched: false, reason: 'no recurrence cue (not a routine)' };
  }

  const { cadence, dayOfWeek } = detectCadence(t);
  const hourOfDay = detectHourOfDay(t, cadence);
  const action = detectAction(t);

  const from = detectFrom(t);
  const filter: RoutineFilter = {};
  const sources = detectSources(t);
  if (sources.length) filter.sources = sources;
  if (from.values.length) filter.fromContains = from.values;
  const keywords = detectKeywords(input);
  if (keywords.length) filter.keywords = keywords;
  const domains = detectDomains(t);
  if (domains.length) filter.domains = domains;

  const specNoName: Omit<RoutineSpec, 'name'> = {
    cadence,
    ...(dayOfWeek !== undefined ? { dayOfWeek } : {}),
    ...(hourOfDay !== undefined ? { hourOfDay } : {}),
    filter,
    action,
  };
  const spec: RoutineSpec = { name: buildName(specNoName), ...specNoName };

  const warnings: string[] = [];
  const filterEmpty =
    !filter.sources?.length &&
    !filter.fromContains?.length &&
    !filter.keywords?.length &&
    !filter.domains?.length;
  if (filterEmpty) {
    warnings.push(
      'This routine would match every signal — add a sender, keyword, or source to narrow what it watches.',
    );
  }
  if (from.fuzzy) {
    warnings.push(
      'Couldn’t resolve a vague sender (e.g. “my biggest client”) to a specific address — matching the literal text for now; edit the routine to set the exact sender.',
    );
  }
  if (cadence === 'weekly' && distinctDayCount(t) > 1) {
    const day = dayOfWeek !== undefined ? DOW_NAME[dayOfWeek] : 'one day';
    warnings.push(
      `You named more than one day — this routine runs weekly on ${day} for now; edit it to adjust the day.`,
    );
  }
  if (UNSUPPORTED_INTERVAL.test(t)) {
    warnings.push(
      `I can only schedule hourly, daily, or weekly — approximated this as ${cadence}; edit the routine if that’s not what you meant.`,
    );
  }

  return { matched: true, spec, warnings };
}
