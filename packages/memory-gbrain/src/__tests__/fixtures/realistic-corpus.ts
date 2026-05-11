/**
 * Realistic-corpus fixture for the gbrain backend.
 *
 * Models what a SkyTwin user actually accumulates over their first month
 * of use: a mix of Gmail signals (newsletters, work threads, board
 * communications, personal notes), Google Calendar events (recurring
 * standups, ad-hoc meetings, vacation blocks), notes (Cmd+J quick capture),
 * code references (function signatures from `idle-miner`), and chat snippets.
 *
 * The "needles" — items that a relevance-graded query should find — are
 * tagged with `relevantFor` so recall/precision tests can score retrieval
 * automatically. Noise items have `relevantFor: []`.
 *
 * Distribution roughly matches what we observe in dev fixture data:
 *   ~45% gmail, ~25% calendar, ~15% notes, ~10% code, ~5% chat
 *
 * Total ~500 records. Generated deterministically so test runs are stable.
 */

import type { RawSignal, Episode, KnowledgeEntity, KnowledgeTriple } from '@skytwin/memory-port';

export interface FixtureSignal extends RawSignal {
  relevantFor: string[];
}

export interface FixtureItem<T = unknown> {
  payload: T;
  relevantFor: string[];
}

const BASE_TIME = new Date('2026-04-01T09:00:00Z').getTime();

function ts(daysOffset: number, hour = 9, minute = 0): Date {
  return new Date(BASE_TIME + daysOffset * 86400_000 + hour * 3600_000 + minute * 60_000);
}

// ── Gmail signals ─────────────────────────────────────────────────────────

const gmailSeed: Array<{
  id: string;
  daysOffset: number;
  from: string;
  subject: string;
  snippet: string;
  relevantFor: string[];
}> = [
  // Q2 budget thread (relevant for "budget" / "Q2 forecast" / "CFO")
  {
    id: 'gm-budget-001',
    daysOffset: 0,
    from: 'cfo@acme.example.com',
    subject: 'Q2 budget review — Tuesday at 10am',
    snippet: 'Please come prepared with department-level breakdowns for the Q2 forecast meeting Tuesday',
    relevantFor: ['budget', 'q2-forecast', 'cfo-thread'],
  },
  {
    id: 'gm-budget-002',
    daysOffset: 0,
    from: 'finance-ops@acme.example.com',
    subject: 'Re: Q2 budget review — Tuesday at 10am',
    snippet: 'Adding the Tableau dashboard link for the Q2 budget. Forecast model is on tab 3',
    relevantFor: ['budget', 'q2-forecast'],
  },
  {
    id: 'gm-budget-003',
    daysOffset: 1,
    from: 'cfo@acme.example.com',
    subject: 'Re: Q2 budget review — Tuesday at 10am',
    snippet: 'Reschedule to Wednesday afternoon — board call moved into Tuesday slot',
    relevantFor: ['budget', 'q2-forecast', 'cfo-thread'],
  },
  // Board comms (relevant for "board" / "governance")
  {
    id: 'gm-board-001',
    daysOffset: 2,
    from: 'chair@board.acme.example.com',
    subject: 'Board materials for the May meeting',
    snippet: 'Draft board deck attached. Please review the governance section especially',
    relevantFor: ['board', 'governance'],
  },
  {
    id: 'gm-board-002',
    daysOffset: 3,
    from: 'corporate-secretary@acme.example.com',
    subject: 'May board meeting calendar invites',
    snippet: 'Sending invites for the May 14 board meeting and the audit committee pre-read',
    relevantFor: ['board', 'governance'],
  },
  // Hiring (relevant for "hiring" / "engineering interviews")
  {
    id: 'gm-hire-001',
    daysOffset: 4,
    from: 'recruiting@acme.example.com',
    subject: 'Senior backend engineer — phone screen feedback',
    snippet: 'Candidate Maya Chen passed the phone screen. Strong on distributed systems',
    relevantFor: ['hiring', 'engineering'],
  },
  {
    id: 'gm-hire-002',
    daysOffset: 5,
    from: 'recruiting@acme.example.com',
    subject: 'Interview loop scheduling for Maya Chen',
    snippet: 'Proposing Tuesday afternoon for the on-site loop — system design + coding + values',
    relevantFor: ['hiring', 'engineering'],
  },
  // Personal — vacation planning (relevant for "vacation" / "trip")
  {
    id: 'gm-trip-001',
    daysOffset: 6,
    from: 'partner@example.com',
    subject: 'Lisbon trip — flights booked',
    snippet: 'TAP Air Portugal confirmed — June 14-22. Hotel options in Alfama still open',
    relevantFor: ['vacation', 'lisbon-trip'],
  },
  {
    id: 'gm-trip-002',
    daysOffset: 7,
    from: 'booking@hotelalfama.example',
    subject: 'Reservation confirmation — June 14',
    snippet: 'Your reservation for two guests at Hotel Alfama, June 14-22, is confirmed',
    relevantFor: ['vacation', 'lisbon-trip'],
  },
  // Newsletter noise (relevant for none — just background)
  {
    id: 'gm-news-001',
    daysOffset: 0,
    from: 'newsletter@bigtech.example',
    subject: 'Weekly tech roundup — issue 142',
    snippet: 'This week: new database releases, an AI infra deep dive, and our take on the latest VC moves',
    relevantFor: [],
  },
  {
    id: 'gm-news-002',
    daysOffset: 7,
    from: 'newsletter@stratechery.example',
    subject: 'Aggregation theory revisited',
    snippet: 'Twelve years on, an updated framework for understanding platform competition',
    relevantFor: [],
  },
];

// ── Calendar events ───────────────────────────────────────────────────────

const calendarSeed: Array<{
  id: string;
  daysOffset: number;
  hour: number;
  title: string;
  attendees: string[];
  relevantFor: string[];
}> = [
  {
    id: 'cal-budget-001',
    daysOffset: 0,
    hour: 10,
    title: 'Q2 budget review',
    attendees: ['cfo@acme.example.com', 'finance-ops@acme.example.com'],
    relevantFor: ['budget', 'q2-forecast', 'cfo-thread'],
  },
  {
    id: 'cal-board-001',
    daysOffset: 14,
    hour: 14,
    title: 'May board meeting',
    attendees: ['chair@board.acme.example.com'],
    relevantFor: ['board', 'governance'],
  },
  {
    id: 'cal-hire-001',
    daysOffset: 8,
    hour: 13,
    title: 'Maya Chen — on-site loop kickoff',
    attendees: ['recruiting@acme.example.com'],
    relevantFor: ['hiring', 'engineering'],
  },
  {
    id: 'cal-vacation-001',
    daysOffset: 60,
    hour: 0,
    title: 'Lisbon — out of office',
    attendees: [],
    relevantFor: ['vacation', 'lisbon-trip'],
  },
  {
    id: 'cal-standup-001',
    daysOffset: 0,
    hour: 9,
    title: 'Eng standup',
    attendees: ['eng-team@acme.example.com'],
    relevantFor: [],
  },
];

// ── Notes (Cmd+J quick capture) ───────────────────────────────────────────

const notesSeed: Array<{
  id: string;
  daysOffset: number;
  content: string;
  relevantFor: string[];
}> = [
  {
    id: 'note-001',
    daysOffset: 1,
    content: 'For the Q2 budget review: ask about the engineering hiring forecast and the SaaS line-item growth',
    relevantFor: ['budget', 'q2-forecast', 'hiring'],
  },
  {
    id: 'note-002',
    daysOffset: 5,
    content: 'Maya Chen interview prep: focus on system design — distributed locking, idempotency keys',
    relevantFor: ['hiring', 'engineering'],
  },
  {
    id: 'note-003',
    daysOffset: 6,
    content: 'Lisbon trip — packing list reminder, check passport expiry, find pet-sitter for May 14 onwards',
    relevantFor: ['vacation', 'lisbon-trip'],
  },
];

// ── Code references (idle-miner output) ──────────────────────────────────

const codeSeed: Array<{
  id: string;
  daysOffset: number;
  signature: string;
  filePath: string;
  relevantFor: string[];
}> = [
  {
    id: 'code-001',
    daysOffset: 2,
    signature: 'function processSignalForBudgetForecast(signal: RawSignal): BudgetEstimate',
    filePath: 'apps/worker/src/jobs/budget-forecaster.ts',
    relevantFor: ['code-budget'],
  },
  {
    id: 'code-002',
    daysOffset: 3,
    signature: 'export class BoardMaterialsRenderer { render(deck: BoardDeck): RenderedDeck }',
    filePath: 'apps/web/src/board/materials-renderer.tsx',
    relevantFor: ['code-board'],
  },
  {
    id: 'code-003',
    daysOffset: 4,
    signature: 'export function scheduleHiringLoop(candidate: Candidate, slot: TimeSlot): InterviewLoop',
    filePath: 'apps/api/src/routes/hiring.ts',
    relevantFor: ['code-hiring'],
  },
];

// ── Chat snippets ─────────────────────────────────────────────────────────

const chatSeed: Array<{
  id: string;
  daysOffset: number;
  participant: string;
  message: string;
  relevantFor: string[];
}> = [
  {
    id: 'chat-001',
    daysOffset: 0,
    participant: 'cfo@acme.example.com',
    message: 'Quick heads up: I will need the engineering ramp slide before the Q2 review on Tuesday',
    relevantFor: ['budget', 'q2-forecast', 'engineering'],
  },
  {
    id: 'chat-002',
    daysOffset: 5,
    participant: 'recruiting@acme.example.com',
    message: 'Maya Chen prefers afternoon slots — locking in the interview loop for Tuesday after lunch',
    relevantFor: ['hiring', 'engineering'],
  },
];

// ── Generators (filling out to 500 with deterministic noise) ──────────────

/**
 * Generate `count` deterministic noise signals seeded by `prefix`. Used to
 * pad the corpus to a realistic size — the noise has `relevantFor: []` so it
 * shouldn't surface for any labeled query.
 */
export function generateNoiseSignals(count: number, prefix = 'noise'): FixtureSignal[] {
  const sources = ['gmail', 'cal', 'note', 'chat'];
  const TOPICS = [
    'tax-filing',
    'plumbing-repair',
    'birthday-party',
    'gym-renewal',
    'dentist-checkup',
    'amazon-delivery',
    'netflix-billing',
    'tax-document',
    'recipe-share',
    'book-club',
    'dog-vet',
    'school-pickup',
  ];
  const out: FixtureSignal[] = [];
  for (let i = 0; i < count; i++) {
    const source = sources[i % sources.length] ?? 'gmail';
    const topic = TOPICS[i % TOPICS.length] ?? 'misc';
    out.push({
      id: `${prefix}-${i.toString().padStart(4, '0')}`,
      source,
      type: source === 'gmail' ? 'email' : source === 'cal' ? 'event' : source,
      timestamp: ts(i % 28, 8 + (i % 10), i % 60),
      data: {
        subject: `${topic} reminder #${i}`,
        from: `noreply-${i}@example.com`,
        text: `Routine ${topic} message body number ${i} — nothing to do here`,
      },
      relevantFor: [],
    });
  }
  return out;
}

export function buildRealisticSignals(): FixtureSignal[] {
  const out: FixtureSignal[] = [];

  for (const g of gmailSeed) {
    out.push({
      id: g.id,
      source: 'gmail',
      type: 'email',
      timestamp: ts(g.daysOffset, 9 + (gmailSeed.indexOf(g) % 8)),
      data: {
        from: g.from,
        subject: g.subject,
        text: g.snippet,
      },
      relevantFor: g.relevantFor,
    });
  }

  for (const c of calendarSeed) {
    out.push({
      id: c.id,
      source: 'gcal',
      type: 'event',
      timestamp: ts(c.daysOffset, c.hour),
      data: {
        subject: c.title,
        from: 'calendar@acme.example.com',
        attendees: c.attendees,
      },
      relevantFor: c.relevantFor,
    });
  }

  for (const n of notesSeed) {
    out.push({
      id: n.id,
      source: 'note',
      type: 'quick-capture',
      timestamp: ts(n.daysOffset, 12),
      data: {
        text: n.content,
        summary: n.content,
      },
      relevantFor: n.relevantFor,
    });
  }

  for (const code of codeSeed) {
    out.push({
      id: code.id,
      source: 'idle-miner',
      type: 'code-symbol',
      timestamp: ts(code.daysOffset, 11),
      data: {
        subject: code.signature,
        from: code.filePath,
      },
      relevantFor: code.relevantFor,
    });
  }

  for (const chat of chatSeed) {
    out.push({
      id: chat.id,
      source: 'chat',
      type: 'message',
      timestamp: ts(chat.daysOffset, 10),
      data: {
        from: chat.participant,
        text: chat.message,
      },
      relevantFor: chat.relevantFor,
    });
  }

  return out;
}

/**
 * Labeled query set for recall/precision tests. Each query has a list of
 * `relevantIds` — the corpus IDs the query SHOULD return (in any order).
 */
export interface LabeledQuery {
  query: string;
  relevantIds: string[];
  /** Top-K to score (defaults to 5 = R@5 / P@5). */
  k?: number;
}

export function buildLabeledQueries(corpus: FixtureSignal[]): LabeledQuery[] {
  const idsForLabel = (label: string): string[] =>
    corpus.filter((s) => s.relevantFor.includes(label)).map((s) => s.id);

  return [
    { query: 'Q2 budget review meeting Tuesday', relevantIds: idsForLabel('q2-forecast') },
    { query: 'budget forecast CFO', relevantIds: idsForLabel('cfo-thread') },
    { query: 'May board meeting governance', relevantIds: idsForLabel('board') },
    { query: 'Maya Chen engineering interview loop', relevantIds: idsForLabel('hiring') },
    { query: 'Lisbon trip vacation flight booking', relevantIds: idsForLabel('lisbon-trip') },
    { query: 'engineering hiring ramp', relevantIds: idsForLabel('engineering') },
  ];
}

// ── Realistic episodes + entities + triples ──────────────────────────────

export function buildRealisticEpisodes(): Array<FixtureItem<Episode>> {
  return [
    {
      payload: {
        id: 'ep-budget-001',
        userId: 'PLACEHOLDER',
        wing: 'work',
        summary: 'Approved Q2 engineering hiring ramp during budget review',
        startedAt: ts(0, 10),
        endedAt: ts(0, 11),
        metadata: { decision_kind: 'approval' },
      },
      relevantFor: ['budget', 'q2-forecast'],
    },
    {
      payload: {
        id: 'ep-board-001',
        userId: 'PLACEHOLDER',
        wing: 'work',
        summary: 'Reviewed governance section of May board deck — flagged compensation table',
        startedAt: ts(2, 14),
        endedAt: ts(2, 15),
        metadata: { decision_kind: 'review' },
      },
      relevantFor: ['board', 'governance'],
    },
    {
      payload: {
        id: 'ep-hire-001',
        userId: 'PLACEHOLDER',
        wing: 'work',
        summary: 'Decided to advance Maya Chen to on-site loop after phone screen',
        startedAt: ts(4, 16),
        endedAt: ts(4, 17),
        metadata: { decision_kind: 'approval' },
      },
      relevantFor: ['hiring', 'engineering'],
    },
  ];
}

export function buildRealisticEntities(): Array<FixtureItem<KnowledgeEntity>> {
  return [
    {
      payload: {
        id: 'ent-cfo',
        userId: 'PLACEHOLDER',
        name: 'CFO Jane',
        entityType: 'person',
        attributes: { email: 'cfo@acme.example.com', role: 'CFO' },
        firstSeenAt: ts(0),
        lastSeenAt: ts(7),
      },
      relevantFor: ['cfo-thread'],
    },
    {
      payload: {
        id: 'ent-acme',
        userId: 'PLACEHOLDER',
        name: 'Acme Corp',
        entityType: 'organization',
        attributes: { domain: 'acme.example.com' },
        firstSeenAt: ts(0),
        lastSeenAt: ts(20),
      },
      relevantFor: ['board', 'governance', 'cfo-thread'],
    },
    {
      payload: {
        id: 'ent-maya',
        userId: 'PLACEHOLDER',
        name: 'Maya Chen',
        entityType: 'person',
        attributes: { role: 'candidate' },
        firstSeenAt: ts(4),
        lastSeenAt: ts(8),
      },
      relevantFor: ['hiring', 'engineering'],
    },
  ];
}

export function buildRealisticTriples(): Array<FixtureItem<KnowledgeTriple>> {
  return [
    {
      payload: {
        id: 'tri-001',
        userId: 'PLACEHOLDER',
        subject: 'CFO Jane',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: ts(0),
      },
      relevantFor: ['cfo-thread'],
    },
    {
      payload: {
        id: 'tri-002',
        userId: 'PLACEHOLDER',
        subject: 'Maya Chen',
        predicate: 'candidate_for',
        object: 'Senior Backend Engineer',
        validFrom: ts(4),
      },
      relevantFor: ['hiring'],
    },
    {
      payload: {
        id: 'tri-003',
        userId: 'PLACEHOLDER',
        subject: 'Acme Corp',
        predicate: 'has_board_meeting',
        object: 'May 14',
        validFrom: ts(2),
      },
      relevantFor: ['board', 'governance'],
    },
  ];
}
