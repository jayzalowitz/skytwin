/**
 * Live digest: compute the structured to-do/FYI digest (spec 01/04) directly
 * from the user's recent decisions, so the briefing page renders real parity
 * even before the worker's structured-payload generation seam lands. This is
 * the integration that makes the digest VISIBLE end-to-end.
 *
 *   decisions (+ outcomes + connected accounts)
 *     -> SignalText (spec 07) -> DigestItem[]
 *     -> buildDigest()  -> { todos, topics, coverage, handledCount }
 *
 * The digest TEXT comes from the underlying RawSignal via toSignalText (spec
 * 07) — the same source-agnostic accessor the extractors use — not the generic
 * rule-based decision summary. That gives real, human titles ("Account notice",
 * "Trial ending soon", a calendar event title, a voice-note transcript line)
 * across every source instead of "Email triage needed for an email from gmail".
 */

import { query } from '@skytwin/db';
import {
  buildDigest,
  buildDigestItemDetail,
  computeCoverage,
  toSignalText,
  type DigestItem,
  type Digest,
} from '@skytwin/decision-engine';

/** Most-recent decisions scanned to assemble one digest (perf + relevance bound). */
const RECENT_DECISIONS_WINDOW = 30;

interface DecisionDigestRow {
  id: string;
  raw_event: unknown;
  summary: string | null;
  domain: string | null;
  urgency: string | null;
  situation_type: string;
  created_at: string | Date;
  requires_approval: boolean | null;
  auto_executed: boolean | null;
  escalation_reason: string | null;
  confidence: number | null;
  selected_action_desc: string | null;
  selected_action_type: string | null;
}

interface AccountRow {
  provider: string;
  scopes: string[] | null;
  is_active: boolean;
}

/** Map a RawSignal source channel to the digest's source-type label. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'gmail':
    case 'email':
      return 'email';
    case 'google_calendar':
    case 'calendar':
      return 'calendar';
    case 'filesystem':
      return 'file';
    case 'voice':
      return 'voice';
    default:
      return source || 'app';
  }
}

const VALID_URGENCY = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Normalize a stored urgency to the DigestItem union. The decisions table
 * defaults urgency to 'normal' (decisionRepository.create), which isn't in the
 * union — map it to 'medium' rather than silently demoting it to 'low'.
 */
export function normalizeUrgency(u: string | null): NonNullable<DigestItem['urgency']> {
  if (u === 'normal') return 'medium';
  return (u && VALID_URGENCY.has(u) ? u : 'low') as NonNullable<DigestItem['urgency']>;
}

/**
 * A human "why this urgency" line for the power view — the real driver, not a
 * generic "Default for <domain>" placeholder.
 */
export function urgencyReasonFor(row: {
  situation_type: string;
  urgency: string | null;
}): string {
  if (row.situation_type === 'security_alert') {
    return 'Security alert — always sent to you, never auto-handled';
  }
  if (row.situation_type === 'calendar_invite') return 'New invite — awaiting your RSVP';
  switch (normalizeUrgency(row.urgency)) {
    case 'critical':
      return 'Critical — flagged for immediate attention';
    case 'high':
      return 'High urgency';
    case 'medium':
      return 'Normal priority';
    default:
      return 'Routine — no deadline detected';
  }
}

/**
 * The twin's recommended next step for an item — phrased for the user, not the
 * system. Driven by the pipeline's selected action TYPE (structured and
 * reliable) mapped to a plain-English instruction, so every item gets a clean
 * suggestion instead of the engine's raw internal text ("Apply appropriate
 * labels to this email", "Escalate to user: Decision needed regarding: …").
 */
const ACTION_SUGGESTIONS: Record<string, string> = {
  accept_invite: 'Accept the invite, or decline / propose another time.',
  tentative_accept: 'Tentatively accept, or decide later.',
  decline_invite: 'Decline this invite.',
  respond_to_event: 'Reply to the invite — accept, decline, or propose a time.',
  archive_email: "Nothing needed — I'll archive it.",
  label_email: "Nothing needed — I'll file it for you.",
  draft_email: 'Review the draft reply I prepared.',
  send_email: 'Review and send when you’re ready.',
  acknowledge: 'Just an update — no reply needed.',
  dismiss: 'Dismiss it once you’ve seen it.',
  organize_file: "I'll file it where it belongs.",
  summarize_document: 'Open it, or ask me for a summary.',
  share_document: 'Share it with the right people.',
  create_note: 'Saved as a note — open it when you need it.',
  escalate_to_user: 'Take a look and tell me what to do.',
};

export function suggestedActionFor(row: {
  selected_action_type: string | null;
  situation_type: string;
}): string | null {
  // Security alerts get a specific, safe instruction regardless of the engine's
  // generic escalate action.
  if (row.situation_type === 'security_alert') {
    return "Open your account's security settings and confirm this sign-in — don't use links in the message.";
  }
  const byType = row.selected_action_type
    ? ACTION_SUGGESTIONS[row.selected_action_type]
    : undefined;
  if (byType) return byType;
  // No selected action: fall back on the situation.
  switch (row.situation_type) {
    case 'calendar_invite':
      return 'Reply to the invite — accept, decline, or propose a time.';
    case 'calendar_update':
      return 'Just an update — no reply needed.';
    case 'document_management':
      return "I'll file it; open it if you want to review.";
    default:
      return 'Take a look and decide what to do.';
  }
}

/** First non-empty string field from a signal's data payload. */
function senderRef(data: Record<string, unknown>): string | null {
  for (const key of ['from', 'organizer', 'fileName', 'path']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * A decision belongs in the TO-DO bucket (needs you) when the engine escalated
 * it for approval, OR it is escalate-only by nature (a security alert, spec 06),
 * OR a new calendar invite awaiting your RSVP, OR high/critical urgency.
 * Everything else is awareness-only (FYI). Derived purely from real decision
 * attributes — no hand-tuning per item.
 */
export function needsYou(row: {
  requires_approval: boolean | null;
  situation_type: string;
  urgency: string | null;
}): boolean {
  if (row.requires_approval === true) return true;
  if (row.situation_type === 'security_alert') return true; // escalate-only (spec 06)
  if (row.situation_type === 'calendar_invite') return true; // needs an RSVP
  return row.urgency === 'high' || row.urgency === 'critical';
}

export interface LiveDigest extends Digest {
  handledCount: number;
}

/**
 * Build the structured digest for a user from their recent decisions. Returns
 * null when the user has no decisions (caller falls back to prose / empty).
 */
export async function buildLiveDigest(userId: string): Promise<LiveDigest | null> {
  const decisions = await query<DecisionDigestRow>(
    `SELECT d.id,
            d.raw_event,
            (d.interpreted_situation->>'summary') AS summary,
            d.domain, d.urgency, d.situation_type, d.created_at,
            o.requires_approval, o.auto_executed, o.escalation_reason, o.confidence,
            sel.description AS selected_action_desc,
            sel.action_type AS selected_action_type
     FROM decisions d
     LEFT JOIN decision_outcomes o ON o.decision_id = d.id
     LEFT JOIN candidate_actions sel ON sel.id = o.selected_action_id
     WHERE d.user_id = $1
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [userId, RECENT_DECISIONS_WINDOW],
  );
  if (decisions.rows.length === 0) return null;

  // Power-view detail (spec 14) is attached to each todo/topic by ref AFTER
  // buildDigest (the generator's job — buildDigest itself leaves it unset).
  const detailByRef = new Map<string, ReturnType<typeof buildDigestItemDetail>>();

  const items: DigestItem[] = decisions.rows.map((r) => {
    // Reconstruct the RawSignal the decision was made from and read its text
    // through the spec-07 accessor (source-agnostic title/body/source).
    const raw = (r.raw_event ?? {}) as {
      source?: unknown;
      type?: unknown;
      data?: unknown;
    };
    const data: Record<string, unknown> =
      raw.data && typeof raw.data === 'object'
        ? (raw.data as Record<string, unknown>)
        : {};
    const signalText = toSignalText({
      id: r.id,
      source: typeof raw.source === 'string' ? raw.source : 'unknown',
      type: typeof raw.type === 'string' ? raw.type : 'unknown',
      data,
      timestamp: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    });
    const text =
      signalText.title.trim() ||
      signalText.body.trim() ||
      r.summary ||
      `${r.situation_type.replace(/_/g, ' ')} needs review`;
    // The real content (what it actually says) — only when distinct from the
    // title, so we don't echo the same line twice. Capped to keep the digest
    // scannable.
    const bodyText = signalText.body.trim();
    const body =
      bodyText && bodyText !== text
        ? bodyText.length > 200
          ? `${bodyText.slice(0, 199)}…`
          : bodyText
        : undefined;

    const actionRequired = needsYou(r);
    const urgency = normalizeUrgency(r.urgency);
    // Honest "why not auto-run": the engine's real escalation reason if it has
    // one, else the trust-tier gate ONLY when it genuinely required approval.
    // A to-do that's escalate-only by nature (security/RSVP) but wasn't
    // approval-gated gets no fabricated reason ("Set aside for your review").
    const blockedReasons = r.escalation_reason
      ? [r.escalation_reason]
      : r.requires_approval === true
        ? ['trust_tier:observer']
        : [];

    const sourceType = sourceLabel(signalText.source);
    // Meaningful source ref: who/what it came from (sender, organizer, file),
    // not an opaque internal id slice.
    const sender = senderRef(data);
    detailByRef.set(
      r.id,
      buildDigestItemDetail({
        // Inbound/ingested content the user did not author is untrusted-origin
        // (safety #8); user-authored signals (spec 07) are trusted context.
        provenance: signalText.authoredByUser ? 'user_originated' : 'untrusted_external',
        confidence: typeof r.confidence === 'number' ? r.confidence : undefined,
        domain: r.domain,
        urgencyReason: urgencyReasonFor(r),
        suggestedAction: suggestedActionFor(r) ?? undefined,
        requiresApproval: actionRequired,
        blockedReasons,
        sourceRefs: [sender ? `${sourceType}: ${sender}` : sourceType],
      }),
    );

    return {
      ref: r.id,
      text,
      body,
      actionRequired,
      domain: r.domain,
      sourceType,
      urgency,
    };
  });

  // Coverage for the power-view panel, from the user's connected accounts.
  const accounts = await query<AccountRow>(
    `SELECT provider, scopes, is_active FROM connected_accounts WHERE user_id = $1`,
    [userId],
  );
  const coverage = computeCoverage(
    accounts.rows.map((a) => ({
      provider: a.provider,
      scopes: a.scopes ?? [],
      isActive: a.is_active,
    })),
  );

  const handledCount = decisions.rows.filter((r) => r.auto_executed === true).length;
  const digest = buildDigest(items); // maxTodos defaults to 7

  // Attach power-view detail (spec 14) to each surfaced todo/topic item by ref.
  for (const todo of digest.todos) {
    todo.detail = detailByRef.get(todo.ref);
  }
  for (const topic of digest.topics) {
    for (const item of topic.items) {
      item.detail = detailByRef.get(item.ref);
    }
  }

  return { ...digest, coverage, handledCount };
}
