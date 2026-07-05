/**
 * Demo showcase — makes the three seeded personas (Alex, Pat, Carol) look
 * genuinely alive across EVERY dashboard surface, not just the briefing.
 *
 * Called from seed.ts inside the same transaction (shares `client`), after the
 * base users + Alex's decisions/approvals/briefings are created. Everything
 * here is idempotent (fixed UUIDs + ON CONFLICT) and dated relative to now(),
 * so `pnpm db:seed` always refreshes it — approvals never expire, briefings
 * stay "today", trust progress stays current.
 *
 * The three personas tell three distinct stories when you switch between them:
 *   • Carol  — brand-new "observer": everything asks you, ~70% toward her first
 *              trust promotion. The "earning trust" story.
 *   • Alex   — trusted "low_autonomy": handles the routine, climbing toward
 *              "handle most things" (84%). The main sample profile.
 *   • Pat    — fully-trusted "high_autonomy" power user: handles everything,
 *              maxed out. The "it just runs my life" story.
 */

import type { PoolClient } from 'pg';

/** A minimal client surface — matches both pg.PoolClient and pg.Client. */
type Db = Pick<PoolClient, 'query'>;

export const DEMO_ALEX_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
export const DEMO_PAT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
export const DEMO_CAROL_ID = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7a';

// Alex's 10 inline demo decisions (from seed.ts) — reused here for his
// explanations and feedback history.
const ALEX_DECISION_IDS = [
  'de000001-0000-4000-8000-000000000001', 'de000002-0000-4000-8000-000000000002',
  'de000003-0000-4000-8000-000000000003', 'de000004-0000-4000-8000-000000000004',
  'de000005-0000-4000-8000-000000000005', 'de000006-0000-4000-8000-000000000006',
  'de000007-0000-4000-8000-000000000007', 'de000008-0000-4000-8000-000000000008',
  'de000009-0000-4000-8000-000000000009', 'de00000a-0000-4000-8000-00000000000a',
] as const;

/**
 * Deterministic UUID builder — every row is idempotent across re-seeds.
 * `prefix` MUST be exactly 2 hex chars (a table-namespace marker); `n` a small
 * ordinal. Together they never collide within the (prefix, ordinal-range)
 * assignments used below. Guards enforce the hex-and-length contract so a typo
 * fails loudly at seed time instead of producing an invalid UUID.
 */
function id(prefix: string, n: number): string {
  if (!/^[0-9a-f]{2}$/.test(prefix)) throw new Error(`demo-showcase id prefix must be 2 hex chars, got "${prefix}"`);
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// ── Shared decision shape (mirrors the Alex block in seed.ts) ────────────────

interface DemoDecision {
  id: string;
  situationType: string;
  domain: string;
  urgency: string;
  source: string;
  eventType: string;
  data: Record<string, unknown>;
  summary: string;
  minutesAgo: number;
  outcome: {
    autoExecuted: boolean;
    requiresApproval: boolean;
    escalationReason?: string;
    explanation: string;
    confidence: number;
    selectedAction?: {
      id: string;
      type: string;
      description: string;
      parameters: Record<string, unknown>;
      reversible: boolean;
      estimatedCost: number | null;
    };
  };
  approval?: {
    id: string;
    candidateAction: Record<string, unknown>;
    reason: string;
    urgency: string;
    confirmationLevel?: 'single' | 'dual';
    expiresInDays: number;
  };
  explanation?: {
    id: string;
    whatHappened: string;
    evidenceUsed: unknown[];
    preferencesInvoked: string[];
    confidenceReasoning: string;
    actionRationale: string;
    escalationRationale?: string;
    correctionGuidance: string;
  };
}

/**
 * Insert one demo decision + its candidate action, outcome, optional pending
 * approval, and optional explanation. Same raw_event shape the live digest and
 * approvals card both read: nested `data` (digest titles) + flat from/subject/
 * body (approvals card). Outcome id derives from the decision id (distinct
 * `<xx>0a…` first group) so it never collides with any other seeded row.
 */
async function insertDemoDecision(client: Db, userId: string, d: DemoDecision): Promise<void> {
  const flatFrom = (d.data['from'] ?? d.data['organizer'] ?? null) as unknown;
  const flatSubject = (d.data['subject'] ?? d.data['title'] ?? d.data['summary'] ?? d.data['fileName'] ?? null) as unknown;
  const flatBody = (d.data['body'] ?? d.data['snippet'] ?? d.data['description'] ?? d.data['excerpt'] ?? null) as unknown;

  await client.query(
    `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - ($10 || ' minutes')::interval)
     ON CONFLICT (id) DO UPDATE SET
       raw_event = EXCLUDED.raw_event, interpreted_situation = EXCLUDED.interpreted_situation,
       urgency = EXCLUDED.urgency, created_at = EXCLUDED.created_at`,
    [
      d.id, userId, d.situationType,
      JSON.stringify({ source: d.source, type: d.eventType, from: flatFrom, subject: flatSubject, body: flatBody, data: d.data }),
      JSON.stringify({ summary: d.summary, type: d.situationType }),
      d.domain, d.urgency, JSON.stringify({ source: d.source, demo: true }), d.source, String(d.minutesAgo),
    ],
  );

  const sel = d.outcome.selectedAction;
  if (sel) {
    await client.query(
      `INSERT INTO candidate_actions (id, decision_id, action_type, description, parameters, predicted_user_preference, risk_assessment, reversible, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, 'likely_approve', $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, parameters = EXCLUDED.parameters, risk_assessment = EXCLUDED.risk_assessment`,
      [
        sel.id, d.id, sel.type, sel.description, JSON.stringify(sel.parameters),
        // Real RiskAssessment shape (overallTier + reasoning) so the approve
        // preflight's parseRiskAssessmentFromRow accepts it — a thin
        // {level,factors} object reads as "no assessment" and 409s.
        JSON.stringify({
          actionId: sel.id,
          overallTier: d.outcome.requiresApproval ? 'moderate' : 'low',
          dimensions: {},
          reasoning: d.outcome.escalationReason ?? 'Routine, low-risk action matching your preferences.',
        }),
        sel.reversible, sel.estimatedCost,
      ],
    );
  }

  await client.query(
    `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, escalation_reason, explanation, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       auto_executed = EXCLUDED.auto_executed, requires_approval = EXCLUDED.requires_approval,
       escalation_reason = EXCLUDED.escalation_reason, explanation = EXCLUDED.explanation, confidence = EXCLUDED.confidence`,
    [
      `${d.id.slice(0, 2)}0a0000-0000-4000-8000-${d.id.slice(-12)}`, d.id, sel?.id ?? null,
      d.outcome.autoExecuted, d.outcome.requiresApproval, d.outcome.escalationReason ?? null,
      d.outcome.explanation, d.outcome.confidence,
    ],
  );

  if (d.approval) {
    await client.query(
      `INSERT INTO approval_requests (id, user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at, confirmation_level)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() - ($7 || ' minutes')::interval, now() + ($8 || ' days')::interval, $9)
       ON CONFLICT (id) DO UPDATE SET
         candidate_action = EXCLUDED.candidate_action, reason = EXCLUDED.reason, urgency = EXCLUDED.urgency,
         status = 'pending', responded_at = NULL, response = NULL, first_confirmed_at = NULL,
         requested_at = EXCLUDED.requested_at, expires_at = EXCLUDED.expires_at, confirmation_level = EXCLUDED.confirmation_level`,
      [
        d.approval.id, userId, d.id,
        // Link the embedded action to its candidate_actions row (the risk
        // assessment lives there) so "Yes, do it" doesn't 409 in the preflight.
        JSON.stringify({ id: sel?.id, ...d.approval.candidateAction }),
        d.approval.reason, d.approval.urgency, String(d.minutesAgo),
        String(d.approval.expiresInDays), d.approval.confirmationLevel ?? 'single',
      ],
    );
  }

  if (d.explanation) {
    const e = d.explanation;
    await insertExplanation(client, e, d.id, d.outcome.autoExecuted ? 'auto_execution' : 'escalation');
  }
}

async function insertExplanation(client: Db, e: NonNullable<DemoDecision['explanation']>, decisionId: string, type: string): Promise<void> {
  await client.query(
    `INSERT INTO explanation_records (id, decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, escalation_rationale, correction_guidance, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       what_happened = EXCLUDED.what_happened, evidence_used = EXCLUDED.evidence_used, preferences_invoked = EXCLUDED.preferences_invoked,
       confidence_reasoning = EXCLUDED.confidence_reasoning, action_rationale = EXCLUDED.action_rationale,
       escalation_rationale = EXCLUDED.escalation_rationale, correction_guidance = EXCLUDED.correction_guidance`,
    [e.id, decisionId, e.whatHappened, JSON.stringify(e.evidenceUsed), e.preferencesInvoked, e.confidenceReasoning, e.actionRationale, e.escalationRationale ?? null, e.correctionGuidance, type],
  );
}

/** Insert an oauth_tokens row (NULL tokens — represents a connection, nothing callable). */
async function connectAccount(client: Db, rowId: string, userId: string, email: string, scopes: string[]): Promise<void> {
  await client.query(
    `INSERT INTO oauth_tokens (id, user_id, provider, account_email, scopes, expires_at, encryption_key_version, created_at, updated_at)
     VALUES ($1, $2, 'google', $3, $4, now() + INTERVAL '30 days', 1, now(), now())
     ON CONFLICT (user_id, provider, account_email) DO UPDATE SET scopes = EXCLUDED.scopes, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [rowId, userId, email, scopes],
  );
}

/** Seed an embedded LLM provider row so the Chat page is wired (answers when a model is present). */
async function wireChatProvider(client: Db, rowId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO ai_provider_settings (id, user_id, provider, api_key, model, base_url, priority, enabled, created_at, updated_at)
     VALUES ($1, $2, 'embedded', '', 'auto', NULL, 0, true, now(), now())
     ON CONFLICT (user_id, provider) DO UPDATE SET model = EXCLUDED.model, enabled = EXCLUDED.enabled, updated_at = now()`,
    [rowId, userId],
  );
}

/** Upsert a memory page (brain_pages). content_tsv MUST be set or the row is invisible to search. */
async function memoryPage(
  client: Db, rowId: string, userId: string, title: string, content: string,
  source: string, sourceRef: string, metadata: Record<string, unknown>, ageHours: number,
): Promise<void> {
  await client.query(
    `INSERT INTO brain_pages (id, user_id, title, content, source, source_ref, metadata, content_tsv, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_tsvector('english', $3 || ' ' || $4), now() - ($8 || ' hours')::interval, now() - ($8 || ' hours')::interval)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, content = EXCLUDED.content, metadata = EXCLUDED.metadata,
       content_tsv = to_tsvector('english', EXCLUDED.title || ' ' || EXCLUDED.content),
       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
    [rowId, userId, title, content, source, sourceRef, JSON.stringify(metadata), String(ageHours)],
  );
}

/** Upsert a twin briefing (daily/weekly) with fresh timestamps + unread. */
async function briefing(client: Db, rowId: string, userId: string, cadence: 'daily' | 'weekly', prose: string, events: number, agoMinutes: number): Promise<void> {
  await client.query(
    `INSERT INTO twin_briefings (id, user_id, cadence, generated_at, prose_markdown, source_event_count, llm_provider, llm_cost_cents, read_at)
     VALUES ($1, $2, $3, now() - ($5 || ' minutes')::interval, $4, $6, 'embedded', 0, NULL)
     ON CONFLICT (id) DO UPDATE SET generated_at = EXCLUDED.generated_at, prose_markdown = EXCLUDED.prose_markdown, source_event_count = EXCLUDED.source_event_count, read_at = NULL`,
    [rowId, userId, cadence, prose, String(agoMinutes), events],
  );
}

/**
 * Seed a trust-progress feedback history: `approves` consecutive approvals as
 * the NEWEST rows (drives the trust bar's streak) + `rejects` OLDER rows (so the
 * approval ratio is high but not a suspicious 100%). Fixed ids → idempotent.
 * `decisionIds` must be real, existing decisions (feedback_events FKs to them).
 */
async function seedFeedbackHistory(client: Db, userId: string, prefix: string, decisionIds: readonly string[], approves: number, rejects: number): Promise<void> {
  // Reset this demo user's feedback to exactly the seeded set. Without this,
  // any real approve/reject clicks from a prior demo session (or a previous
  // seed's rows) linger as the NEWEST feedback and break the consecutive-
  // approval streak — the trust bar would read "0 of 50" instead of the
  // intended progress. Deterministic every re-seed.
  await client.query(`DELETE FROM feedback_events WHERE user_id = $1`, [userId]);
  let n = 0;
  for (let k = 0; k < approves; k++) {
    await client.query(
      `INSERT INTO feedback_events (id, user_id, decision_id, type, data, created_at)
       VALUES ($1, $2, $3, 'approve', '{"source":"user_click"}'::jsonb, now() - (($4)::int || ' days')::interval)
       ON CONFLICT (id) DO UPDATE SET type = 'approve', created_at = EXCLUDED.created_at`,
      [id(prefix, ++n), userId, decisionIds[k % decisionIds.length], String(k + 1)],
    );
  }
  for (let k = 0; k < rejects; k++) {
    await client.query(
      `INSERT INTO feedback_events (id, user_id, decision_id, type, data, created_at)
       VALUES ($1, $2, $3, 'reject', '{"whatWentWrong":"not quite right","severity":"minor"}'::jsonb, now() - (($4)::int || ' days')::interval)
       ON CONFLICT (id) DO UPDATE SET type = 'reject', created_at = EXCLUDED.created_at`,
      [id(prefix, ++n), userId, decisionIds[k % decisionIds.length], String(approves + 10 + k)],
    );
  }
}

/** Record a promotion in the trust-tier audit history ("earned over time"). */
async function tierAudit(client: Db, rowId: string, userId: string, oldTier: string, newTier: string, reason: string, evidence: Record<string, unknown>, daysAgo: number): Promise<void> {
  await client.query(
    `INSERT INTO trust_tier_audit (id, user_id, old_tier, new_tier, direction, trigger_reason, evidence, created_at)
     VALUES ($1, $2, $3, $4, 'promotion', $5, $6, now() - ($7 || ' days')::interval)
     ON CONFLICT (id) DO UPDATE SET trigger_reason = EXCLUDED.trigger_reason, evidence = EXCLUDED.evidence, created_at = EXCLUDED.created_at`,
    [rowId, userId, oldTier, newTier, reason, JSON.stringify(evidence), String(daysAgo)],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ALEX — the main sample profile. His decisions/approvals/briefings are already
// seeded inline in seed.ts; here we fill in every OTHER surface.
// ─────────────────────────────────────────────────────────────────────────────

/** Explanation records for Alex's 10 inline demo decisions (de000001…de00000a). */
async function seedAlexExplanations(client: Db): Promise<void> {
  const rows: Array<{ dec: string; auto: boolean; e: NonNullable<DemoDecision['explanation']> }> = [
    { dec: ALEX_DECISION_IDS[0], auto: false, e: { id: id('ee', 1), whatHappened: 'Drafted a reply to Dana at BrightPath confirming the pilot start date and pricing.', evidenceUsed: [{ type: 'email', ref: 'msg_dana_01', detail: 'inbound client request' }], preferencesInvoked: ['communication.response_style', 'email.draft_work_replies'], confidenceReasoning: 'High (0.82): known contact, a clear ask, and it matches your concise style.', actionRationale: 'The reply matches how you usually respond to Dana; held for your review because it goes to an external client.', escalationRationale: 'External recipient — email sends always go to you first.', correctionGuidance: 'Edit the draft before sending, or tell me you always want replies to Dana sent automatically.' } },
    { dec: ALEX_DECISION_IDS[1], auto: false, e: { id: id('ee', 2), whatHappened: 'Flagged the $79.99 Figma annual renewal for your approval.', evidenceUsed: [{ type: 'email', ref: 'msg_figma_01', detail: 'renewal notice' }], preferencesInvoked: ['finance.alert_large_charges', 'subscriptions.review_before_renew'], confidenceReasoning: 'Medium (0.68): you use Figma, but $79.99 is over your $50 auto-approve limit.', actionRationale: 'Renewals over your limit are yours to decide; I surfaced it with a few days of runway.', escalationRationale: '$79.99 is over your $50 auto-approve limit.', correctionGuidance: 'Approve it, or raise your auto-approve limit if you\'d rather I handle renewals like this.' } },
    { dec: ALEX_DECISION_IDS[2], auto: false, e: { id: id('ee', 3), whatHappened: 'Held invoice #2041 from Northwind Design ($1,250) for a two-step confirmation.', evidenceUsed: [{ type: 'email', ref: 'msg_northwind_01', detail: 'invoice, due Jul 7' }], preferencesInvoked: ['finance.alert_large_charges'], confidenceReasoning: 'Low (0.60): new payee and a large, irreversible amount.', actionRationale: 'A first-time payee plus a high amount is exactly the kind of thing to double-check.', escalationRationale: '$1,250 exceeds your limit and Northwind is a new payee — two confirmations required.', correctionGuidance: 'Confirm twice to pay, or tell me to add Northwind as a trusted payee.' } },
    { dec: ALEX_DECISION_IDS[3], auto: false, e: { id: id('ee', 4), whatHappened: 'Surfaced Priya\'s Q3 Planning Offsite invite for your RSVP.', evidenceUsed: [{ type: 'calendar', ref: 'evt_q3_offsite', detail: 'RSVP by Friday' }], preferencesInvoked: ['calendar.protect_morning_focus'], confidenceReasoning: 'High (0.90): a direct invite with a clear deadline.', actionRationale: 'New invites always come to you for a yes/no.', escalationRationale: 'Calendar invites need your RSVP.', correctionGuidance: 'Accept, decline, or propose another time — I\'ll send it.' } },
    { dec: ALEX_DECISION_IDS[4], auto: false, e: { id: id('ee', 5), whatHappened: 'Passed along a Google security alert about a new sign-in from Lisbon.', evidenceUsed: [{ type: 'email', ref: 'msg_google_sec', detail: 'new sign-in notice' }], preferencesInvoked: [], confidenceReasoning: 'Very high (0.99): security alerts are always surfaced, never handled for you.', actionRationale: 'I never act on security alerts myself — they always come straight to you.', escalationRationale: 'Security alerts are escalate-only.', correctionGuidance: 'Open your account security settings directly and confirm the sign-in — don\'t use links in the email.' } },
    { dec: ALEX_DECISION_IDS[5], auto: true, e: { id: id('ee', 6), whatHappened: 'Accepted your recurring daily Eng Standup.', evidenceUsed: [{ type: 'calendar', ref: 'evt_standup', detail: 'recurring, no conflicts' }], preferencesInvoked: ['calendar.auto_accept_recurring'], confidenceReasoning: 'High (0.95): a recurring meeting you always accept, no conflicts.', actionRationale: 'It matches your "auto-accept recurring meetings" preference.', correctionGuidance: 'Tell me if you\'d rather review standup invites yourself.' } },
    { dec: ALEX_DECISION_IDS[6], auto: true, e: { id: id('ee', 7), whatHappened: 'Archived a Daily Stoic newsletter.', evidenceUsed: [{ type: 'email', ref: 'msg_stoic', detail: 'newsletter' }], preferencesInvoked: ['email.snooze_newsletters', 'email.auto_archive_promo'], confidenceReasoning: 'High (0.90): matches your newsletter-snoozing pattern.', actionRationale: 'You archive newsletters without reading, so I kept your inbox clear.', correctionGuidance: 'Tell me to keep Daily Stoic in your inbox if you\'d rather read it.' } },
    { dec: ALEX_DECISION_IDS[7], auto: true, e: { id: id('ee', 8), whatHappened: 'Categorized a $5.75 Blue Bottle coffee charge as Food & Drink.', evidenceUsed: [{ type: 'transaction', ref: 'txn_bluebottle', detail: 'card ending 4242' }], preferencesInvoked: ['finance.alert_large_charges'], confidenceReasoning: 'Very high (0.96): small, familiar vendor, well under your limit.', actionRationale: 'Small everyday charges get categorized automatically.', correctionGuidance: 'Recategorize it if I got the category wrong.' } },
    { dec: ALEX_DECISION_IDS[8], auto: true, e: { id: id('ee', 9), whatHappened: 'Filed Invoice-Northwind-2041.pdf into Finance/Invoices/2026.', evidenceUsed: [{ type: 'file', ref: 'Invoice-Northwind-2041.pdf', detail: 'recognized invoice' }], preferencesInvoked: [], confidenceReasoning: 'High (0.94): clearly an invoice, matching your filing scheme.', actionRationale: 'Recognized documents get filed where similar ones live.', correctionGuidance: 'Move it if it belongs somewhere else.' } },
    { dec: ALEX_DECISION_IDS[9], auto: true, e: { id: id('ee', 10), whatHappened: 'Logged your 3.2 mile morning run.', evidenceUsed: [{ type: 'app', ref: 'run_0704', detail: '28:14, avg 8:49/mi' }], preferencesInvoked: ['health.morning_exerciser'], confidenceReasoning: 'Very high (0.99): a routine health metric from your device.', actionRationale: 'Routine activity gets logged automatically so you have the history.', correctionGuidance: 'Nothing needed — just keeping your log complete.' } },
  ];
  for (const r of rows) await insertExplanation(client, r.e, r.dec, r.auto ? 'auto_execution' : 'escalation');
}

/** Alex's memory (brain_pages) — powers Search + the briefing's "memory link" suggestions. */
async function seedAlexMemory(client: Db): Promise<void> {
  const g = (tier: string, from: string, extra: Record<string, unknown> = {}) => ({ signalSource: 'gmail', authoringTier: tier, fromAddress: from, ...extra });
  const P = (n: number, title: string, content: string, source: string, ref: string, meta: Record<string, unknown>, ageHours: number) =>
    memoryPage(client, id('ba', n), DEMO_ALEX_ID, title, content, source, ref, meta, ageHours);
  await Promise.all([
    // A recent + older pair sharing fromAddress + topic tokens → a "Memory link".
    P(10, 'Kickoff with Dana Rivera at BrightPath', 'Dana asked about the pilot scope and which pricing tiers apply for a 12-person team. Left it that I would send tiers once legal cleared.', 'signal', 'sig_dana_kickoff', g('inbox_personal', 'dana@brightpath.io'), 24 * 24),
    P(11, 'Dana is ready to move on the BrightPath pilot', 'Dana Rivera needs the pricing tiers and a start date to get sign-off this week on the pilot.', 'signal', 'sig_dana_followup', g('inbox_personal', 'dana@brightpath.io'), 5),
    P(12, 'Q3 Planning Offsite with Priya', 'Full-day offsite to lock in Q3 goals. Priya asked for an RSVP by Friday so she can finalize the room.', 'signal', 'sig_priya_offsite', { signalSource: 'google_calendar', authoringTier: 'inbox_personal', fromAddress: 'priya@example.com' }, 8),
    P(13, 'Northwind Design invoice #2041', 'Invoice #2041 for $1,250 from Northwind Design, due July 7. First time paying this vendor.', 'signal', 'sig_northwind_inv', g('inbox_personal', 'ap@northwind.design'), 5),
    P(14, 'Figma annual renewal reminder', 'Figma Organization annual plan renews July 8 for $79.99.', 'signal', 'sig_figma_renew', g('inbox_automated', 'billing@figma.com'), 3),
    P(15, 'Your note: pilot pricing tiers', 'Starter $2k/mo, Team $5k/mo, Scale $9k/mo — month-to-month during any pilot. Reuse for BrightPath.', 'note', 'note_pricing_tiers', { signalSource: 'voice', authoringTier: 'authored_originated' }, 30),
    P(16, 'Eng Standup notes', 'Daily standup at 9am. Shipping the retrieval fix this week; blockers on the CRDB migration cleared.', 'episode', 'ep_standup_notes', { signalSource: 'gmail', authoringTier: 'inbox_broadcast' }, 20),
    P(17, 'Flight to Lisbon booked', 'Confirmed aisle seat, TAP Air, departs next Tuesday. Add to calendar and set a reminder to check in.', 'signal', 'sig_flight_lisbon', g('inbox_automated', 'no-reply@flights.example'), 48),
    P(18, 'Blue Bottle coffee — recurring', 'Blue Bottle charges show up weekly, always categorized Food & Drink.', 'episode', 'ep_bluebottle', { signalSource: 'gmail', authoringTier: 'inbox_automated' }, 40),
    P(19, 'Manager: Q2 report due Friday', 'Priya asked for the Q2 report update by Friday. Turned into a tracked task.', 'signal', 'sig_q2_report', g('inbox_personal', 'priya@example.com'), 60),
    P(20, 'Newsletter: The Daily Stoic', 'Daily meditation on the obstacle being the way. Archived — you snooze newsletters.', 'signal', 'sig_stoic_news', g('inbox_broadcast', 'newsletter@dailystoic.com'), 12),
    P(21, 'Security: new sign-in from Lisbon', 'Google flagged a new sign-in from Lisbon, Portugal. Surfaced to you, not acted on.', 'signal', 'sig_sec_lisbon', g('inbox_automated', 'no-reply@accounts.google.com'), 1.5),
  ]);
}

/** Alex's habits, personality traits, capabilities, trust history, feedback, and chat wiring. */
async function seedAlexProfileSurfaces(client: Db): Promise<void> {
  await wireChatProvider(client, id('af', 1), DEMO_ALEX_ID);

  // Habits ("Habits I've noticed")
  await client.query(
    `INSERT INTO behavioral_patterns (id, user_id, pattern_type, description, trigger_config, observed_action, frequency, confidence, last_observed_at)
     VALUES
       ($1, $5, 'temporal', 'You check email first thing, around 7–8am on weekdays', '{"window":"07:00-08:30","days":["mon","tue","wed","thu","fri"]}'::jsonb, 'triage_inbox', 34, 'high', now() - INTERVAL '1 day'),
       ($2, $5, 'response', 'You archive newsletters without opening them', '{"category":"newsletter"}'::jsonb, 'archive', 21, 'high', now() - INTERVAL '2 days'),
       ($3, $5, 'response', 'You decline Friday-afternoon meeting invites', '{"day":"friday","period":"afternoon"}'::jsonb, 'decline_suggest_alternative', 8, 'moderate', now() - INTERVAL '4 days'),
       ($4, $5, 'temporal', 'You review expenses on Friday afternoons', '{"day":"friday","period":"afternoon"}'::jsonb, 'review_spend', 6, 'moderate', now() - INTERVAL '5 days')
     ON CONFLICT (id) DO UPDATE SET frequency = EXCLUDED.frequency, last_observed_at = EXCLUDED.last_observed_at`,
    [id('ce', 1), id('ce', 2), id('ce', 3), id('ce', 4), DEMO_ALEX_ID],
  );

  // Personality traits ("What I've noticed about you")
  await client.query(
    `INSERT INTO cross_domain_traits (id, user_id, trait_name, confidence, supporting_domains, evidence_count, description)
     VALUES
       ($1, $5, 'cautious_spender', 'high', ARRAY['finance','shopping','subscriptions'], 27, 'You keep a close eye on spending — anything over about $50 gets a look before it goes through.'),
       ($2, $5, 'quick_responder', 'high', ARRAY['email','calendar'], 19, 'You reply fast — most messages get a response within a couple of hours.'),
       ($3, $5, 'routine_driven', 'moderate', ARRAY['calendar','health'], 15, 'You run on routines — mornings and Fridays follow a consistent rhythm.'),
       ($4, $5, 'privacy_conscious', 'moderate', ARRAY['email','finance'], 11, 'You prefer to keep sensitive things on-device and review anything that leaves your accounts.')
     ON CONFLICT (user_id, trait_name) DO UPDATE SET confidence = EXCLUDED.confidence, evidence_count = EXCLUDED.evidence_count, description = EXCLUDED.description, updated_at = now()`,
    [id('cd', 1), id('cd', 2), id('cd', 3), id('cd', 4), DEMO_ALEX_ID],
  );

  // Capabilities: two active MCP servers + skills + metrics + changelog + a pending suggestion.
  const github = id('c1', 1);
  const gmail = id('c1', 2);
  await client.query(
    `INSERT INTO mcp_servers (id, user_id, registry_id, display_name, transport, command, args, env, oauth_provider, trust_tier, per_app_spend_per_action_cents, per_app_daily_spend_cents, per_app_monthly_spend_cents, zero_trust_mode, status, health_status, last_active_at, installed_at)
     VALUES
       ($1, $3, '@modelcontextprotocol/server-github', 'GitHub', 'stdio', 'npx', '["-y","@modelcontextprotocol/server-github"]'::jsonb, '{}'::jsonb, 'github', 'low_autonomy', 50, 500, 5000, false, 'active', 'healthy', now() - INTERVAL '20 minutes', now() - INTERVAL '9 days'),
       ($2, $3, 'gmail-mcp', 'Gmail', 'stdio', 'npx', '["-y","gmail-mcp"]'::jsonb, '{}'::jsonb, 'google', 'moderate_autonomy', 25, 300, 3000, false, 'active', 'healthy', now() - INTERVAL '2 hours', now() - INTERVAL '14 days')
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, last_active_at = EXCLUDED.last_active_at, updated_at = now()`,
    [github, gmail, DEMO_ALEX_ID],
  );
  await client.query(
    `INSERT INTO mcp_server_skills (id, server_id, skill_name, skill_description, is_destructive, is_irreversible, estimated_cost_cents)
     VALUES
       ($1, $5, 'create_issue', 'Create a new GitHub issue', false, false, 0),
       ($2, $5, 'merge_pull_request', 'Merge a pull request', true, true, 0),
       ($3, $6, 'read_email', 'Read messages from the inbox', false, false, 0),
       ($4, $6, 'send_email', 'Send an email', true, true, 0)
     ON CONFLICT (server_id, skill_name) DO NOTHING`,
    [id('c2', 1), id('c2', 2), id('c2', 3), id('c2', 4), github, gmail],
  );
  await client.query(
    `INSERT INTO mcp_server_metrics (server_id, bucket_started_at, bucket_duration, invocations_total, invocations_failed, latency_p50_ms, latency_p95_ms, latency_p99_ms, bytes_in, bytes_out, spend_cents)
     VALUES
       ($1, now() - INTERVAL '30 minutes', '1m', 12, 0, 180, 420, 610, 2048, 8192, 3),
       ($1, now() - INTERVAL '20 minutes', '1m', 9, 1, 210, 480, 700, 1500, 6000, 2),
       ($1, now() - INTERVAL '10 minutes', '1m', 15, 0, 160, 390, 540, 3000, 9000, 4),
       ($2, now() - INTERVAL '15 minutes', '1m', 6, 0, 240, 520, 780, 1200, 4000, 1)
     ON CONFLICT (server_id, bucket_started_at, bucket_duration) DO NOTHING`,
    [github, gmail],
  );
  await client.query(
    `INSERT INTO mcp_server_changelogs (server_id, current_version, raw_text, last_seen_skills, last_known_destructive_skills)
     VALUES ($1, 'v1.4.2', 'v1.4.2 — Added merge_pull_request. v1.4.0 — Initial GitHub tools.', '["create_issue","merge_pull_request"]'::jsonb, '["merge_pull_request"]'::jsonb)
     ON CONFLICT (server_id) DO UPDATE SET current_version = EXCLUDED.current_version, raw_text = EXCLUDED.raw_text, fetched_at = now()`,
    [github],
  );
  await client.query(
    `INSERT INTO app_suggestions (id, user_id, registry_id, display_name, evidence_count, evidence_sources, evidence_kinds_distinct, first_evidence_at, last_evidence_at, confidence_score, status, reason_summary)
     VALUES ($1, $2, 'linear-mcp', 'Linear', 5, '[]'::jsonb, 2, now() - INTERVAL '10 days', now() - INTERVAL '1 day', 0.88, 'pending', 'You mention Linear issues in 5 recent emails and 2 calendar events.')
     ON CONFLICT (id) DO UPDATE SET status = 'pending', confidence_score = EXCLUDED.confidence_score, reason_summary = EXCLUDED.reason_summary, updated_at = now()`,
    [id('c3', 1), DEMO_ALEX_ID],
  );
  // Provenance graph: suggestion → install → action.
  const nSug = id('c4', 1), nIns = id('c4', 2), nAct = id('c4', 3);
  await client.query(
    `INSERT INTO capability_provenance_nodes (id, user_id, node_type, ref_table, ref_id, server_id, occurred_at, payload)
     VALUES
       ($1, $6, 'suggestion', 'app_suggestions', $4, $5, now() - INTERVAL '9 days', '{"displayName":"GitHub","registryId":"@modelcontextprotocol/server-github"}'::jsonb),
       ($2, $6, 'install', 'mcp_servers', $5, $5, now() - INTERVAL '9 days', '{"displayName":"GitHub"}'::jsonb),
       ($3, $6, 'action', 'mcp_servers', $5, $5, now() - INTERVAL '1 hour', '{"toolName":"create_issue","approved":true}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [nSug, nIns, nAct, id('c3', 1), github, DEMO_ALEX_ID],
  );
  await client.query(
    `INSERT INTO capability_provenance_edges (from_node_id, to_node_id, edge_type)
     VALUES ($1, $2, 'triggered'), ($2, $3, 'executed_via')
     ON CONFLICT (from_node_id, to_node_id, edge_type) DO NOTHING`,
    [nSug, nIns, nAct],
  );

  // Trust: 42 approvals in a row (→ 84% toward moderate) + 4 older rejects (→ 91% accuracy).
  await seedFeedbackHistory(client, DEMO_ALEX_ID, 'fa', ALEX_DECISION_IDS, 42, 4);
  await tierAudit(client, id('da', 1), DEMO_ALEX_ID, 'observer', 'suggest', '10 approvals in a row and a perfect approval rate', { totalApprovals: 10, totalRejections: 0, consecutiveApprovals: 10, approvalRatio: 1.0, recentRejections: 0, windowDays: 7, hasCriticalUndo: false }, 40);
  await tierAudit(client, id('da', 2), DEMO_ALEX_ID, 'suggest', 'low_autonomy', '20 approvals in a row and a 95% approval rate', { totalApprovals: 20, totalRejections: 1, consecutiveApprovals: 20, approvalRatio: 0.952, recentRejections: 0, windowDays: 7, hasCriticalUndo: false }, 12);
  // A pending per-server promotion offer (GitHub: low → moderate).
  await client.query(
    `INSERT INTO promotion_offers (id, user_id, server_id, current_tier, proposed_tier, reason, decisions_observed_count, approved_count, offered_at, responded_at, response)
     VALUES ($1, $2, $3, 'low_autonomy', 'moderate_autonomy', 'You approved 42 of the last 46 GitHub actions — I could handle these without asking.', 46, 42, now() - INTERVAL '1 hour', NULL, NULL)
     ON CONFLICT (id) DO UPDATE SET reason = EXCLUDED.reason, offered_at = EXCLUDED.offered_at, responded_at = NULL, response = NULL`,
    [id('db', 1), DEMO_ALEX_ID, github],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAT — power user, high autonomy. Handles everything; rarely asks.
// ─────────────────────────────────────────────────────────────────────────────

async function seedPat(client: Db): Promise<void> {
  await client.query(`UPDATE users SET trust_tier = 'high_autonomy' WHERE id = $1`, [DEMO_PAT_ID]);
  await client.query(
    `INSERT INTO twin_profiles (id, user_id, version, preferences, inferences, risk_tolerance, spend_norms, communication_style, routines, domain_heuristics)
     VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, '{}'::jsonb, $5, '[]'::jsonb, '{}'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, preferences = EXCLUDED.preferences, inferences = EXCLUDED.inferences, communication_style = EXCLUDED.communication_style, updated_at = now()`,
    [
      id('bd', 1), DEMO_PAT_ID,
      JSON.stringify([
        { domain: 'email', key: 'auto_send_team_replies', value: 'Send my replies to teammates automatically', confidence: 'confirmed', source: 'explicit', evidenceIds: [] },
        { domain: 'travel', key: 'auto_book_under_budget', value: 'Book travel automatically when it is under budget', confidence: 'high', source: 'explicit', evidenceIds: [] },
        { domain: 'finance', key: 'auto_pay_known_vendors', value: 'Pay recurring known vendors without asking', confidence: 'confirmed', source: 'explicit', evidenceIds: [] },
        { domain: 'shopping', key: 'reorder_staples', value: 'Reorder household staples when they run low', confidence: 'high', source: 'explicit', evidenceIds: [] },
        { domain: 'calendar', key: 'defend_focus_blocks', value: 'Defend my focus blocks aggressively', confidence: 'high', source: 'corrected', evidenceIds: [] },
      ]),
      JSON.stringify([
        { type: 'behavioral', domain: 'email', key: 'inbox_zero', value: 'Keeps inbox at zero', confidence: 'high', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'email_history', reasoning: 'Your inbox is cleared to zero most evenings.' },
        { type: 'behavioral', domain: 'travel', key: 'frequent_traveler', value: 'Travels most weeks', confidence: 'high', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'calendar_patterns', reasoning: 'You have travel on the calendar 3 of every 4 weeks.' },
      ]),
      JSON.stringify({ tone: 'direct', formality: 'casual', verbosity: 'terse', signoff: 'Pat' }),
    ],
  );
  await connectAccount(client, id('ac', 2), DEMO_PAT_ID, 'pat@example.com', ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar']);
  await wireChatProvider(client, id('af', 2), DEMO_PAT_ID);

  const decisions: DemoDecision[] = [
    patHandled(101, 'email_triage', 'communication', 'gmail', 'email_received', { subject: 'Re: sprint plan', from: 'teammate@corp.com', snippet: 'Sounds good — can you confirm the dates?', authoringTier: 'inbox_personal' }, 'Replied to a teammate about the sprint plan', 55, 'send_email', 'Sent your reply to the sprint-plan thread.', 0.93),
    patHandled(102, 'finance_operation', 'finance', 'gmail', 'email_received', { subject: 'AWS invoice — $842.10', from: 'billing@aws.amazon.com', snippet: 'Your monthly usage invoice is ready.', authoringTier: 'inbox_automated' }, 'Paid the recurring AWS invoice', 130, 'pay_invoice', 'Paid the $842.10 AWS invoice — a known recurring vendor within budget.', 0.9),
    patHandled(103, 'travel_decision', 'travel', 'gmail', 'email_received', { subject: 'Fare drop: SFO→JFK $214', from: 'deals@flights.example', snippet: 'Nonstop fares dropped for your saved route.', authoringTier: 'inbox_automated' }, 'Booked a flight that dropped under budget', 240, 'book_travel', 'Booked SFO→JFK at $214 — under your $400 travel budget, aisle seat.', 0.88),
    patHandled(104, 'meeting_request', 'scheduling', 'google_calendar', 'event_invite', { title: '1:1 with Sam', summary: '1:1 with Sam', organizer: 'sam@corp.com', description: 'Weekly 1:1', authoringTier: 'inbox_personal' }, 'Accepted your weekly 1:1 with Sam', 300, 'accept_invite', 'Accepted the recurring 1:1 with Sam — no conflicts.', 0.95),
    patHandled(105, 'subscription_renewal', 'subscriptions', 'gmail', 'email_received', { subject: 'GitHub Team renews', from: 'billing@github.com', snippet: 'Your GitHub Team plan renews for $44.', authoringTier: 'inbox_automated' }, 'Renewed GitHub Team ($44)', 420, 'approve_renewal', 'Renewed GitHub Team ($44) — a known, in-budget recurring subscription.', 0.92),
    patHandled(106, 'document_management', 'documents', 'filesystem', 'file_indexed', { fileName: 'Q3-forecast.xlsx', excerpt: 'Filed to Finance/Forecasts', authoringTier: 'authored_originated' }, 'Filed Q3-forecast.xlsx', 500, 'organize_file', 'Filed Q3-forecast.xlsx into Finance/Forecasts.', 0.94),
    // The ONE thing Pat still gets asked about — a brand-new, large vendor.
    patNinefoldApproval(107, 90),
  ];
  for (const d of decisions) await insertDemoDecision(client, DEMO_PAT_ID, d);

  await seedFeedbackHistory(client, DEMO_PAT_ID, 'fb', decisions.map((d) => d.id), 60, 3);
  await tierAudit(client, id('da', 10), DEMO_PAT_ID, 'moderate_autonomy', 'high_autonomy', 'Months of consistent approvals across every domain', { totalApprovals: 210, totalRejections: 6, consecutiveApprovals: 60, approvalRatio: 0.972, recentRejections: 0, windowDays: 30, hasCriticalUndo: false }, 20);
  await briefing(client, id('bf', 10), DEMO_PAT_ID, 'daily', [
    '## Your daily briefing', '', 'Quiet one — I handled everything. One thing needs a yes.', '',
    '### Needs you', '- **Approve a $4,800 deposit to Studio Ninefold** — new vendor, so I left it for you.', '',
    '### Handled for you', '- Replied to the sprint-plan thread', '- Paid the $842.10 AWS invoice', '- Booked SFO→JFK at $214 (under budget)', '- Accepted your 1:1 with Sam', '- Renewed GitHub Team ($44)', '- Filed Q3-forecast.xlsx',
  ].join('\n'), 7, 20);
  await memoryPage(client, id('ba', 60), DEMO_PAT_ID, 'AWS monthly invoice', 'AWS usage invoices arrive monthly, around $800, paid automatically as a known vendor.', 'episode', 'ep_pat_aws', { signalSource: 'gmail', authoringTier: 'inbox_automated' }, 130);
  await memoryPage(client, id('ba', 61), DEMO_PAT_ID, 'Studio Ninefold brand refresh', 'New agency Studio Ninefold quoted a brand refresh; $4,800 deposit to start.', 'signal', 'sig_pat_ninefold', { signalSource: 'gmail', authoringTier: 'inbox_personal', fromAddress: 'hello@ninefold.studio' }, 1.5);
}

function patHandled(ord: number, sit: string, domain: string, source: string, evt: string, data: Record<string, unknown>, summary: string, minutesAgo: number, actionType: string, explanation: string, confidence: number): DemoDecision {
  return {
    id: id('ea', ord), situationType: sit, domain, urgency: 'low', source, eventType: evt, data, summary, minutesAgo,
    outcome: { autoExecuted: true, requiresApproval: false, explanation, confidence, selectedAction: { id: id('eb', ord), type: actionType, description: summary, parameters: {}, reversible: true, estimatedCost: null } },
    explanation: { id: id('ec', ord), whatHappened: explanation, evidenceUsed: [{ type: 'signal', ref: String(data['from'] ?? data['organizer'] ?? source), detail: String(data['subject'] ?? data['title'] ?? '') }], preferencesInvoked: [], confidenceReasoning: `High (${confidence}): matches an established, trusted pattern.`, actionRationale: 'Handled automatically — you have this on autopilot.', correctionGuidance: 'Tell me to start asking again if you\'d rather review these.' },
  };
}

function patNinefoldApproval(ord: number, minutesAgo: number): DemoDecision {
  const action = { actionType: 'pay_invoice', description: 'Pay the $4,800 deposit to Studio Ninefold', parameters: { payee: 'Studio Ninefold', amount: 480000, summary: 'Pay Studio Ninefold deposit ($4,800)' }, estimatedCost: 480000 };
  return {
    id: id('ea', ord), situationType: 'finance_operation', domain: 'finance', urgency: 'medium', source: 'gmail', eventType: 'email_received',
    data: { subject: 'New vendor: Studio Ninefold — $4,800 deposit', from: 'hello@ninefold.studio', snippet: 'Deposit invoice for the brand refresh project.', authoringTier: 'inbox_personal' },
    summary: 'Studio Ninefold wants a $4,800 deposit — new vendor', minutesAgo,
    outcome: {
      autoExecuted: false, requiresApproval: true, escalationReason: 'New vendor and a large amount', explanation: 'Held the $4,800 Studio Ninefold deposit for you — new vendor, well above the auto-pay bar.', confidence: 0.6,
      selectedAction: { id: id('eb', ord), type: 'pay_invoice', description: action.description, parameters: action.parameters, reversible: false, estimatedCost: 480000 },
    },
    approval: { id: id('ed', ord), candidateAction: { ...action, reasoning: 'First-time vendor and a large amount — your call.' }, reason: 'This is a $4,800 deposit to a vendor you haven\'t paid before.', urgency: 'medium', confirmationLevel: 'dual', expiresInDays: 3 },
    explanation: { id: id('ec', ord), whatHappened: 'Held the $4,800 Studio Ninefold deposit for your approval.', evidenceUsed: [{ type: 'email', ref: 'hello@ninefold.studio', detail: 'deposit invoice' }], preferencesInvoked: ['finance.auto_pay_known_vendors'], confidenceReasoning: 'Low (0.60): new vendor, large irreversible amount.', actionRationale: 'You auto-pay known vendors, but this one is brand new.', escalationRationale: 'New payee + large amount — two confirmations.', correctionGuidance: 'Confirm to pay, or add Studio Ninefold as a trusted vendor.' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CAROL — brand-new observer. Everything asks first; earning her first promotion.
// ─────────────────────────────────────────────────────────────────────────────

async function seedCarol(client: Db): Promise<void> {
  await client.query(
    `INSERT INTO twin_profiles (id, user_id, version, preferences, inferences, risk_tolerance, spend_norms, communication_style, routines, domain_heuristics)
     VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, '{}'::jsonb, $5, '[]'::jsonb, '{}'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, preferences = EXCLUDED.preferences, inferences = EXCLUDED.inferences, communication_style = EXCLUDED.communication_style, updated_at = now()`,
    [
      id('bd', 2), DEMO_CAROL_ID,
      JSON.stringify([
        { domain: 'email', key: 'response_style', value: 'Warm and a little more formal', confidence: 'moderate', source: 'explicit', evidenceIds: [] },
        { domain: 'email', key: 'never_auto_send', value: 'Always show me before sending anything', confidence: 'confirmed', source: 'explicit', evidenceIds: [] },
      ]),
      JSON.stringify([
        { type: 'behavioral', domain: 'email', key: 'reads_everything', value: 'Reads every message', confidence: 'low', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'email_history', reasoning: 'Still early — you open nearly everything, so I am not archiving yet.' },
      ]),
      JSON.stringify({ tone: 'warm', formality: 'formal', verbosity: 'balanced', signoff: 'Warmly, Carol' }),
    ],
  );
  await connectAccount(client, id('ac', 3), DEMO_CAROL_ID, 'carol@example.com', ['https://www.googleapis.com/auth/gmail.readonly']);
  await wireChatProvider(client, id('af', 3), DEMO_CAROL_ID);

  const decisions: DemoDecision[] = [
    carolApproval(201, { subject: 'Re: book club pick', from: 'maya@friends.com', snippet: 'Are we still on for Thursday? What are we reading?', authoringTier: 'inbox_personal' }, 'Maya asked about book club Thursday', 35, 'send_email', 'Draft a friendly reply to Maya about book club', 'Review the draft — you asked me to always check before sending.'),
    carolApproval(202, { subject: 'Volunteer schedule', from: 'coordinator@shelter.org', snippet: 'Can you take the Saturday morning shift?', authoringTier: 'inbox_personal' }, 'Shelter asked Carol to take Saturday', 120, 'send_email', 'Draft a reply confirming the Saturday shift', 'Review before I send — I never send on my own yet.'),
    carolApproval(203, { subject: 'Your prescription is ready', from: 'pharmacy@health.example', snippet: 'Ready for pickup at your local pharmacy.', authoringTier: 'inbox_automated' }, 'Pharmacy pickup reminder', 240, 'label_email', 'File this under Health reminders', 'Say yes and I\'ll file it; I won\'t touch it otherwise.'),
    carolHandled(204, { subject: 'Receipt — grocery order', from: 'receipts@grocer.example', snippet: 'Thanks for your order.', authoringTier: 'inbox_automated' }, 'Filed a grocery receipt', 600, 'You OK\'d filing a grocery receipt under Receipts.'),
  ];
  for (const d of decisions) await insertDemoDecision(client, DEMO_CAROL_ID, d);

  // 7 approvals → observer promotes at 10, so ~70% of the way there.
  await seedFeedbackHistory(client, DEMO_CAROL_ID, 'fc', decisions.map((d) => d.id), 7, 0);
  await briefing(client, id('bf', 11), DEMO_CAROL_ID, 'daily', [
    '## Your daily briefing', '', 'We\'re still getting to know each other, so I check with you on everything. Three things need a quick yes.', '',
    '### Needs you', '- **Reply to Maya** about book club Thursday — I drafted something warm.', '- **Reply to the shelter** about the Saturday shift.', '- **File a pharmacy pickup reminder** under Health?', '',
    '### Handled for you', '- Filed a grocery receipt (you OK\'d it)', '', 'The more you say yes, the more I can start handling on my own.',
  ].join('\n'), 4, 25);
  await memoryPage(client, id('ba', 70), DEMO_CAROL_ID, 'Book club with Maya', 'Maya runs a Thursday book club; Carol usually joins. Next pick to be decided.', 'signal', 'sig_carol_bookclub', { signalSource: 'gmail', authoringTier: 'inbox_personal', fromAddress: 'maya@friends.com' }, 5);
}

function carolApproval(ord: number, data: Record<string, unknown>, summary: string, minutesAgo: number, actionType: string, actionDesc: string, reason: string): DemoDecision {
  return {
    id: id('ea', ord), situationType: actionType === 'send_email' ? 'email_reply' : 'email_triage', domain: 'communication', urgency: 'medium', source: 'gmail', eventType: 'email_received', data, summary, minutesAgo,
    outcome: {
      autoExecuted: false, requiresApproval: true, escalationReason: 'You asked me to check before acting', explanation: `Held for you: ${actionDesc.toLowerCase()}.`, confidence: 0.7,
      selectedAction: { id: id('eb', ord), type: actionType, description: actionDesc, parameters: { summary }, reversible: true, estimatedCost: actionType === 'send_email' ? 0 : null },
    },
    approval: { id: id('ed', ord), candidateAction: { actionType, description: actionDesc, parameters: { summary }, estimatedCost: 0, reasoning: reason }, reason, urgency: 'medium', expiresInDays: 4 },
    explanation: { id: id('ec', ord), whatHappened: `Prepared to ${actionDesc.toLowerCase()}, then paused for you.`, evidenceUsed: [{ type: 'email', ref: String(data['from']), detail: String(data['subject']) }], preferencesInvoked: ['email.never_auto_send'], confidenceReasoning: 'Moderate (0.70): clear ask, but you are new so I check everything.', actionRationale: 'You are in observer mode — I propose, you decide.', escalationRationale: 'Observer tier: everything is proposed, nothing runs on its own.', correctionGuidance: 'Approve a few of these and I\'ll start earning the ability to handle them for you.' },
  };
}

function carolHandled(ord: number, data: Record<string, unknown>, summary: string, minutesAgo: number, explanation: string): DemoDecision {
  return {
    id: id('ea', ord), situationType: 'email_triage', domain: 'communication', urgency: 'low', source: 'gmail', eventType: 'email_received', data, summary, minutesAgo,
    outcome: { autoExecuted: false, requiresApproval: false, explanation, confidence: 0.8, selectedAction: { id: id('eb', ord), type: 'label_email', description: summary, parameters: {}, reversible: true, estimatedCost: null } },
    explanation: { id: id('ec', ord), whatHappened: explanation, evidenceUsed: [{ type: 'email', ref: String(data['from']), detail: String(data['subject']) }], preferencesInvoked: [], confidenceReasoning: 'You approved this kind of filing before.', actionRationale: 'Low-risk filing you already OK\'d.', correctionGuidance: 'Move it if it belongs elsewhere.' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/** Entry point — call from seed.ts inside the transaction. */
export async function seedDemoShowcase(client: Db): Promise<void> {
  await seedAlexExplanations(client);
  await seedAlexMemory(client);
  await seedAlexProfileSurfaces(client);
  await seedPat(client);
  await seedCarol(client);
  // eslint-disable-next-line no-console
  console.log('[seed] Demo showcase: enriched Alex (learnings, memory, capabilities, trust) + Pat + Carol personas.');
}
