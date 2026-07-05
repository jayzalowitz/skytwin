import type { RoutineFilter } from '@skytwin/shared-types';

/**
 * A `domains` filter entry is a topical tag (the parser emits `security` /
 * `scheduling`), not a literal word to find. Expand each to the related terms
 * the parser itself recognizes, so a `security` watch actually catches
 * phishing/suspicious/fraud messages — not only ones containing "security".
 * An unknown domain falls back to a literal match on itself.
 */
const DOMAIN_TERMS: Record<string, string[]> = {
  security: ['security', 'phishing', 'suspicious', 'breach', 'compromis', 'fraud'],
  scheduling: ['scheduling', 'conflict', 'double-book', 'double book', 'reschedul'],
};

/**
 * A signal reduced to the fields a Watch filter matches on (#519). The worker
 * (a later part) builds this from a stored signal — `source` is the channel
 * (`gmail`/`outlook`/`google_calendar`/…), `from` is the sender/organizer, and
 * `text` is the subject + body/snippet + title concatenated.
 */
export interface MatchableSignal {
  source: string;
  from: string;
  text: string;
}

/**
 * Does a signal match a Watch's filter? AND across present fields, OR within a
 * field; an absent/empty field is "don't care". An all-empty filter matches
 * everything — but the API forbids an *active* all-empty watch (it's forced to
 * draft), so the scheduler only ever runs this on narrowed filters.
 *
 * `keywords` and `domains` both match against the signal text — `domains` are
 * the parser's topical tags (e.g. `scheduling`, `security`), matched as text
 * needles rather than a separate taxonomy.
 */
export function matchesFilter(sig: MatchableSignal, filter: RoutineFilter): boolean {
  const source = sig.source.toLowerCase();
  const from = sig.from.toLowerCase();
  const text = sig.text.toLowerCase();

  if (filter.sources?.length && !filter.sources.some((s) => s.toLowerCase() === source)) {
    return false;
  }
  if (filter.fromContains?.length && !filter.fromContains.some((f) => from.includes(f.toLowerCase()))) {
    return false;
  }
  // `keywords` and `domains` are SEPARATE fields — AND across them, OR within
  // each (per the RoutineFilter contract). Do NOT merge them into one list.
  if (filter.keywords?.length && !filter.keywords.some((k) => text.includes(k.toLowerCase()))) {
    return false;
  }
  if (filter.domains?.length) {
    const terms = filter.domains.flatMap((dRaw) => {
      const d = dRaw.toLowerCase();
      return DOMAIN_TERMS[d] ?? [d];
    });
    if (!terms.some((k) => text.includes(k))) return false;
  }
  return true;
}
