/**
 * Capability × source coverage matrix (#spec 07 step 4).
 *
 * One tested allowlist of which inbox-intelligence capability runs on which
 * signal source, so "does commitment extraction run on voice notes?" has a
 * single, auditable answer instead of scattered `if (source === 'gmail')`
 * checks. Spec 13 (coverage transparency) evaluates THIS matrix against the
 * connectors a user actually authorized.
 *
 * Rationale per capability:
 *  - commitments: authored content only — sent mail, calendar descriptions the
 *    user wrote, transcribed voice notes. NOT filesystem (files aren't promises).
 *  - deadlines: any text body, including idle-miner TODO/deadline comments.
 *  - security: inbound-notification shaped — email today (SMS/push later).
 *    Calendar/filesystem/voice don't carry breach alerts; off by design.
 *  - clusters / entities: source-agnostic — operate on normalized SignalText.
 *
 * Both the real source string and its mock are listed (gmail + email,
 * google_calendar + calendar) so dev/test fixtures get the same coverage.
 */

export type Capability =
  | 'commitments'
  | 'deadlines'
  | 'security'
  | 'clusters'
  | 'entities';

const ALL_TEXT_SOURCES = [
  'gmail',
  'email',
  'google_calendar',
  'calendar',
  'filesystem',
  'voice',
] as const;

export const CAPABILITY_SOURCE_MATRIX: Readonly<
  Record<Capability, ReadonlySet<string>>
> = {
  // Outlook signals are commitment-bearing just like their Google peers, and
  // `commitments` is the one capability whose extractor actually GATES on this
  // matrix (commitment-extractor early-returns []). `outlook`/`outlook_calendar`
  // must be members or Outlook mail + calendar produce zero commitments.
  // NOTE: the other capabilities' extractors do not gate on the matrix, so the
  // Outlook sources are intentionally only added here. Folding them into
  // `computeCoverage` (the source-coverage UI) needs an alternative-provider
  // model (gmail OR outlook fully covers email) so Google users aren't told
  // they're "missing Outlook" — tracked as a follow-up.
  commitments: new Set(['gmail', 'outlook', 'email', 'google_calendar', 'outlook_calendar', 'calendar', 'voice']),
  deadlines: new Set(ALL_TEXT_SOURCES),
  security: new Set(['gmail', 'email']),
  clusters: new Set(ALL_TEXT_SOURCES),
  entities: new Set(ALL_TEXT_SOURCES),
};

/**
 * Does `capability` run on signals from `source`? Unknown source → false
 * (a capability never silently runs on a source it wasn't allowlisted for).
 */
export function capabilityCoversSource(
  capability: Capability,
  source: string,
): boolean {
  return CAPABILITY_SOURCE_MATRIX[capability]?.has(source) ?? false;
}

/** All sources a capability is allowlisted for (sorted, for display/tests). */
export function sourcesForCapability(capability: Capability): string[] {
  return [...(CAPABILITY_SOURCE_MATRIX[capability] ?? [])].sort();
}
