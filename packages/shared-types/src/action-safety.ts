/**
 * Action-safety primitives — the documentary-poisoning defense.
 *
 * "Documentary poisoning" is prompt injection through content SkyTwin reads
 * but the user did not author: inbound email bodies, files discovered during
 * the idle filesystem crawl, web pages, calendar invites from other people.
 * An attacker who can get text in front of the twin may try to steer it into
 * a harmful action.
 *
 * The defense has two independent axes, deliberately kept separate:
 *
 *   1. `ActionProvenance` — WHERE the decision originated. This is the load-
 *      bearing security boundary. It does not care what the injected text
 *      says; it only cares whether the triggering content was authored by the
 *      user or arrived from the outside. A novel injection vector that nobody
 *      has seen before still lands in `untrusted_external` and is still gated.
 *
 *   2. `ActionSeverity` — HOW destructive the action shape is. This is a
 *      severity *hint*, not a security boundary. It decides one-click vs.
 *      two-click confirmation. It is pattern-based and therefore inherently
 *      incomplete — it will never enumerate every harmful action shape, which
 *      is exactly why axis 1 exists and does the real work.
 *
 * Nothing here hard-denies an action. Every action retains a path to
 * execution; the gate (see `@skytwin/policy-engine` `checkInjectionGuard`)
 * only ever escalates to human confirmation — single-click for destructive or
 * untrusted-and-irreversible actions, two-click for extreme ones.
 */

/**
 * Where the decision that produced an action originated.
 *
 * Ordered from most to least trusted. When provenance cannot be determined it
 * MUST default to `untrusted_external` — fail safe, never fail open.
 */
export type ActionProvenance =
  /** The user authored the triggering content: a sent email, an "ask your
   *  twin" request they typed, a calendar event they created. */
  | 'user_originated'
  /** The user's own profile, history, or learned preferences — trusted, but
   *  not a fresh instruction from the user. */
  | 'trusted_context'
  /** Inbound mail the user did not write, files found during the filesystem
   *  crawl, web content, calendar invites from other people. The injection
   *  surface. Treated as data, never as instructions. */
  | 'untrusted_external';

/**
 * How destructive an action's shape is. Severity *hint*, not a security
 * boundary — see the file-level comment.
 */
export type ActionSeverity =
  /** No special destructive shape. */
  | 'none'
  /** Destroys or sends user data in a way that needs a deliberate click:
   *  deleting mail/events, revoking a token, bulk/wildcard operations. */
  | 'destructive'
  /** Catastrophic shape — shell execution, recursive filesystem deletion,
   *  database drops/truncates, account deletion. Always two-click. */
  | 'extreme';

/**
 * How many deliberate human confirmations an escalated action needs.
 * `single` — one explicit approval. `dual` — two distinct confirmations,
 * the second token-gated (see the API approve endpoint).
 */
export type ConfirmationLevel = 'single' | 'dual';

/**
 * Map an authoring tier (from `@skytwin/connectors`, #251 Layer 1) plus the
 * raw signal source onto an `ActionProvenance`.
 *
 * The authoring-tier vocabulary is email-shaped but channel-agnostic by
 * design; this mapper is the one place that collapses it — plus non-email
 * sources — into the three-way provenance the policy gate consumes.
 *
 * @param source     Raw signal source, e.g. `gmail`, `google-calendar`,
 *                   `idle-miner`, `mock`, or a user-initiated marker.
 * @param authoringTier Optional `AuthoringTier` string when the signal
 *                   carries one (email signals do; filesystem signals do not).
 */
export function resolveActionProvenance(
  source: string,
  authoringTier?: string,
): ActionProvenance {
  // Email signals carry an authoring tier — the user-authored tiers are the
  // only ones that count as a trusted instruction source.
  if (authoringTier === 'user_sent_originated' || authoringTier === 'user_sent_reply') {
    return 'user_originated';
  }
  if (
    authoringTier === 'inbox_personal' ||
    authoringTier === 'inbox_broadcast' ||
    authoringTier === 'inbox_newsletter' ||
    authoringTier === 'inbox_automated'
  ) {
    return 'untrusted_external';
  }

  // Sources with no authoring tier — classify by source.
  switch (source) {
    // The user directly asked the twin to do something.
    case 'user_request':
    case 'ask_twin':
      return 'user_originated';
    // The user's own profile / learned state replayed back into a decision.
    case 'twin_profile':
    case 'preference_replay':
      return 'trusted_context';
    // The idle filesystem crawl: filenames and file contents are
    // attacker-controllable. Anything the miner surfaces is external data.
    case 'idle-miner':
    case 'idle_miner':
    case 'filesystem':
      return 'untrusted_external';
    // Anything we do not explicitly recognize fails safe.
    default:
      return 'untrusted_external';
  }
}

/**
 * Extreme-severity action-type markers. Matched case-insensitively as
 * substrings of `actionType`. Catastrophic shapes a personal email/calendar
 * twin should never perform without two deliberate confirmations.
 *
 * This list is a severity hint, not a security boundary — see the file
 * comment. New entries make the hint sharper; they are not what keeps the
 * user safe (provenance does).
 */
const EXTREME_ACTION_MARKERS: readonly string[] = [
  'shell',
  'exec',
  'spawn',
  'rm_rf',
  'rmrf',
  'wipe',
  'destroy',
  'format_disk',
  'drop_table',
  'drop_database',
  'truncate_table',
  'delete_account',
  'delete_user',
  'factory_reset',
  'purge_all',
];

/**
 * Destructive-severity action-type markers. Matched case-insensitively as
 * substrings of `actionType`.
 */
const DESTRUCTIVE_ACTION_MARKERS: readonly string[] = [
  'delete',
  'remove',
  'revoke',
  'unsubscribe',
  'archive_all',
  'empty_trash',
  'permanently',
  'forward_all',
  'bulk_',
];

/**
 * Parameter keys whose presence signals a bulk / wildcard operation — a
 * single action that fans out across many objects. Treated as at least
 * `destructive` regardless of the action-type string.
 */
const BULK_PARAMETER_KEYS: readonly string[] = [
  'all',
  'wildcard',
  'matchAll',
  'everything',
];

/**
 * Shell-metacharacter / dangerous-command signatures. If any string-valued
 * parameter contains one of these, the action is `extreme` — this catches the
 * case where a benign-looking `actionType` smuggles a destructive payload in
 * its parameters.
 */
const EXTREME_PARAMETER_SIGNATURES: readonly RegExp[] = [
  /\brm\s+-[a-z]*r/i, // rm -rf, rm -r, rm -fr
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /[;&|`$]\s*(rm|curl|wget|bash|sh|eval)\b/i,
  />\s*\/dev\/sd/i,
];

/**
 * Classify how destructive an action's shape is.
 *
 * Checks, in order of severity:
 *   1. Any string parameter matching an extreme command signature → `extreme`
 *      (catches destructive payloads smuggled through a benign actionType).
 *   2. `actionType` containing an extreme marker → `extreme`.
 *   3. `actionType` containing a destructive marker → `destructive`.
 *   4. A bulk/wildcard parameter key set truthy → `destructive`.
 *   5. Otherwise → `none`.
 *
 * Severity hint only — the policy gate pairs this with provenance, and
 * provenance is what actually keeps the user safe.
 */
export function classifyActionSeverity(action: {
  actionType: string;
  parameters?: Record<string, unknown>;
}): ActionSeverity {
  const type = (action.actionType ?? '').toLowerCase();
  const params = action.parameters ?? {};

  // 1. Extreme command signatures hidden in string parameters.
  for (const value of Object.values(params)) {
    if (typeof value === 'string') {
      for (const sig of EXTREME_PARAMETER_SIGNATURES) {
        if (sig.test(value)) {
          return 'extreme';
        }
      }
    }
  }

  // 2. Extreme actionType markers.
  for (const marker of EXTREME_ACTION_MARKERS) {
    if (type.includes(marker)) {
      return 'extreme';
    }
  }

  // 3. Destructive actionType markers.
  for (const marker of DESTRUCTIVE_ACTION_MARKERS) {
    if (type.includes(marker)) {
      return 'destructive';
    }
  }

  // 4. Bulk / wildcard parameter keys.
  for (const key of BULK_PARAMETER_KEYS) {
    if (key in params && params[key]) {
      return 'destructive';
    }
  }

  return 'none';
}

/**
 * The shape the injection guard returns. `escalate: false` means the action
 * may proceed through normal evaluation; `escalate: true` means it must be
 * routed to human confirmation at the given `confirmationLevel`.
 */
export interface InjectionGuardVerdict {
  escalate: boolean;
  confirmationLevel?: ConfirmationLevel;
  reason?: string;
}

/**
 * The injection guard — the documentary-poisoning defense, expressed as one
 * pure function so the policy engine (which escalates) and the execution
 * router (which backstops) consult identical logic and cannot drift.
 *
 * Never denies. Only escalates to human confirmation. The matrix:
 *
 *   - extreme severity (any provenance)      → dual-confirmation
 *   - destructive severity (any provenance)  → single-confirmation
 *   - untrusted provenance + irreversible    → single-confirmation
 *   - untrusted provenance + reversible/none → no escalation (the carve-out
 *       that keeps reversible, low-risk auto-archiving working — content
 *       cannot escape its own blast radius when the action is reversible)
 *   - everything else                        → no escalation
 *
 * Provenance is the load-bearing security boundary: it does not inspect what
 * any injected text says, only where the triggering content originated, so a
 * brand-new injection vector still lands in `untrusted_external` and is still
 * gated. Severity is a pattern-based hint layered on top to choose one-click
 * vs. two-click.
 *
 * Missing provenance fails safe — treated as `untrusted_external`.
 */
export function evaluateInjectionGuard(action: {
  actionType: string;
  parameters?: Record<string, unknown>;
  reversible: boolean;
  provenance?: ActionProvenance;
}): InjectionGuardVerdict {
  const severity = classifyActionSeverity(action);
  const provenance: ActionProvenance = action.provenance ?? 'untrusted_external';

  if (severity === 'extreme') {
    return {
      escalate: true,
      confirmationLevel: 'dual',
      reason:
        'Injection guard: this action has an extreme destructive shape ' +
        '(shell / filesystem / database / account destruction) and requires ' +
        'two deliberate confirmations before it can run.',
    };
  }

  if (severity === 'destructive') {
    return {
      escalate: true,
      confirmationLevel: 'single',
      reason:
        'Injection guard: this action destroys or sends data and requires ' +
        'explicit confirmation — it will never auto-execute.',
    };
  }

  if (provenance === 'untrusted_external' && !action.reversible) {
    return {
      escalate: true,
      confirmationLevel: 'single',
      reason:
        'Injection guard: this action was triggered by external content the ' +
        'user did not author and is not reversible — explicit confirmation ' +
        'is required.',
    };
  }

  return { escalate: false };
}
