import { describe, it, expect } from 'vitest';
import type { RawSignal } from '@skytwin/connectors';
import { toSignalText, isAuthoredByUser } from '../signal-text.js';

function sig(partial: Partial<RawSignal> & Pick<RawSignal, 'source' | 'data'>): RawSignal {
  return {
    id: partial.id ?? 'sig_test',
    source: partial.source,
    type: partial.type ?? 'test',
    data: partial.data,
    timestamp: partial.timestamp ?? new Date('2026-03-01T12:00:00Z'),
  };
}

describe('toSignalText — per-source mapping (spec 07 AC1)', () => {
  it('maps a gmail signal (subject/snippet/recipients + authoring tier)', () => {
    const t = toSignalText(
      sig({
        source: 'gmail',
        data: {
          subject: 'Project kickoff',
          snippet: "I'll send the draft tomorrow.",
          from: 'me@example.com',
          to: 'a@example.com, b@example.com',
          cc: 'c@example.com',
          authoringTier: 'user_sent_originated',
        },
      }),
    );
    expect(t.source).toBe('gmail');
    expect(t.title).toBe('Project kickoff');
    expect(t.body).toBe("I'll send the draft tomorrow.");
    expect(t.authoringTier).toBe('user_sent_originated');
    expect(t.authoredByUser).toBe(true);
    expect(t.participants).toEqual(
      expect.arrayContaining(['a@example.com', 'b@example.com', 'c@example.com', 'me@example.com']),
    );
    expect(t.occurredAt.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });

  it('maps a google_calendar signal (title/description/attendees)', () => {
    const t = toSignalText(
      sig({
        source: 'google_calendar',
        data: {
          title: 'Design review',
          description: 'Bring the figma link.',
          organizer: 'org@example.com',
          attendees: [{ email: 'x@example.com' }, { email: 'y@example.com' }],
          authoringTier: 'received_shared',
        },
      }),
    );
    expect(t.title).toBe('Design review');
    expect(t.body).toBe('Bring the figma link.');
    expect(t.participants).toEqual(['org@example.com', 'x@example.com', 'y@example.com']);
    expect(t.authoredByUser).toBe(false); // received_shared is not user-authored
  });

  it('maps a filesystem signal (fileName/excerpt), not user-authored', () => {
    const t = toSignalText(
      sig({
        source: 'filesystem',
        data: { fileName: 'TODO.md', excerpt: '// TODO: ship by Friday' },
      }),
    );
    expect(t.title).toBe('TODO.md');
    expect(t.body).toBe('// TODO: ship by Friday');
    expect(t.authoredByUser).toBe(false); // no tier → fail safe
  });

  it('maps a voice transcript signal as authored when tier says so', () => {
    const t = toSignalText(
      sig({
        source: 'voice',
        data: { transcript: "I'll call the vendor on Monday.", authoringTier: 'authored_originated' },
      }),
    );
    expect(t.title).toBe('Voice note');
    expect(t.body).toBe("I'll call the vendor on Monday.");
    expect(t.authoredByUser).toBe(true); // authored_originated → authored
  });
});

describe('toSignalText — fail-safe behavior (spec 07 AC2)', () => {
  it('unknown source falls back to best-effort and authoredByUser=false', () => {
    const t = toSignalText(
      sig({
        source: 'slack',
        data: { text: 'hello there', from: 'u@example.com', authoringTier: undefined },
      }),
    );
    expect(t.source).toBe('slack');
    expect(t.body).toBe('hello there');
    expect(t.authoredByUser).toBe(false);
  });

  it('unknown source NEVER reports authored even with authored-looking content', () => {
    const t = toSignalText(sig({ source: 'mystery', data: { body: "I'll do it" } }));
    expect(t.authoredByUser).toBe(false);
  });

  it('missing/garbage timestamp coerces to a valid Date (never NaN)', () => {
    const t = toSignalText({
      id: 'x',
      source: 'gmail',
      type: 't',
      data: { subject: 's' },
      // @ts-expect-error deliberately malformed
      timestamp: 'not-a-date',
    });
    expect(Number.isNaN(t.occurredAt.getTime())).toBe(false);
  });
});

describe('isAuthoredByUser — tier mapping (spec 07 AC5)', () => {
  it('true for user_sent_* and authored_originated', () => {
    expect(isAuthoredByUser('user_sent_originated')).toBe(true);
    expect(isAuthoredByUser('user_sent_reply')).toBe(true);
    expect(isAuthoredByUser('authored_originated')).toBe(true);
  });

  it('false for received/inbox/automated and undefined', () => {
    expect(isAuthoredByUser('received_shared')).toBe(false);
    expect(isAuthoredByUser('inbox_personal')).toBe(false);
    expect(isAuthoredByUser('inbox_automated')).toBe(false);
    expect(isAuthoredByUser(undefined)).toBe(false);
  });
});
