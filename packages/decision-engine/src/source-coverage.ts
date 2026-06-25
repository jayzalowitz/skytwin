/**
 * Source-coverage model (#spec 13, #487).
 *
 * Given which connectors a user authorized, computes what the digest CAN and
 * CANNOT surface, per capability — the inverse of spec 07's capability×source
 * matrix. Drives graceful degradation ("a capability no-ops cleanly when its
 * source is absent") and coverage transparency ("Calendar not connected — connect
 * it for meeting to-dos"). Pure + testable; the UI affordances live in spec 08.
 */

import { CAPABILITY_SOURCE_MATRIX, type Capability } from './capability-source-matrix.js';

export interface ConnectedAccountInfo {
  provider: string;
  scopes: string[];
  isActive: boolean;
}

export type CoverageCapability = Capability | 'todos';

export interface CapabilityStatus {
  capability: CoverageCapability;
  status: 'available' | 'partial' | 'unavailable';
  /**
   * Human-meaningful source-group labels that, if connected, would enable or
   * enrich this capability (e.g. `["a calendar", "voice"]`). Labels are groups,
   * not raw source ids, so a Gmail user is told "connect a calendar" rather than
   * the redundant/jargon "connect google_calendar, outlook_calendar".
   */
  unlockedBy: string[];
}

export interface SourceCoverage {
  /** Real source ids the user has connected (e.g. `["gmail", "google_calendar"]`). */
  connected: string[];
  /** Source-group labels not connected that would unlock/enrich some capability. */
  missing: string[];
  capabilityStatus: CapabilityStatus[];
  /** True when zero sources are connected (distinct from "connected but quiet"). */
  coldStart: boolean;
}

// Mock sources (dev/test) are not real connectable accounts; excluded from the
// coverage math so a real gmail user isn't told they're "missing" the email mock.
const MOCK_SOURCES = new Set(['email', 'calendar']);

/**
 * Source equivalence groups. Gmail and Outlook are ALTERNATIVE email sources,
 * not complementary ones — connecting either fully covers "email"; likewise
 * Google and Outlook calendars both cover "a calendar". Coverage is computed
 * over these groups (a group is satisfied by ANY connected member), so an
 * Outlook-only user gets the same coverage a Gmail user does, and a Gmail user
 * is never nudged to "also connect Outlook". The `label` is what the UI shows.
 */
const SOURCE_GROUPS: ReadonlyArray<{ key: string; label: string; members: ReadonlyArray<string> }> = [
  { key: 'email', label: 'email', members: ['gmail', 'outlook'] },
  { key: 'calendar', label: 'a calendar', members: ['google_calendar', 'outlook_calendar'] },
  { key: 'filesystem', label: 'files', members: ['filesystem'] },
  { key: 'voice', label: 'voice', members: ['voice'] },
];

/** Map a real source id to its group. Ungrouped sources are their own singleton group. */
function groupFor(source: string): { key: string; label: string } {
  for (const g of SOURCE_GROUPS) {
    if (g.members.includes(source)) return { key: g.key, label: g.label };
  }
  return { key: source, label: source };
}

/** Dedupe a list of groups by key, preserving first-seen label + order. */
function dedupeGroups(groups: Array<{ key: string; label: string }>): Array<{ key: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; label: string }> = [];
  for (const g of groups) {
    if (seen.has(g.key)) continue;
    seen.add(g.key);
    out.push(g);
  }
  return out;
}

// A provider can yield multiple sources; alternative providers (google vs
// microsoft) map to the same source GROUPS so coverage treats them as peers.
function normalizeProvider(provider: string): string[] {
  if (provider === 'google') return ['gmail', 'google_calendar'];
  if (provider === 'microsoft') return ['outlook', 'outlook_calendar'];
  return [provider];
}

function realSources(sources: Iterable<string>): string[] {
  return [...sources].filter((s) => !MOCK_SOURCES.has(s));
}

const ALL_REAL_SOURCES = [
  ...new Set(realSources(Object.values(CAPABILITY_SOURCE_MATRIX).flatMap((s) => [...s]))),
];

const COVERAGE_CAPABILITIES: CoverageCapability[] = [
  'todos',
  'commitments',
  'deadlines',
  'security',
  'clusters',
  'entities',
];

/**
 * Evaluate coverage for a user's connected accounts, over source GROUPS:
 *  - unavailable: no allowed group connected.
 *  - available: every allowed group connected (a group = any one of its members).
 *  - partial: some but not all allowed groups connected.
 */
export function computeCoverage(accounts: ConnectedAccountInfo[]): SourceCoverage {
  const connectedSet = new Set<string>();
  for (const a of accounts) {
    if (a.isActive) {
      for (const s of normalizeProvider(a.provider)) {
        if (!MOCK_SOURCES.has(s)) connectedSet.add(s);
      }
    }
  }
  const connected = [...connectedSet].sort();
  const connectedGroupKeys = new Set([...connectedSet].map((s) => groupFor(s).key));

  const capabilityStatus: CapabilityStatus[] = COVERAGE_CAPABILITIES.map((cap) => {
    const allowedReal =
      cap === 'todos'
        ? ALL_REAL_SOURCES
        : realSources(CAPABILITY_SOURCE_MATRIX[cap as Capability] ?? new Set());
    const allowedGroups = dedupeGroups(allowedReal.map(groupFor));
    const connectedAllowed = allowedGroups.filter((g) => connectedGroupKeys.has(g.key));
    const missingGroups = allowedGroups.filter((g) => !connectedGroupKeys.has(g.key));

    let status: CapabilityStatus['status'];
    if (connectedAllowed.length === 0) status = 'unavailable';
    else if (missingGroups.length === 0) status = 'available';
    else status = 'partial';

    return { capability: cap, status, unlockedBy: missingGroups.map((g) => g.label).sort() };
  });

  const missing = [
    ...new Set(
      capabilityStatus.flatMap((c) => (c.status === 'available' ? [] : c.unlockedBy)),
    ),
  ].sort();

  return { connected, missing, capabilityStatus, coldStart: connected.length === 0 };
}
