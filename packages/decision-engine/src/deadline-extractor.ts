/**
 * Deadline / temporal extraction from signal content (#spec 03, #476).
 *
 * The urgency machinery in `situation-interpreter.ts` already maps a `deadline`
 * field to an urgency tier — but nothing populated that field from free text, so
 * it was effectively dead for email/calendar/file/voice signals. This module is
 * the missing producer: it parses absolute and relative temporal expressions out
 * of a signal's title/body and resolves them to an absolute timestamp, which the
 * existing consumer then turns into urgency.
 *
 * Input is the minimal `DeadlineSource` shape, which the normalized `SignalText`
 * (spec 07) satisfies structurally — so this runs on any text-bearing source.
 * Pure and side-effect-free; uses the maintained `chrono-node` NL-date library
 * (Layer 1: tried-and-true) rather than a hand-rolled date grammar.
 */

import * as chrono from 'chrono-node';

export interface DeadlineSource {
  title: string;
  body: string;
  /** Reference anchor for relative phrases ("in 3 days", "Friday"). */
  occurredAt: Date;
}

export interface ExtractedDeadline {
  deadline: Date;
  /** The matched phrase ("in 2 days") — for the urgency ExplanationRecord. */
  rawPhrase: string;
  kind: 'absolute' | 'relative';
  confidence: number;
}

const RELATIVE_HINT =
  /\b(today|tonight|tomorrow|yesterday|in|within|next|this|last|day|days|week|weeks|month|months|hour|hours|minute|minutes|min|mins)\b/i;

function validDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * Extract the earliest credible FUTURE deadline from a signal's text, anchored
 * to `occurredAt`. Returns null when there is no temporal expression, or only
 * past-dated ones (a past "deadline" is noise, not urgency).
 *
 * Note (v1 limitation): timezone-aware end-of-day / weekday resolution is left
 * to chrono's reference-relative parsing; per-user-timezone resolution is a
 * spec 12 follow-up. Documented rather than silently approximated.
 */
export function extractDeadline(src: DeadlineSource): ExtractedDeadline | null {
  const ref = validDate(src.occurredAt) ? src.occurredAt : new Date();
  const text = `${src.title ?? ''}\n${src.body ?? ''}`.trim();
  if (!text) return null;

  let results: ReturnType<typeof chrono.parse>;
  try {
    // forwardDate biases bare day/weekday names to the upcoming occurrence.
    results = chrono.parse(text, ref, { forwardDate: true });
  } catch {
    return null;
  }

  const candidates: ExtractedDeadline[] = [];
  for (const r of results) {
    const date = r.start.date();
    if (!validDate(date)) continue;
    // Reject past/now deadlines relative to when the content was written.
    if (date.getTime() <= ref.getTime()) continue;

    const phrase = r.text;
    const kind: 'absolute' | 'relative' = RELATIVE_HINT.test(phrase)
      ? 'relative'
      : 'absolute';
    const certainDay = r.start.isCertain('day');
    const certainMonth = r.start.isCertain('month');
    const confidence =
      certainDay && certainMonth ? 0.9 : certainDay || kind === 'relative' ? 0.7 : 0.5;

    candidates.push({ deadline: date, rawPhrase: phrase, kind, confidence });
  }

  if (candidates.length === 0) return null;
  // The binding deadline is the earliest credible one.
  candidates.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
  return candidates[0]!;
}
