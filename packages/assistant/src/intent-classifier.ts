/**
 * Rule-based intent classifier for the assistant chat. Issue #148 v1.
 *
 * Phase 1 design choice: pure regex/keyword matching. Tradeoffs:
 *   - Predictable: same input → same intent. The user can read the source
 *     and know what triggers a routed action.
 *   - Auditable: every match is one regex line away from the safety
 *     surface. An LLM-based classifier would hide that behind a black box.
 *   - Limited recall: misses paraphrases. Acceptable for v1 because the
 *     fallback is the regular chat reply — no intent recognized just
 *     means the assistant talks about the request rather than acting on
 *     it. Phase 2 of #148 can layer an LLM classifier on top.
 *
 * Defines a small action vocabulary that maps cleanly to the
 * SituationType + actionType pairs the existing decision-engine knows
 * about. Adding a new intent here means adding regex + the produced
 * `ActionIntent` shape; the rest of the pipeline (DecisionMaker,
 * approval flow, execution router) handles the rest as if the intent
 * had arrived as a structured event signal.
 */

/**
 * Structured representation of a detected user-initiated action intent.
 * The shape is deliberately the subset of `DecisionObject` fields that
 * a chat-driven intent can populate — the route adapter fills in `id`,
 * `interpretedAt`, and any synthetic raw data the decision engine wants.
 */
export interface ActionIntent {
  /**
   * Mirrors `SituationType` from `@skytwin/shared-types`. We use the
   * string literal rather than importing the enum so this package stays
   * dependency-free of shared-types — the route adapter validates the
   * string against the real enum at the boundary.
   */
  situationType:
    | 'email_triage'
    | 'calendar_invite'
    | 'calendar_update'
    | 'task_management';
  /** Domain string the decision engine routes on (e.g. 'email', 'calendar'). */
  domain: string;
  /** Human-readable summary that becomes part of the DecisionObject. */
  summary: string;
  /**
   * Synthetic raw data shaped like the corresponding signal payload. The
   * decision engine reads these in candidate generation — for example
   * `archive_email` reads `rawData.emailId`, which a chat-driven intent
   * can't supply (we're acting on whatever email the user is referring
   * to in conversation, not a specific one). The engine's candidate
   * generators tolerate missing fields by falling back to safe defaults
   * (or producing a candidate that itself requires approval, which is
   * fine — a user explicitly asked for the action).
   */
  rawData: Record<string, unknown>;
  /**
   * Echoes the user's verbatim request. Used by the route to build the
   * approval-card description ("You said: archive that email") so the
   * approval surface explains what triggered it without the user having
   * to scroll the conversation.
   */
  triggerMessage: string;
}

/**
 * Minimum message length to even consider intent classification. Below
 * this we always fall through to chat — short messages are ambiguous
 * ("ok", "thanks", "sure") and routing them to the action pipeline
 * would create surprise approvals.
 */
const MIN_LENGTH_FOR_CLASSIFICATION = 8;

/**
 * Each rule maps a regex match against the user message to a structured
 * `ActionIntent`. First-match-wins iteration order — order rules from
 * most-specific to most-generic.
 */
interface IntentRule {
  pattern: RegExp;
  build(message: string, match: RegExpMatchArray): ActionIntent;
}

const RULES: IntentRule[] = [
  // ── Email actions ─────────────────────────────────────────────

  {
    // "archive that email", "archive this", "archive the receipt"
    pattern: /\barchive\s+(?:that|this|the|it)\b/i,
    build: (message) => ({
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Archive an email',
      rawData: { intent: 'archive_email', source: 'chat' },
      triggerMessage: message,
    }),
  },
  {
    // "label that email as receipts", "tag this as work"
    pattern: /\b(?:label|tag)\s+(?:that|this|the|it)\b.*?\bas\s+(?<label>[\w-]+)/i,
    build: (message, match) => ({
      situationType: 'email_triage',
      domain: 'email',
      summary: `Apply label "${match.groups?.label ?? 'auto'}" to email`,
      rawData: {
        intent: 'label_email',
        source: 'chat',
        label: match.groups?.label ?? null,
      },
      triggerMessage: message,
    }),
  },
  {
    // "reply to that email", "send a reply", "respond to it"
    pattern: /\b(?:reply\s+to|respond\s+to|send\s+a\s+reply)\b/i,
    build: (message) => ({
      situationType: 'email_triage',
      domain: 'email',
      summary: 'Send a reply to an email',
      rawData: { intent: 'send_reply', source: 'chat' },
      triggerMessage: message,
    }),
  },

  // ── Calendar actions ──────────────────────────────────────────

  {
    // "schedule a meeting with X", "book a meeting", "set up a call"
    pattern: /\b(?:schedule|book|set\s+up)\s+(?:a|an)\s+(?:meeting|call|appointment)\b/i,
    build: (message) => ({
      situationType: 'calendar_invite',
      domain: 'calendar',
      summary: 'Schedule a calendar event',
      rawData: { intent: 'create_event', source: 'chat' },
      triggerMessage: message,
    }),
  },
  {
    // "decline that meeting", "skip the meeting", "cancel my meeting"
    pattern: /\b(?:decline|skip|cancel)\s+(?:that|this|the|my)\s+(?:meeting|call|appointment|invite)\b/i,
    build: (message) => ({
      situationType: 'calendar_update',
      domain: 'calendar',
      summary: 'Decline or cancel a calendar event',
      rawData: { intent: 'decline_event', source: 'chat' },
      triggerMessage: message,
    }),
  },

  // ── Task / todo actions ────────────────────────────────────────

  {
    // "remind me to X", "add a task to X"
    pattern: /\b(?:remind\s+me\s+to|add\s+a\s+(?:task|todo|reminder)\s+to)\b/i,
    build: (message) => ({
      situationType: 'task_management',
      domain: 'tasks',
      summary: 'Create a task or reminder',
      rawData: { intent: 'create_task', source: 'chat' },
      triggerMessage: message,
    }),
  },
];

/**
 * Detect an action intent in a free-text user message.
 *
 * Returns null when no rule matches OR when the message is too short to
 * classify confidently. Null means "treat this as conversation" — the
 * route falls through to the LLM chat path.
 *
 * Pure function, no I/O. Order of rules in `RULES` is significant:
 * first match wins. Add new rules at the most-specific position to
 * avoid masking them with broader catch-all patterns.
 */
export function detectIntent(message: string): ActionIntent | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (trimmed.length < MIN_LENGTH_FOR_CLASSIFICATION) return null;

  for (const rule of RULES) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      return rule.build(trimmed, match);
    }
  }
  return null;
}
