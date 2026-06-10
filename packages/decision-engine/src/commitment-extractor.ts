/**
 * Commitment extraction from user-authored content (#spec 02, #475).
 *
 * Surfaces the user's OWN stated obligations ("I'll send the draft tomorrow")
 * as to-do candidates. Consumes the normalized `SignalText` (spec 07), so it
 * runs on any authored channel — sent mail, calendar descriptions the user
 * wrote, transcribed voice notes — not just email.
 *
 * Security boundary (safety invariant #8): commitments are extracted ONLY from
 * content the user authored (`authoredByUser`) and ONLY from sources the
 * capability matrix allowlists. Inbound "you agreed to X" is a poisoning vector
 * and must never become a self-imposed to-do.
 *
 * This module ships the deterministic rule extractor (zero-cost, always
 * available). An LLM strategy can be layered later via `CommitmentStrategy`;
 * the rule path is the fallback the spec requires.
 */

import type { SignalText } from './signal-text.js';
import { capabilityCoversSource } from './capability-source-matrix.js';

export interface Commitment {
  /** Normalized imperative ("Send the draft tomorrow"). */
  text: string;
  /** The source sentence, verbatim — for the ExplanationRecord / citation. */
  rawSpan: string;
  /** Raw temporal phrase ("tomorrow") if present — resolved by spec 03. */
  deadlineHint: string | null;
  /** Who the commitment was made to (recipients / attendees). */
  committedTo: string[];
  confidence: number;
}

/** Optional pluggable strategy (e.g. LLM). The rule extractor is the default. */
export interface CommitmentStrategy {
  extract(input: SignalText): Commitment[];
}

// First-person future-modal openers that signal a commitment.
const COMMIT_RE =
  /\b(i\s?['’]?\s?ll|i\s+will|i\s+can|i\s+am\s+going\s+to|i\s?['’]?m\s+going\s+to|let\s+me|i\s+shall)\b/i;

// Hypothetical / negated forms that look like commitments but aren't.
const NEGATE_RE = /\b(i\s+would|i\s?['’]?d\b|if\s+i|i\s+wo\s?n['’]?t|i\s+ca\s?n['’]?t|i\s+cannot)\b/i;

// Rough temporal-phrase detector for the deadline hint (not resolution).
// `by`/`on` are restricted to day/month/date followers so "by Bob"/"on Alice"
// don't read as deadlines (review #7).
const _DOW_MON =
  '(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|tomorrow|tonight';
const DEADLINE_HINT_RE = new RegExp(
  `\\b(today|tonight|tomorrow|this\\s+(?:week|morning|afternoon|evening|month)|next\\s+\\w+|` +
    `by\\s+(?:${_DOW_MON}|the\\s+\\d{1,2}|\\d{1,2})|on\\s+(?:${_DOW_MON}|the\\s+\\d{1,2}|\\d{1,2})|` +
    `in\\s+\\d+\\s+\\w+|within\\s+\\d+\\s+\\w+|\\d{1,2}\\/\\d{1,2})\\b`,
  'i',
);

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeImperative(sentence: string, modal: RegExpMatchArray): string {
  const after = sentence
    .slice((modal.index ?? 0) + modal[0].length)
    .replace(/^[\s,:-]+/, '')
    .replace(/^(?:make\s+sure\s+(?:to|that)?|going\s+to|to|that)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
  if (!after) return sentence.replace(/[.!?]+$/, '').trim();
  return after.charAt(0).toUpperCase() + after.slice(1);
}

function ruleExtract(input: SignalText): Commitment[] {
  const out: Commitment[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(input.body)) {
    if (sentence.endsWith('?')) continue; // questions aren't commitments
    // Split into clauses so a negation in ONE clause ("...if I have time...")
    // doesn't suppress a genuine commitment in another clause of the same
    // sentence (review #6).
    for (const clause of sentence.split(/\s*(?:[,;]|\band\b)\s*/i)) {
      if (NEGATE_RE.test(clause)) continue; // hypothetical / negated clause
      const modal = clause.match(COMMIT_RE);
      if (!modal) continue;

      const text = normalizeImperative(clause, modal);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue; // dedup restated commitments
      seen.add(key);

      const hintMatch = clause.match(DEADLINE_HINT_RE);
      out.push({
        text,
        rawSpan: clause.trim(),
        deadlineHint: hintMatch ? hintMatch[0] : null,
        committedTo: input.participants,
        confidence: 0.7,
      });
    }
  }
  return out;
}

/**
 * Extract commitments from a (normalized) signal. Returns [] for content the
 * user didn't author or sources the matrix doesn't allowlist for commitments.
 */
export function extractCommitments(
  input: SignalText,
  strategy?: CommitmentStrategy,
): Commitment[] {
  if (!input.authoredByUser) return [];
  if (!capabilityCoversSource('commitments', input.source)) return [];
  return strategy ? strategy.extract(input) : ruleExtract(input);
}
