/**
 * Tier-ablation fixture for the Layer 2 retrieval eval (#251).
 *
 * Purpose-built corpus where MOST labeled queries have paired authored +
 * received variants matching the same query text — q5 and q6 (received-only
 * notifications, no realistic authored sibling) are kept single-variant on
 * purpose. The tier multiplier is the actual deciding factor for ranking
 * on the paired queries — text + vector overlap is tuned so the variants
 * land at adjacent ranks without weighting, and the multiplier is what
 * flips the order.
 *
 * Three query classes:
 *
 *   - `user_behavior`: queries that should benefit from tier weighting.
 *     The user-authored variant is the higher-value hit (it's *their* voice,
 *     *their* commitment). MRR of the authored variant is the headline
 *     metric.
 *
 *   - `received_content`: queries about specific received content
 *     (newsletter, notification, automated). The received variant is the
 *     higher-value hit; Layer 2 must not regress these.
 *
 *   - `neutral`: queries where neither side is clearly higher-value
 *     (typically entity-name lookups). Used as a sanity check that
 *     Layer 2 doesn't break unrelated retrieval paths.
 *
 * The fixture is hand-authored (not generated) so each pair is a
 * deliberate apples-to-apples comparison — a query like "investor pitch
 * deck assumptions" hits BOTH the email the user actually wrote to a VC
 * AND a newsletter that happens to mention the same words.
 */

import type { RawSignal } from '@skytwin/memory-port';

export type AuthoringTier =
  | 'user_sent_originated'
  | 'user_sent_reply'
  | 'inbox_personal'
  | 'inbox_broadcast'
  | 'inbox_newsletter'
  | 'inbox_automated';

export type QueryClass = 'user_behavior' | 'received_content' | 'neutral';

export interface TierAblationSignal extends RawSignal {
  /**
   * Authoring tier used by `recordSignal` to stamp metadata. Tests use
   * this directly when seeding.
   */
  authoringTier: AuthoringTier;
  /**
   * Whether this signal is the *primary* relevant hit for a given query.
   * Higher-value than just "matches" — the user-authored variant for a
   * user_behavior query, the newsletter variant for a received_content
   * query, etc.
   */
  primaryForQuery: string[];
  /**
   * Whether this signal is a *secondary* relevant hit — same topic, lower
   * value. Used so R@5 catches both variants without penalizing them
   * equally on rank.
   */
  secondaryForQuery: string[];
}

export interface TierAblationQuery {
  id: string;
  query: string;
  classification: QueryClass;
  /** k for R@k / P@k. Default 5. */
  k?: number;
}

const BASE_TIME = new Date('2026-04-01T09:00:00Z').getTime();

function ts(daysOffset: number, hour = 9, minute = 0): Date {
  return new Date(BASE_TIME + daysOffset * 86400_000 + hour * 3600_000 + minute * 60_000);
}

function mkSignal(opts: {
  id: string;
  tier: AuthoringTier;
  daysOffset: number;
  from: string;
  to?: string;
  subject: string;
  body: string;
  primaryFor?: string[];
  secondaryFor?: string[];
}): TierAblationSignal {
  return {
    id: opts.id,
    source: 'gmail',
    type: 'email',
    timestamp: ts(opts.daysOffset, 10 + (opts.daysOffset % 8)),
    data: {
      messageId: opts.id,
      from: opts.from,
      to: opts.to ?? 'me@example.com',
      subject: opts.subject,
      text: opts.body,
      authoringTier: opts.tier,
    },
    authoringTier: opts.tier,
    primaryForQuery: opts.primaryFor ?? [],
    secondaryForQuery: opts.secondaryFor ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// LABELED SIGNALS — each labeled query has at least one authored + one
// received variant; the rest are tier-mixed distractors so the candidate
// pool isn't trivially small.
// ─────────────────────────────────────────────────────────────────────────

const LABELED: TierAblationSignal[] = [
  // ── Q1: "investor pitch deck assumptions" ── user_behavior ───────────
  mkSignal({
    id: 'q1-authored-1',
    tier: 'user_sent_originated',
    daysOffset: 1,
    from: 'me@example.com',
    to: 'partner@vc.example.com',
    subject: 'Series B investor pitch — Q3 assumptions deck',
    body: "Pitch deck assumptions for the Series B investor meeting. The model assumes 30% ARR growth, 20% margin expansion on the new pricing tier, and a hiring ramp of 12 engineers over the next two quarters. Open to feedback on the assumption set before we send it to the rest of the partners list.",
    primaryFor: ['q1'],
  }),
  mkSignal({
    id: 'q1-received-1',
    tier: 'inbox_newsletter',
    daysOffset: 5,
    from: 'newsletter@techcrunch.example.com',
    subject: 'Newsletter — Series B investor pitch deck templates',
    body: 'Top 10 Series B investor pitch decks of the year, ranked by which assumptions investors actually scrutinize. Pitch deck templates included.',
    secondaryFor: ['q1'],
  }),

  // ── Q2: "what I told the CFO about hiring" ── user_behavior ──────────
  mkSignal({
    id: 'q2-authored-1',
    tier: 'user_sent_originated',
    daysOffset: 3,
    from: 'me@example.com',
    to: 'cfo@acme.example.com',
    subject: 'Engineering hiring plan for next quarter',
    body: "Hiring plan: ramp engineering from 14 to 22 over the next two quarters. Recruiting pipeline is already sourcing for 4 senior backend + 2 frontend + 2 ML, and we'll need an opener for the platform team in Q4. Cost model in the linked sheet.",
    primaryFor: ['q2'],
  }),
  mkSignal({
    id: 'q2-received-1',
    tier: 'inbox_personal',
    daysOffset: 4,
    from: 'cfo@acme.example.com',
    subject: 'Re: Engineering hiring plan for next quarter',
    body: "Got the hiring plan. The CFO needs to see the cost model breakdown by quarter before we sign off on the platform team opener. Can we sync Thursday?",
    secondaryFor: ['q2'],
  }),

  // ── Q3: "I'll have the doc by Friday" ── user_behavior ──────────────
  // Tests the brief-reply downweight: a one-line authored reply that
  // exactly matches the query SHOULD lose to a longer authored thread.
  mkSignal({
    id: 'q3-authored-long',
    tier: 'user_sent_originated',
    daysOffset: 2,
    from: 'me@example.com',
    to: 'board-chair@acme.example.com',
    subject: 'Friday doc — governance section first pass',
    body: "Promised the board chair I would have the governance doc by Friday. First pass is attached — sections on compensation, risk committee charter, and the audit framework are complete. Open issues: still need to align with legal on the indemnification language, and the ESG section is a placeholder pending the consultant's input.",
    primaryFor: ['q3'],
  }),
  mkSignal({
    id: 'q3-authored-brief',
    tier: 'user_sent_reply',
    daysOffset: 2,
    from: 'me@example.com',
    to: 'board-chair@acme.example.com',
    subject: 'Re: Friday doc',
    body: 'k',
    secondaryFor: ['q3'],
  }),

  // ── Q4: "the AWS billing alert for this month" ── received_content ───
  // Layer 2 should NOT promote authored content over the actual receipt.
  mkSignal({
    id: 'q4-received-1',
    tier: 'inbox_automated',
    daysOffset: 10,
    from: 'no-reply@amazonaws.example.com',
    subject: 'AWS billing alert — May usage at 80% of forecast',
    body: 'Your AWS account billing alert. May usage is currently at 80% of the monthly forecast budget. Top three services driving spend: EC2, S3, CloudWatch. Detailed breakdown in the linked console.',
    primaryFor: ['q4'],
  }),
  mkSignal({
    id: 'q4-authored-1',
    tier: 'user_sent_originated',
    daysOffset: 11,
    from: 'me@example.com',
    to: 'infra@acme.example.com',
    subject: 'Investigating the AWS billing alert',
    body: 'Got the AWS billing alert this morning. Looking into the EC2 spend driver. Initial guess: the new staging cluster was provisioned without auto-shutdown. Will report back by EOD.',
    secondaryFor: ['q4'],
  }),

  // ── Q5: "GitHub Actions failure on main" ── received_content ─────────
  mkSignal({
    id: 'q5-received-1',
    tier: 'inbox_automated',
    daysOffset: 7,
    from: 'notifications@github.example.com',
    subject: 'Run failed: CI — main',
    body: 'The CI workflow run for the main branch failed at the integration-test step. Run summary, logs, and rerun link in the linked GitHub page. Failed job: ubuntu-latest integration.',
    primaryFor: ['q5'],
  }),

  // ── Q6: "newsletter about remote work" ── received_content ──────────
  mkSignal({
    id: 'q6-received-1',
    tier: 'inbox_newsletter',
    daysOffset: 9,
    from: 'newsletter@futureofwork.example.com',
    subject: 'Newsletter — remote work productivity research',
    body: 'This week in remote work newsletter: latest research on async-first teams, productivity surveys, and the great return-to-office debate revisited with new data from Q1.',
    primaryFor: ['q6'],
  }),

  // ── Q7: "Maya Chen" ── neutral (entity lookup; should not regress) ──
  mkSignal({
    id: 'q7-authored-1',
    tier: 'user_sent_originated',
    daysOffset: 6,
    from: 'me@example.com',
    to: 'hiring@acme.example.com',
    subject: 'Maya Chen — on-site loop scheduling',
    body: 'Scheduling Maya Chen for the on-site interview loop. Strong phone screen — proceeding with the full panel: systems design, behavioral, hiring manager, and lunch with the platform team. Maya is interviewing on Thursday.',
    primaryFor: ['q7'],
  }),
  mkSignal({
    id: 'q7-received-1',
    tier: 'inbox_personal',
    daysOffset: 5,
    from: 'recruiter@acme.example.com',
    subject: 'Maya Chen phone screen feedback',
    body: 'Maya Chen phone screen feedback attached. The candidate handled the design question well; clear communicator; strong recent background in distributed systems.',
    primaryFor: ['q7'],
  }),
];

// ─────────────────────────────────────────────────────────────────────────
// DISTRACTORS — tier-mixed signals that don't match any labeled query.
// Their job is to provide a realistic candidate pool so the multiplier
// has real competition to overcome.
// ─────────────────────────────────────────────────────────────────────────

// Distractor topics deliberately avoid keywords from the labeled queries
// ("investor", "hiring", "billing", "Friday doc", "newsletter", "GitHub",
// "remote work", "Maya Chen"). The point of a distractor is to be plausible
// padding that *doesn't* compete on text overlap with any labeled query —
// so the eval measures whether the tier multiplier alone is moving real
// ranks around.
const DISTRACTOR_TOPICS: Array<{
  subject: string;
  body: string;
}> = [
  { subject: 'school pickup schedule', body: 'reminder about the school pickup schedule for next week' },
  { subject: 'dentist appointment confirmation', body: 'dentist appointment confirmation for next tuesday at 3pm' },
  { subject: 'parking pass renewal', body: 'your parking pass is up for renewal next month' },
  { subject: 'sourdough starter recipe', body: 'sharing the sourdough starter recipe we talked about yesterday' },
  { subject: 'soccer practice rain delay', body: 'kids soccer practice rescheduled due to rain on saturday morning' },
  { subject: 'apartment lease renewal date', body: 'apartment lease renewal paperwork is due by the end of july' },
  { subject: 'plumber visit confirmation', body: 'confirming the plumber visit for kitchen sink leak repair thursday' },
  { subject: 'book club selection this month', body: 'this month book club selection is the latest le carre novel' },
  { subject: 'concert ticket presale code', body: 'presale code for the upcoming concert tickets opens tomorrow morning' },
  { subject: 'haircut appointment moved', body: 'haircut appointment has been moved from tuesday to thursday afternoon' },
];

/**
 * Distractor distribution chosen to roughly match real Gmail volumes:
 *   - ~12% authored (mix of originated + reply)
 *   - ~40% personal (one-to-one human mail)
 *   - ~15% broadcast (multi-recipient threads)
 *   - ~20% newsletter
 *   - ~13% automated
 *
 * The earlier fixture had 33% authored, which is unrealistic AND it broke
 * the ablation: weak-text-match authored distractors with a 1.5× boost
 * out-scored legitimate rank-1 received primaries that took a 0.8×
 * demote. Adjusting the mix is more honest than tuning the multipliers
 * around a corrupt corpus.
 */
function makeDistractors(): TierAblationSignal[] {
  const distribution: AuthoringTier[] = [
    'user_sent_originated', 'user_sent_originated',
    'user_sent_reply', 'user_sent_reply', 'user_sent_reply',
    // 5 authored / 40 total = 12.5%
    'inbox_personal', 'inbox_personal', 'inbox_personal', 'inbox_personal',
    'inbox_personal', 'inbox_personal', 'inbox_personal', 'inbox_personal',
    'inbox_personal', 'inbox_personal', 'inbox_personal', 'inbox_personal',
    'inbox_personal', 'inbox_personal', 'inbox_personal', 'inbox_personal',
    // 16 personal = 40%
    'inbox_broadcast', 'inbox_broadcast', 'inbox_broadcast',
    'inbox_broadcast', 'inbox_broadcast', 'inbox_broadcast',
    // 6 broadcast = 15%
    'inbox_newsletter', 'inbox_newsletter', 'inbox_newsletter', 'inbox_newsletter',
    'inbox_newsletter', 'inbox_newsletter', 'inbox_newsletter', 'inbox_newsletter',
    // 8 newsletter = 20%
    'inbox_automated', 'inbox_automated', 'inbox_automated', 'inbox_automated',
    'inbox_automated',
    // 5 automated = 12.5%
  ];

  const out: TierAblationSignal[] = [];
  for (let i = 0; i < distribution.length; i++) {
    const topic = DISTRACTOR_TOPICS[i % DISTRACTOR_TOPICS.length]!;
    const tier = distribution[i]!;
    const isAuthored = tier === 'user_sent_originated' || tier === 'user_sent_reply';
    out.push(
      mkSignal({
        id: `distractor-${i.toString().padStart(3, '0')}`,
        tier,
        daysOffset: 12 + (i % 14),
        from: isAuthored ? 'me@example.com' : `someone-${i}@example.com`,
        to: isAuthored ? `someone-${i}@example.com` : 'me@example.com',
        subject: `${topic.subject} (${i})`,
        body: `${topic.body} — variant ${i} with extra padding text to spread the embedding vector`,
      }),
    );
  }
  return out;
}

export function buildTierAblationCorpus(): TierAblationSignal[] {
  return [...LABELED, ...makeDistractors()];
}

export function buildTierAblationQueries(): TierAblationQuery[] {
  return [
    {
      id: 'q1',
      query: 'investor pitch deck Series B assumptions',
      classification: 'user_behavior',
    },
    {
      id: 'q2',
      query: 'engineering hiring plan ramp CFO',
      classification: 'user_behavior',
    },
    {
      id: 'q3',
      query: "Friday governance doc what I promised the board chair",
      classification: 'user_behavior',
    },
    {
      id: 'q4',
      query: 'AWS billing alert May usage',
      classification: 'received_content',
    },
    {
      id: 'q5',
      query: 'GitHub Actions CI run failed on main',
      classification: 'received_content',
    },
    {
      id: 'q6',
      query: 'newsletter remote work productivity research',
      classification: 'received_content',
    },
    {
      id: 'q7',
      query: 'Maya Chen interview loop',
      classification: 'neutral',
    },
  ];
}

// Helpers used by the eval test to pull relevance labels off the corpus.

export function primaryIdsForQuery(
  corpus: TierAblationSignal[],
  queryId: string,
): string[] {
  return corpus.filter((s) => s.primaryForQuery.includes(queryId)).map((s) => s.id);
}

export function secondaryIdsForQuery(
  corpus: TierAblationSignal[],
  queryId: string,
): string[] {
  return corpus.filter((s) => s.secondaryForQuery.includes(queryId)).map((s) => s.id);
}

export function allRelevantIdsForQuery(
  corpus: TierAblationSignal[],
  queryId: string,
): string[] {
  return [
    ...primaryIdsForQuery(corpus, queryId),
    ...secondaryIdsForQuery(corpus, queryId),
  ];
}
