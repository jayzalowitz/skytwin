/**
 * No-code routines (#519) — a user describes, in plain language, something the
 * twin should watch for on a schedule ("every morning, summarize my calendar
 * conflicts and anything from my biggest client"). The chat front door parses
 * that into a structured `RoutineSpec`; the worker schedules it; each firing is
 * recorded with an `ExplanationRecord`.
 *
 * v1 is deliberately READ-ONLY. A routine summarizes / notifies on matching
 * signals — it never takes an outbound or destructive action on its own.
 * Action-taking routines (draft a reply, RSVP, file something) are a deliberate
 * follow-up: every such action must route through the policy engine + approval
 * path per firing, exactly like a one-off decision. Keeping v1 read-only means
 * a routine can be authored and run without ever bypassing the autonomy model.
 */

/** How often a routine fires. Coarse on purpose — v1 is digest/notify, not real-time. */
export type RoutineCadence = 'hourly' | 'daily' | 'weekly';

/**
 * What a routine does when it fires. Both are READ-ONLY:
 *  - `digest`  — roll matching signals into a short summary the user reads.
 *  - `notify`  — surface a notification when something matches (no summary body).
 * Neither sends, replies, schedules, deletes, or spends. See the file header.
 */
export type RoutineActionKind = 'digest' | 'notify';

export type RoutineStatus = 'draft' | 'active' | 'paused';

/**
 * A filter over incoming signals. All PRESENT fields must match (AND across
 * fields); within a list field, ANY entry matching counts (OR within a field).
 * An empty/absent field is "don't care". An all-empty filter matches every
 * signal — the parser flags that as a warning so a routine can't silently
 * fire on the user's entire stream.
 */
export interface RoutineFilter {
  /** Signal sources to include, e.g. `['gmail', 'outlook']` or `['google_calendar']`. Empty = any. */
  sources?: string[];
  /** Match when the sender/from contains any of these (case-insensitive substrings). */
  fromContains?: string[];
  /** Match when subject/title/body contains any of these keywords (case-insensitive). */
  keywords?: string[];
  /** Restrict to these decision/situation domains (e.g. `'scheduling'`, `'security'`). Empty = any. */
  domains?: string[];
}

/** The structured, schedulable description of a routine (the parser's output). */
export interface RoutineSpec {
  /** Short human label, e.g. "Morning calendar conflicts". */
  name: string;
  cadence: RoutineCadence;
  /** Hour of day (0-23, user-local) a daily/weekly routine fires. Ignored for hourly. */
  hourOfDay?: number;
  /** Day of week (0=Sunday … 6=Saturday) a weekly routine fires. Ignored otherwise. */
  dayOfWeek?: number;
  filter: RoutineFilter;
  action: RoutineActionKind;
}

/** A persisted routine — a `RoutineSpec` plus identity, ownership, and run state. */
export interface Routine extends RoutineSpec {
  id: string;
  userId: string;
  /** The original natural-language ask, preserved for the explanation + later editing. */
  sourceText: string;
  status: RoutineStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Last time the routine fired, or null if it never has. */
  lastRunAt: Date | null;
  /** Next scheduled firing, or null when paused/draft. */
  nextRunAt: Date | null;
}

/**
 * A persisted **Watch** — the stored form of a no-code routine (a read-only
 * signal watcher). Structurally identical to `Routine`; the distinct name keeps
 * it clear at the storage / API layer (`watches` table, `/api/watches`) that
 * this is the no-code, read-only feature, NOT the IronClaw cron `/api/routines`
 * execution primitive.
 */
export type Watch = Routine;

/**
 * Result of parsing a natural-language ask into a `RoutineSpec`.
 * `matched: false` means the text wasn't a recurring/routine intent (most chat
 * messages) — the caller should treat it as an ordinary message, not an error.
 */
export type RoutineParseResult =
  | { matched: true; spec: RoutineSpec; warnings: string[] }
  | { matched: false; reason: string };
