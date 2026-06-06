import { describe, it, expect } from 'vitest';
import { extractCommitments } from '../commitment-extractor.js';
import type { SignalText } from '../signal-text.js';

function authored(body: string, source = 'gmail', participants = ['a@x.com']): SignalText {
  return {
    source,
    title: '',
    body,
    authoringTier: source === 'voice' ? 'authored_originated' : 'user_sent_originated',
    authoredByUser: true,
    occurredAt: new Date('2026-03-01T12:00:00Z'),
    participants,
  };
}

describe('extractCommitments (spec 02)', () => {
  it('extracts multiple first-person commitments with their source spans (AC1)', () => {
    const c = extractCommitments(
      authored("I'll send the draft tomorrow. Also I will call the vendor next week."),
    );
    expect(c).toHaveLength(2);
    expect(c[0]!.text).toBe('Send the draft tomorrow');
    expect(c[0]!.rawSpan).toContain("I'll send the draft");
    expect(c[1]!.text).toBe('Call the vendor next week');
    expect(c.every((x) => x.committedTo.includes('a@x.com'))).toBe(true);
  });

  it('normalizes "let me ..." and "I can ..." to imperatives', () => {
    expect(extractCommitments(authored('Let me pull the numbers.'))[0]!.text).toBe(
      'Pull the numbers',
    );
    expect(extractCommitments(authored('I can reach out to them.'))[0]!.text).toBe(
      'Reach out to them',
    );
  });

  it('returns [] for identical phrasing in NON-authored (inbound) content (AC2, safety)', () => {
    const inbound: SignalText = {
      source: 'gmail',
      title: '',
      body: "I'll send the draft tomorrow.",
      authoringTier: 'inbox_personal',
      authoredByUser: false,
      occurredAt: new Date('2026-03-01T12:00:00Z'),
      participants: [],
    };
    expect(extractCommitments(inbound)).toEqual([]);
  });

  it('does not extract questions, past tense, third-party, or hypotheticals (AC3)', () => {
    const body = [
      'Can you send it over?',
      'I sent the draft yesterday.',
      "She'll handle the vendor.",
      'I would do it if I could.',
      "I'd send it but I'm slammed.",
      "I can't make the meeting.",
    ].join(' ');
    expect(extractCommitments(authored(body))).toEqual([]);
  });

  it('does NOT run on sources outside the commitments matrix (filesystem), even if authored (AC4)', () => {
    const fileSig = authored("I'll refactor this module.", 'filesystem');
    fileSig.authoringTier = 'authored_originated';
    expect(extractCommitments(fileSig)).toEqual([]);
  });

  it('runs on authored voice transcripts (multi-source showcase)', () => {
    const c = extractCommitments(authored("I'll call the vendor on Monday.", 'voice'));
    expect(c).toHaveLength(1);
    expect(c[0]!.text).toBe('Call the vendor on Monday');
  });

  it('captures a deadlineHint when present, null otherwise (AC7)', () => {
    expect(extractCommitments(authored("I'll ship it in 3 days."))[0]!.deadlineHint).toMatch(
      /3 days/i,
    );
    expect(extractCommitments(authored("I'll review the PR."))[0]!.deadlineHint).toBeNull();
  });

  it('collapses a commitment restated within the same signal (dedup, AC4)', () => {
    const c = extractCommitments(authored("I'll send the report. I will send the report."));
    expect(c).toHaveLength(1);
  });

  it('keeps a real commitment that shares a sentence with a negated clause (review #6)', () => {
    const c = extractCommitments(
      authored("I'll send the report, and if I have time I'll also review the deck."),
    );
    expect(c.map((x) => x.text)).toContain('Send the report');
  });

  it('does not treat "by <person>" as a deadline hint (review #7)', () => {
    expect(extractCommitments(authored("I'll be reviewed by Bob."))[0]?.deadlineHint ?? null).toBeNull();
    expect(extractCommitments(authored("I'll finish by Friday."))[0]!.deadlineHint).toMatch(/friday/i);
  });
});
