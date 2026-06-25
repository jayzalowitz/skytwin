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
  /** Real sources that, if connected, would enable or enrich this capability. */
  unlockedBy: string[];
}

export interface SourceCoverage {
  connected: string[];
  /** Real sources not connected that would unlock/enrich some capability. */
  missing: string[];
  capabilityStatus: CapabilityStatus[];
  /** True when zero sources are connected (distinct from "connected but quiet"). */
  coldStart: boolean;
}

// Mock sources (dev/test) are not real connectable accounts; excluded from the
// coverage math so a real gmail user isn't told they're "missing" the email mock.
const MOCK_SOURCES = new Set(['email', 'calendar']);

// Some providers map to multiple sources.
// NOTE: `microsoft` (→ outlook + outlook_calendar) is intentionally NOT mapped
// here yet. The coverage model treats a capability's source set as "all enrich
// coverage", which has no notion of alternative providers — mapping microsoft
// would report `security: unavailable` for Outlook-only users (security-alert
// actually runs on Outlook mail; it just isn't in the matrix's security set)
// and nudge Google users to "connect Outlook". Both need the alternative-
// provider coverage redesign tracked alongside CAPABILITY_SOURCE_MATRIX.
function normalizeProvider(provider: string): string[] {
  if (provider === 'google') return ['gmail', 'google_calendar'];
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
 * Evaluate coverage for a user's connected accounts.
 *  - unavailable: no allowed source connected.
 *  - available: every (real) allowed source connected.
 *  - partial: some but not all allowed sources connected.
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

  const capabilityStatus: CapabilityStatus[] = COVERAGE_CAPABILITIES.map((cap) => {
    const allowed =
      cap === 'todos'
        ? ALL_REAL_SOURCES
        : realSources(CAPABILITY_SOURCE_MATRIX[cap as Capability] ?? new Set());
    const connectedAllowed = allowed.filter((s) => connectedSet.has(s));
    const missingAllowed = allowed.filter((s) => !connectedSet.has(s)).sort();

    let status: CapabilityStatus['status'];
    if (connectedAllowed.length === 0) status = 'unavailable';
    else if (missingAllowed.length === 0) status = 'available';
    else status = 'partial';

    return { capability: cap, status, unlockedBy: missingAllowed };
  });

  const missing = [
    ...new Set(
      capabilityStatus.flatMap((c) => (c.status === 'available' ? [] : c.unlockedBy)),
    ),
  ].sort();

  return { connected, missing, capabilityStatus, coldStart: connected.length === 0 };
}
