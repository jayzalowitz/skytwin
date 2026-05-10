/**
 * Persona simulation: "Sam Patel" — a Series A SaaS founder over a 6-week window.
 *
 * The point of this fixture is to *drive* the gbrain memory layer the way a
 * real user would: a steady stream of signals (Gmail threads, calendar events,
 * notes, chat messages) interspersed with derived structure (entities,
 * triples, episodes) over a realistic timeline. The accompanying test
 * inspects the "profile" that emerges and asks the kind of questions a twin
 * would have to answer for this person.
 *
 * Storyline (six weeks, anchored on 2026-04-13 Monday):
 *   Week 1 (Apr 13-19): kickoff — fundraise prep, board materials, term sheet drafts
 *   Week 2 (Apr 20-26): VC meetings, hiring search opens (eng, growth)
 *   Week 3 (Apr 27 - May 3): term sheet received, lead investor due diligence
 *   Week 4 (May 4-10): hiring loops escalate, candidate offers extended
 *   Week 5 (May 11-17): fundraise close, board approval, partner offsite trip
 *   Week 6 (May 18-24): post-close hiring ramp + product roadmap planning
 *
 * Every signal carries a `tags` array — the test uses these to validate that
 * the memory layer actually surfaced the relevant context for each question.
 */

import type {
  RawSignal,
  Episode,
  KnowledgeEntity,
  KnowledgeTriple,
} from '@skytwin/memory-port';

export const SAM_USER_ID = 'sam-patel-uuid-fixture';
export const STORY_START = new Date('2026-04-13T08:00:00Z'); // Monday week 1

export interface TaggedSignal extends RawSignal {
  tags: string[];
}

export interface TaggedEntity extends KnowledgeEntity {
  tags: string[];
}

export interface TaggedTriple extends KnowledgeTriple {
  tags: string[];
}

export interface TaggedEpisode extends Episode {
  tags: string[];
}

function dayOffset(d: number, h = 9, m = 0): Date {
  return new Date(STORY_START.getTime() + d * 86400_000 + h * 3600_000 + m * 60_000);
}

function gmail(
  id: string,
  d: number,
  h: number,
  from: string,
  subject: string,
  text: string,
  tags: string[],
): TaggedSignal {
  return {
    id,
    source: 'gmail',
    type: 'email',
    timestamp: dayOffset(d, h),
    data: { from, subject, text },
    tags,
  };
}

function cal(
  id: string,
  d: number,
  h: number,
  title: string,
  attendees: string[],
  tags: string[],
): TaggedSignal {
  return {
    id,
    source: 'gcal',
    type: 'event',
    timestamp: dayOffset(d, h),
    data: { subject: title, from: 'calendar', attendees, summary: title },
    tags,
  };
}

function note(id: string, d: number, h: number, content: string, tags: string[]): TaggedSignal {
  return {
    id,
    source: 'note',
    type: 'quick-capture',
    timestamp: dayOffset(d, h),
    data: { text: content, summary: content },
    tags,
  };
}

function chat(
  id: string,
  d: number,
  h: number,
  participant: string,
  message: string,
  tags: string[],
): TaggedSignal {
  return {
    id,
    source: 'chat',
    type: 'message',
    timestamp: dayOffset(d, h),
    data: { from: participant, text: message },
    tags,
  };
}

// ── Story scripts: the actual sequence of life events for Sam over six weeks.

export function buildSamSignals(): TaggedSignal[] {
  const out: TaggedSignal[] = [];

  // ── Week 1 (Apr 13-19): fundraise prep, board materials, term sheet drafts ──
  out.push(
    gmail('w1-001', 0, 9, 'cofounder@beacon.example', 'Series A pitch deck v3 ready',
      'Updated the financials slide with the Q1 ARR — please review before tomorrows board prep call',
      ['fundraise', 'pitch-deck', 'cofounder']),
    cal('w1-002', 0, 14, 'Board prep — Series A pitch dry run',
      ['cofounder@beacon.example', 'chair@beacon-board.example'], ['fundraise', 'board']),
    note('w1-003', 1, 8, 'For pitch: emphasize that ARR doubled in Q1 and burn is at 14 months runway',
      ['fundraise', 'pitch-deck', 'metrics']),
    gmail('w1-004', 1, 11, 'mahesh@anchor-vc.example', 'Re: introductory call',
      'Thanks for the deck. Lets schedule a deep dive on the unit economics next week — Tuesday or Wednesday?',
      ['fundraise', 'anchor-vc']),
    gmail('w1-005', 2, 10, 'cfo-fractional@beacon.example', 'Updated cap table model',
      'Attached the cap table model with the 18-22% dilution scenarios for Series A',
      ['fundraise', 'cap-table']),
    cal('w1-006', 2, 15, 'Anchor VC partner meeting — Mahesh + team',
      ['mahesh@anchor-vc.example'], ['fundraise', 'anchor-vc']),
    note('w1-007', 2, 17,
      'Mahesh asked sharp questions about gross retention — confirmed our 96% NDR. He seemed engaged',
      ['fundraise', 'anchor-vc', 'metrics']),
    gmail('w1-008', 3, 9, 'chair@beacon-board.example', 'Quarterly board meeting agenda — May 14',
      'Adding a fundraise-status block to the May board deck. Send me the term sheet draft when you have it',
      ['board', 'fundraise']),
    note('w1-009', 4, 18,
      'Friday recap: pitch is tight, need to nail the path to 5x ARR slide. Anchor seems most engaged of the three',
      ['fundraise', 'recap']),
  );

  // ── Week 2 (Apr 20-26): more VCs, hiring search opens ──
  out.push(
    gmail('w2-001', 7, 9, 'recruiting-partner@beacon.example', 'Senior backend engineer JD ready',
      'Posting the JD for the senior backend role today. Need your sign-off on the equity band',
      ['hiring', 'engineering']),
    note('w2-002', 7, 11,
      'Equity band for senior backend: 0.15-0.30%. Match with our engineering compensation framework',
      ['hiring', 'engineering', 'equity']),
    cal('w2-003', 7, 14, 'Sandhill Capital — partner meeting',
      ['ej@sandhill.example'], ['fundraise', 'sandhill-vc']),
    gmail('w2-004', 8, 10, 'ej@sandhill.example', 'Great meeting + reference list',
      'Loved the conversation. Could we get reference calls with two of your top customers this week?',
      ['fundraise', 'sandhill-vc', 'references']),
    gmail('w2-005', 8, 13, 'mahesh@anchor-vc.example', 'Following up — partner pitch on Friday',
      'My partners want to meet you Friday. Can you do a 60-min full pitch with Q&A?',
      ['fundraise', 'anchor-vc']),
    cal('w2-006', 9, 11, 'Customer reference call: TechCorp ↔ Sandhill',
      ['ej@sandhill.example', 'cto@techcorp.example'], ['fundraise', 'sandhill-vc', 'references']),
    gmail('w2-007', 9, 15, 'recruiting-partner@beacon.example', 'First batch of senior backend candidates',
      'Three strong candidates for the senior backend role: Maya Chen, Daniel Park, Ines Costa',
      ['hiring', 'engineering']),
    note('w2-008', 10, 8,
      'Maya Chen looks strongest on system design — schedule her for the on-site loop first',
      ['hiring', 'engineering']),
    cal('w2-009', 11, 13, 'Anchor VC partner pitch — full deck',
      ['mahesh@anchor-vc.example'], ['fundraise', 'anchor-vc']),
    note('w2-010', 11, 17,
      'Pitch landed well — Mahesh asked when we want a term sheet. Said: ready when you are',
      ['fundraise', 'anchor-vc']),
  );

  // ── Week 3 (Apr 27 - May 3): term sheet received, due diligence ──
  out.push(
    gmail('w3-001', 14, 9, 'mahesh@anchor-vc.example', 'Term sheet — Anchor Series A lead',
      '$15M at $75M post, 18% target dilution, board seat, standard 1x liquidation. See PDF',
      ['fundraise', 'anchor-vc', 'term-sheet']),
    note('w3-002', 14, 11,
      'Anchor term sheet: $15M @ $75M post. Dilution 18%, board seat, 1x non-participating preferred. Liked',
      ['fundraise', 'anchor-vc', 'term-sheet']),
    gmail('w3-003', 14, 14, 'cfo-fractional@beacon.example', 'Term sheet redlines ready',
      'Marked up Anchor term sheet — preferred equity, anti-dilution, vesting acceleration. See attached',
      ['fundraise', 'term-sheet', 'legal']),
    cal('w3-004', 15, 10, 'Term sheet review with cofounder',
      ['cofounder@beacon.example'], ['fundraise', 'term-sheet']),
    gmail('w3-005', 15, 16, 'chair@beacon-board.example', 'Re: Term sheet review',
      'Numbers look right. Push on the protective provisions — they had asked for too many veto rights',
      ['fundraise', 'term-sheet', 'board']),
    note('w3-006', 16, 9,
      'Pushing back on protective provisions: drop veto on hiring above $250K, drop veto on individual contracts',
      ['fundraise', 'term-sheet', 'board']),
    gmail('w3-007', 16, 14, 'mahesh@anchor-vc.example', 'Re: Term sheet redlines',
      'Mostly fine. Lets keep budget veto, drop hiring veto. Compromise on contracts at $500K',
      ['fundraise', 'term-sheet']),
    cal('w3-008', 17, 11, 'Maya Chen — on-site interview loop',
      ['recruiting-partner@beacon.example'], ['hiring', 'engineering']),
    note('w3-009', 17, 18,
      'Maya Chen interview loop: strong yes from system design and coding. Soft yes on values — culture fit notes incoming',
      ['hiring', 'engineering']),
    gmail('w3-010', 18, 10, 'recruiting-partner@beacon.example', 'Maya Chen — debrief notes',
      'Strong yes from 3 of 4 panel members. Daniel Park scheduled for on-site next Tuesday',
      ['hiring', 'engineering']),
  );

  // ── Week 4 (May 4-10): hiring loops escalate, offers ──
  out.push(
    gmail('w4-001', 21, 9, 'recruiting-partner@beacon.example', 'Maya Chen offer letter',
      'Offer letter ready: $215K base, 0.25% equity, signing bonus $30K. Send when ready',
      ['hiring', 'engineering', 'offer']),
    note('w4-002', 21, 10,
      'Approved Maya Chen offer at top of band. She has competing offer from BigCo at $230K, betting equity wins',
      ['hiring', 'engineering', 'offer']),
    cal('w4-003', 22, 11, 'Daniel Park — on-site interview loop',
      ['recruiting-partner@beacon.example'], ['hiring', 'engineering']),
    chat('w4-004', 22, 17, 'recruiting-partner@beacon.example',
      'Daniel did well — strong yes on architecture, weak signal on coding pace. Borderline hire',
      ['hiring', 'engineering']),
    gmail('w4-005', 23, 9, 'maya.chen@example.com', 'Accepted — start date June 2',
      'Excited to join Beacon! Confirming start date June 2. Looking forward to it',
      ['hiring', 'engineering', 'offer']),
    note('w4-006', 23, 10, 'Maya accepted! Now working on Daniel decision — leaning yes if we can flex on level',
      ['hiring', 'engineering']),
    gmail('w4-007', 24, 13, 'mahesh@anchor-vc.example', 'Final term sheet — signed PDF',
      'Term sheet executed. Closing target May 12. Diligence list attached',
      ['fundraise', 'anchor-vc', 'term-sheet']),
    note('w4-008', 24, 16,
      'Term sheet signed! Closing May 12. Need to set up data room — last fundraise we used Box, doing same',
      ['fundraise', 'closing', 'data-room']),
    cal('w4-009', 25, 14, 'Diligence call — anchor legal',
      ['mahesh@anchor-vc.example'], ['fundraise', 'closing', 'legal']),
  );

  // ── Week 5 (May 11-17): close + board approval + partner trip ──
  out.push(
    gmail('w5-001', 28, 8, 'cfo-fractional@beacon.example', 'Closing day prep',
      'Wire transfer instructions sent to Anchor. Stock issuance docs ready for signature',
      ['fundraise', 'closing']),
    cal('w5-002', 28, 11, 'Series A closing — wire received',
      ['mahesh@anchor-vc.example'], ['fundraise', 'closing']),
    note('w5-003', 28, 13, 'Wire received. $15M in the bank. Massive moment for Beacon. Time to execute',
      ['fundraise', 'closing']),
    gmail('w5-004', 29, 9, 'chair@beacon-board.example', 'Re: Series A closed',
      'Congrats. The May 14 board meeting will formally approve the round',
      ['fundraise', 'closing', 'board']),
    cal('w5-005', 30, 14, 'Board meeting — Series A approval',
      ['chair@beacon-board.example', 'mahesh@anchor-vc.example'],
      ['fundraise', 'closing', 'board']),
    note('w5-006', 30, 17, 'Board approved Series A unanimously. Mahesh joining board officially',
      ['fundraise', 'closing', 'board']),
    cal('w5-007', 32, 0, 'Lisbon offsite with partner — vacation block',
      ['partner@example.com'], ['vacation', 'lisbon-trip']),
    gmail('w5-008', 32, 10, 'booking@hotelalfama.example', 'Reservation confirmed — May 16-22',
      'Your reservation at Hotel Alfama May 16-22 is confirmed',
      ['vacation', 'lisbon-trip']),
    note('w5-009', 33, 9,
      'Travel light, pack laptop only for emergencies. Daniel offer extended; recruiting will field his response',
      ['vacation', 'lisbon-trip', 'hiring']),
  );

  // ── Week 6 (May 18-24): hiring ramp + roadmap ──
  out.push(
    gmail('w6-001', 35, 9, 'recruiting-partner@beacon.example', 'Daniel Park accepted',
      'Daniel accepted at $185K + 0.18% equity. Start date June 9. Now ramping growth role search',
      ['hiring', 'engineering', 'offer']),
    note('w6-002', 35, 11,
      'Two senior engineers locked in for June. Need to think about engineering manager role too',
      ['hiring', 'engineering']),
    cal('w6-003', 36, 13, 'Roadmap planning — Q3 priorities',
      ['cofounder@beacon.example'], ['roadmap', 'q3']),
    note('w6-004', 36, 16,
      'Q3 roadmap themes: enterprise tier launch, eng team scaling, second product line research',
      ['roadmap', 'q3']),
    gmail('w6-005', 37, 10, 'mahesh@anchor-vc.example', 'Welcome aboard — board cadence',
      'Excited for board #1 in June. Lets meet weekly for the first month, monthly after that',
      ['board', 'mahesh']),
    chat('w6-006', 38, 14, 'cofounder@beacon.example',
      'We should start the head of growth search this week. Three referrals to start',
      ['hiring', 'growth']),
    note('w6-007', 39, 9,
      'Friday review: Series A closed. Maya + Daniel hired. Board cadence set. Lisbon trip was rejuvenating',
      ['recap', 'fundraise', 'hiring', 'vacation']),
  );

  return out;
}

export function buildSamEntities(): TaggedEntity[] {
  return [
    {
      id: 'ent-cofounder',
      userId: SAM_USER_ID,
      name: 'Priya Iyer',
      entityType: 'person',
      attributes: { role: 'cofounder', email: 'cofounder@beacon.example' },
      firstSeenAt: dayOffset(0),
      lastSeenAt: dayOffset(40),
      tags: ['cofounder'],
    },
    {
      id: 'ent-mahesh',
      userId: SAM_USER_ID,
      name: 'Mahesh Rao',
      entityType: 'person',
      attributes: { role: 'lead-investor', firm: 'Anchor VC', email: 'mahesh@anchor-vc.example' },
      firstSeenAt: dayOffset(1),
      lastSeenAt: dayOffset(40),
      tags: ['anchor-vc', 'fundraise'],
    },
    {
      id: 'ent-chair',
      userId: SAM_USER_ID,
      name: 'Erica Holm',
      entityType: 'person',
      attributes: { role: 'board-chair', email: 'chair@beacon-board.example' },
      firstSeenAt: dayOffset(3),
      lastSeenAt: dayOffset(35),
      tags: ['board'],
    },
    {
      id: 'ent-maya',
      userId: SAM_USER_ID,
      name: 'Maya Chen',
      entityType: 'person',
      attributes: { role: 'engineer-hire', start: '2026-06-02' },
      firstSeenAt: dayOffset(9),
      lastSeenAt: dayOffset(23),
      tags: ['hiring'],
    },
    {
      id: 'ent-daniel',
      userId: SAM_USER_ID,
      name: 'Daniel Park',
      entityType: 'person',
      attributes: { role: 'engineer-hire', start: '2026-06-09' },
      firstSeenAt: dayOffset(9),
      lastSeenAt: dayOffset(35),
      tags: ['hiring'],
    },
    {
      id: 'ent-anchor-vc',
      userId: SAM_USER_ID,
      name: 'Anchor VC',
      entityType: 'organization',
      attributes: { type: 'vc', stage: 'series-a-lead' },
      firstSeenAt: dayOffset(1),
      lastSeenAt: dayOffset(40),
      tags: ['fundraise'],
    },
    {
      id: 'ent-beacon',
      userId: SAM_USER_ID,
      name: 'Beacon',
      entityType: 'organization',
      attributes: { type: 'company', stage: 'series-a' },
      firstSeenAt: dayOffset(0),
      lastSeenAt: dayOffset(40),
      tags: ['company'],
    },
  ];
}

export function buildSamTriples(): TaggedTriple[] {
  return [
    {
      id: 'tri-mahesh-firm',
      userId: SAM_USER_ID,
      subject: 'Mahesh Rao',
      predicate: 'partner_at',
      object: 'Anchor VC',
      validFrom: dayOffset(1),
      tags: ['anchor-vc'],
    },
    {
      id: 'tri-anchor-leads',
      userId: SAM_USER_ID,
      subject: 'Anchor VC',
      predicate: 'leads_round',
      object: 'Beacon Series A',
      validFrom: dayOffset(14),
      tags: ['fundraise'],
    },
    {
      id: 'tri-maya-role',
      userId: SAM_USER_ID,
      subject: 'Maya Chen',
      predicate: 'hired_for',
      object: 'Senior Backend Engineer',
      validFrom: dayOffset(23),
      tags: ['hiring'],
    },
    {
      id: 'tri-daniel-role',
      userId: SAM_USER_ID,
      subject: 'Daniel Park',
      predicate: 'hired_for',
      object: 'Senior Backend Engineer',
      validFrom: dayOffset(35),
      tags: ['hiring'],
    },
    {
      id: 'tri-chair-board',
      userId: SAM_USER_ID,
      subject: 'Erica Holm',
      predicate: 'chairs',
      object: 'Beacon Board',
      validFrom: dayOffset(0),
      tags: ['board'],
    },
    {
      id: 'tri-mahesh-board',
      userId: SAM_USER_ID,
      subject: 'Mahesh Rao',
      predicate: 'joins_board',
      object: 'Beacon Board',
      validFrom: dayOffset(30),
      tags: ['board', 'fundraise'],
    },
  ];
}

export function buildSamEpisodes(): TaggedEpisode[] {
  return [
    {
      id: 'ep-pitch-anchor',
      userId: SAM_USER_ID,
      wing: 'work',
      summary: 'Pitched Anchor VC partner meeting — strong reception on unit economics',
      startedAt: dayOffset(2, 15),
      endedAt: dayOffset(2, 16, 30),
      metadata: { kind: 'pitch', vc: 'Anchor VC' },
      tags: ['fundraise', 'anchor-vc'],
    },
    {
      id: 'ep-term-sheet-received',
      userId: SAM_USER_ID,
      wing: 'work',
      summary: 'Received Anchor term sheet: $15M at $75M post — accepted with redlines',
      startedAt: dayOffset(14, 9),
      endedAt: dayOffset(14, 10),
      metadata: { kind: 'milestone', stage: 'term-sheet' },
      tags: ['fundraise', 'term-sheet', 'anchor-vc'],
    },
    {
      id: 'ep-maya-hire',
      userId: SAM_USER_ID,
      wing: 'work',
      summary: 'Approved Maya Chen offer at top of equity band',
      startedAt: dayOffset(21, 10),
      endedAt: dayOffset(21, 11),
      metadata: { kind: 'hire-approval', candidate: 'Maya Chen' },
      tags: ['hiring', 'engineering'],
    },
    {
      id: 'ep-closing-day',
      userId: SAM_USER_ID,
      wing: 'work',
      summary: 'Series A closed — $15M wire from Anchor received and stock issued',
      startedAt: dayOffset(28, 11),
      endedAt: dayOffset(28, 12),
      metadata: { kind: 'milestone', stage: 'close' },
      tags: ['fundraise', 'closing'],
    },
    {
      id: 'ep-board-approval',
      userId: SAM_USER_ID,
      wing: 'work',
      summary: 'Board unanimously approved Series A; Mahesh Rao joining board',
      startedAt: dayOffset(30, 14),
      endedAt: dayOffset(30, 15, 30),
      metadata: { kind: 'milestone', stage: 'board-approval' },
      tags: ['fundraise', 'board'],
    },
    {
      id: 'ep-vacation',
      userId: SAM_USER_ID,
      wing: 'personal',
      summary: 'Lisbon offsite with partner — May 16-22 — rejuvenating week',
      startedAt: dayOffset(33),
      endedAt: dayOffset(39),
      metadata: { kind: 'vacation' },
      tags: ['vacation', 'lisbon-trip'],
    },
  ];
}

/**
 * Inspector questions — what a twin would have to answer for Sam at week 6.
 * Each question lists tags it should retrieve from. The test scores precision
 * by checking how many returned hits actually carry one of those tags.
 */
export interface PersonaQuestion {
  question: string;
  expectedTags: string[];
  /** How many top-K results to inspect (defaults to 5). */
  k?: number;
}

export function buildSamQuestions(): PersonaQuestion[] {
  return [
    {
      question: 'who led our Series A and what were the terms',
      expectedTags: ['fundraise', 'anchor-vc', 'term-sheet'],
    },
    {
      question: 'what hiring is locked in for engineering this June',
      expectedTags: ['hiring', 'engineering'],
    },
    {
      question: 'when is the Lisbon trip and the booking',
      expectedTags: ['vacation', 'lisbon-trip'],
    },
    {
      question: 'what board approval happened around the close',
      expectedTags: ['board', 'closing'],
    },
    {
      question: 'cap table dilution model for Series A',
      expectedTags: ['fundraise', 'cap-table'],
    },
  ];
}
