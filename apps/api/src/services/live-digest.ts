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
            o.requires_approval, o.auto_executed, o.escalation_reason
     FROM decisions d
     LEFT JOIN decision_outcomes o ON o.decision_id = d.id
     WHERE d.user_id = $1
     ORDER BY d.created_at DESC
     LIMIT 30`,
    [userId],
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
    const signalText = toSignalText({
      id: r.id,
      source: typeof raw.source === 'string' ? raw.source : 'unknown',
      type: typeof raw.type === 'string' ? raw.type : 'unknown',
      data:
        raw.data && typeof raw.data === 'object'
          ? (raw.data as Record<string, unknown>)
          : {},
      timestamp: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    });
    const text =
      signalText.title.trim() ||
      signalText.body.trim() ||
      r.summary ||
      `${r.situation_type.replace(/_/g, ' ')} needs review`;

    const actionRequired = needsYou(r);
    const urgency = (r.urgency && VALID_URGENCY.has(r.urgency)
      ? r.urgency
      : 'low') as DigestItem['urgency'];
    const blockedReasons = actionRequired
      ? [r.escalation_reason ?? 'trust_tier:observer']
      : [];

    const sourceType = sourceLabel(signalText.source);
    detailByRef.set(
      r.id,
      buildDigestItemDetail({
        // Inbound/ingested content the user did not author is untrusted-origin
        // (safety #8); user-authored signals (spec 07) are trusted context.
        provenance: signalText.authoredByUser ? 'user_originated' : 'untrusted_external',
        domain: r.domain,
        requiresApproval: actionRequired,
        blockedReasons,
        explanation: r.summary,
        sourceRefs: [`${sourceType}:${r.id.slice(0, 8)}`],
      }),
    );

    return {
      ref: r.id,
      text,
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
  const digest = buildDigest(items, { maxTodos: 7 });

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
