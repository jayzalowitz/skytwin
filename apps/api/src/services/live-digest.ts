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
  extractCommitments,
  linkEntitiesAcrossSignals,
  toSignalText,
  type Commitment,
  type DigestItem,
  type Digest,
  type ResolvedEntity,
  type SignalText,
  type SignalVisibilityMeta,
} from '@skytwin/decision-engine';

/**
 * Cross-signal entity linking (spec 05, #478) collapse switch. Default ON;
 * `ENTITY_LINKING=off` is the rollback path from the issue's rollback plan —
 * with it off, no entities are extracted and the digest keeps the un-collapsed
 * spec-04 clustering (possible cross-cluster repetition of one matter).
 */
export function entityLinkingEnabled(): boolean {
  return process.env['ENTITY_LINKING'] !== 'off';
}

/** Most-recent decisions scanned to assemble one digest (perf + relevance bound). */
const RECENT_DECISIONS_WINDOW = 30;

/**
 * Commitment extraction (#475 / spec 02) is on by default. The issue's rollback
 * plan is `COMMITMENT_EXTRACTION=off`: when set, no commitment to-dos are emitted
 * and the extractor is never invoked (it is pure and side-effect-free otherwise).
 */
function commitmentExtractionEnabled(): boolean {
  return process.env.COMMITMENT_EXTRACTION !== 'off';
}

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
    case 'outlook':
    case 'email':
      return 'email';
    case 'google_calendar':
    case 'outlook_calendar':
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
      return 'Urgent — needs your attention now';
    case 'high':
      return 'Time-sensitive — worth a look soon';
    case 'medium':
      return 'Not time-sensitive — just so you’re aware';
    default:
      return 'Routine — nothing time-sensitive, just keeping you in the loop';
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

/** The actual sender of a signal (email from / event organizer), if any. */
function senderRef(data: Record<string, unknown>): string | null {
  for (const key of ['from', 'organizer']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Normalize a raw sender ref ("Name <a@b>" or "a@b") to the bare, lowercased
 * address used as the join key against `brain_pages.metadata.fromAddress`. This
 * MUST match the write-time normalization in
 * `@skytwin/memory-gbrain`'s embedded port (angle-bracket extraction + lower),
 * or the pin/hide override won't line up with the digest item.
 */
export function bareAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^>]+)>/);
  const bare = (angle?.[1] ? angle[1].trim() : trimmed).toLowerCase();
  return bare.length > 0 ? bare : null;
}

interface SenderOverrideRow {
  from_address: string;
  user_override: string;
}

/**
 * Per-sender pin/hide overrides (#270) keyed by the bare `fromAddress`, read
 * from the canonical `brain_pages.metadata` store the pin/hide controls write
 * to. When a sender has BOTH 'hidden' and 'pinned' pages (e.g. a bulk-hide
 * after an individual pin), 'hidden' wins — fail safe toward not surfacing
 * content the user asked to hide.
 *
 * Returns an empty map (not an error) on a missing/empty brain — the digest
 * simply applies no overrides, identical to pre-#485 behavior.
 */
async function fetchSenderOverrides(userId: string): Promise<Map<string, SignalVisibilityMeta>> {
  const map = new Map<string, SignalVisibilityMeta>();
  let rows: { rows: SenderOverrideRow[] };
  try {
    rows = await query<SenderOverrideRow>(
      `SELECT lower(metadata->>'fromAddress') AS from_address,
              metadata->>'userOverride'       AS user_override
         FROM brain_pages
        WHERE user_id = $1
          AND metadata->>'fromAddress' IS NOT NULL
          AND metadata->>'userOverride' IN ('hidden', 'pinned')`,
      [userId],
    );
  } catch {
    // brain_pages may not exist on a mempalace-only deployment, or the brain
    // may be transiently unavailable. Degrade to no overrides so the digest
    // still renders rather than erroring the whole briefing (resilience
    // intent of #485). The memory retrieval layer independently applies its
    // own hide gate at search time, so this is a second filter, not the only
    // one — failing it open does not surface content the search layer hid.
    return map;
  }
  for (const r of rows.rows) {
    if (!r.from_address) continue;
    const existing = map.get(r.from_address);
    // 'hidden' is the dominant signal — once a sender is hidden, a later
    // 'pinned' row for the same sender must not un-hide it.
    if (existing?.userOverride === 'hidden') continue;
    map.set(r.from_address, { userOverride: r.user_override });
  }
  return map;
}

/** Friendly "where it's from" when there's no concrete sender. */
const SOURCE_FRIENDLY: Record<string, string> = {
  email: 'your inbox',
  calendar: 'your calendar',
  file: 'your files',
  voice: 'a voice note',
  app: 'an app',
};

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
 * Result of folding one decision's user-authored signal into commitment to-dos.
 * `items` are extra DigestItems (one per distinct commitment); `details` carry
 * their power-view detail keyed by the synthetic item ref.
 */
interface CommitmentFold {
  items: DigestItem[];
  details: Map<string, ReturnType<typeof buildDigestItemDetail>>;
}

/**
 * Turn the commitments the user stated in one authored signal into to-do items.
 *
 * Safety: extractCommitments already gates on `authoredByUser` AND the capability
 * matrix (commitments run on authored mail/calendar/voice only — never inbound
 * content, safety invariant #8). Each emitted to-do is `user_originated`
 * provenance and carries an explanation citing the user's own sentence
 * (`rawSpan`), satisfying invariant #2.
 *
 * Refs are synthesized as `${decisionId}#commit-${n}` so they're unique and
 * never collide with the decision's own digest item. Dedup across the same
 * authored content is keyed on `(decisionId, normalized commitment text)`.
 */
function commitmentTodosFor(
  decisionId: string,
  signalText: SignalText,
  occurredAtIso: string | undefined,
  domain: string | null,
): CommitmentFold {
  const items: DigestItem[] = [];
  const details = new Map<string, ReturnType<typeof buildDigestItemDetail>>();
  if (!signalText.authoredByUser) return { items, details };

  let commitments: Commitment[];
  try {
    commitments = extractCommitments(signalText);
  } catch {
    return { items, details }; // never let extraction break the digest
  }

  const seen = new Set<string>();
  let n = 0;
  for (const c of commitments) {
    const text = c.text.trim();
    if (!text) continue;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) continue; // restated commitment → one to-do (AC #4)
    seen.add(dedupeKey);

    const ref = `${decisionId}#commit-${n++}`;
    const sourceType = sourceLabel(signalText.source);
    // Citation: the user's verbatim sentence is the evidence for this to-do.
    const rawSpan = c.rawSpan.trim();
    items.push({
      ref,
      text,
      body: rawSpan || undefined,
      actionRequired: true, // a self-imposed commitment is something you owe
      domain,
      sourceType,
      deadline: c.deadlineHint,
      urgency: 'medium',
    });
    details.set(
      ref,
      buildDigestItemDetail({
        // The user authored this — it is the highest-trust provenance.
        provenance: 'user_originated',
        confidence: c.confidence,
        deadlinePhrase: c.deadlineHint,
        domain,
        urgencyReason: 'You said you’d do this — surfacing it so it doesn’t slip.',
        suggestedAction: 'Follow through, or tell me to drop it.',
        occurredAt: occurredAtIso,
        sourceRefs:
          c.committedTo.length > 0
            ? c.committedTo
            : [SOURCE_FRIENDLY[sourceType] ?? sourceType],
        // Explanation cites the user's own words (safety invariant #2).
        explanation: rawSpan ? `From what you wrote: “${rawSpan}”` : null,
      }),
    );
  }
  return { items, details };
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

  // Per-sender pin/hide overrides (#270/#485) from the canonical
  // brain_pages.metadata store. Read alongside the decisions so buildDigest's
  // filterVisible can drop hidden senders and surface pinned ones. A brain
  // that's empty (no gbrain pages yet) yields an empty map → no overrides.
  const senderOverrides = await fetchSenderOverrides(userId);

  // Power-view detail (spec 14) is attached to each todo/topic by ref AFTER
  // buildDigest (the generator's job — buildDigest itself leaves it unset).
  const detailByRef = new Map<string, ReturnType<typeof buildDigestItemDetail>>();

  const commitmentsOn = commitmentExtractionEnabled();
  // Per-signal text kept by ref so cross-signal entity linking (#478) can run
  // over the same SignalText the digest text is read from — no re-parse.
  const signalTextByRef = new Map<string, SignalText>();

  // flatMap (not map): a decision can yield its own item PLUS any commitment
  // to-dos extracted from its authored content (#475).
  const items: DigestItem[] = decisions.rows.flatMap((r) => {
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
    signalTextByRef.set(r.id, signalText);
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
    const occurredAtIso =
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : r.created_at
          ? String(r.created_at)
          : undefined;
    // Resolve the sender's pin/hide override (#270/#485) so buildDigest's
    // filterVisible drops hidden senders and surfaces pinned ones. No sender
    // (e.g. a voice note or file) or no override → undefined (no effect).
    const senderKey = bareAddress(sender);
    const meta: SignalVisibilityMeta | undefined = senderKey
      ? senderOverrides.get(senderKey)
      : undefined;
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
        occurredAt: occurredAtIso,
        requiresApproval: actionRequired,
        blockedReasons,
        sourceRefs: [sender ?? SOURCE_FRIENDLY[sourceType] ?? sourceType],
      }),
    );

    const decisionItem: DigestItem = {
      ref: r.id,
      text,
      body,
      actionRequired,
      domain: r.domain,
      sourceType,
      urgency,
      ...(meta ? { meta } : {}),
    };

    // #475 / spec 02: surface the user's OWN stated commitments from authored
    // content (sent mail, calendar descriptions, voice notes) as to-dos. The
    // extractor itself enforces the authored-only security boundary; we only
    // skip the call entirely when the rollback flag is set.
    if (!commitmentsOn) return [decisionItem];
    const fold = commitmentTodosFor(r.id, signalText, occurredAtIso, r.domain);
    for (const [ref, detail] of fold.details) detailByRef.set(ref, detail);
    return [decisionItem, ...fold.items];
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

  // Cross-signal entity linking (spec 05, #478): resolve people/orgs that recur
  // across this window's signals so buildDigest can collapse one matter that
  // would otherwise repeat across clusters into a single line with multiple
  // citations. Gated by ENTITY_LINKING (default on; `off` = rollback to the
  // un-collapsed spec-04 behavior).
  const entityLinks: ResolvedEntity[] = entityLinkingEnabled()
    ? linkEntitiesAcrossSignals(
        [...signalTextByRef.entries()].map(([ref, signal]) => ({ ref, signal })),
      )
    : [];
  const digest = buildDigest(items, { entityLinks }); // maxTodos defaults to 7

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
