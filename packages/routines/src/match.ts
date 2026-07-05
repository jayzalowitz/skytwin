import type { RoutineFilter } from '@skytwin/shared-types';

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
  const needles = [...(filter.keywords ?? []), ...(filter.domains ?? [])];
  if (needles.length && !needles.some((k) => text.includes(k.toLowerCase()))) {
    return false;
  }
  return true;
}
