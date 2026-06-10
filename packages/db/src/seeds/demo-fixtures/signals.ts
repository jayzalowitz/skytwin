/**
 * Synthetic, source-varied signal corpus for the launch demo fixture (spec 09).
 *
 * All content is fictional — no real names, companies, amounts, or dates. Each
 * entry is shaped like a connector RawSignal payload and is designed to light up
 * a specific capability so the digest looks dense-but-real for screenshots:
 * to-dos, FYI clusters, deadlines, commitments, a security alert, and recurring
 * entities across sources.
 */

export interface DemoSignal {
  source: 'gmail' | 'google_calendar' | 'filesystem' | 'voice';
  type: string;
  data: Record<string, unknown>;
}

export const DEMO_SIGNALS: DemoSignal[] = [
  // email — security alert (spec 06): escalate-only, prominent
  {
    source: 'gmail',
    type: 'message',
    data: {
      subject: 'Account notice',
      snippet: 'We detected a sign-in from a new device on your account.',
      from: 'no-reply@accounts.example',
      authoringTier: 'inbox_automated',
    },
  },
  // email — deadline (spec 03) + FYI
  {
    source: 'gmail',
    type: 'message',
    data: {
      subject: 'Trial ending soon',
      snippet: 'Your workspace trial ends in 2 days. Upgrade to keep premium features.',
      from: 'billing@saas.example',
      authoringTier: 'inbox_newsletter',
    },
  },
  // email — authored commitment (spec 02) → to-do
  {
    source: 'gmail',
    type: 'message',
    data: {
      subject: 'Re: vendor onboarding',
      snippet: "Thanks — I'll send the signed form by Friday and loop in the team.",
      from: 'me@demo.example',
      to: 'partner@acme-demo.example',
      authoringTier: 'user_sent_reply',
    },
  },
  // calendar — invite (entity: Acme recurs across signals)
  {
    source: 'google_calendar',
    type: 'meeting_invite',
    data: {
      title: 'Acme kickoff',
      description: 'Intro call with the Acme team. Agenda attached.',
      organizer: 'partner@acme-demo.example',
      attendees: [{ email: 'partner@acme-demo.example' }],
      authoringTier: 'received_shared',
      requiresResponse: true,
    },
  },
  // calendar — authored event description with a commitment
  {
    source: 'google_calendar',
    type: 'calendar_event',
    data: {
      title: 'Prep for review',
      description: "I'll finish the deck before this and share it tonight.",
      organizer: 'me@demo.example',
      authoringTier: 'authored_originated',
    },
  },
  // filesystem (idle-miner) — TODO with a deadline
  {
    source: 'filesystem',
    type: 'file',
    data: {
      fileName: 'ROADMAP.md',
      excerpt: '// TODO: ship the export pipeline by the 15th',
    },
  },
  // voice — transcribed note with a commitment (multi-source showcase)
  {
    source: 'voice',
    type: 'transcript',
    data: {
      transcript: "Note to self — I'll call the Acme partner on Monday about pricing.",
      authoringTier: 'authored_originated',
    },
  },
  // email — FYI newsletter (awareness cluster filler)
  {
    source: 'gmail',
    type: 'message',
    data: {
      subject: 'Weekly product digest',
      snippet: 'Highlights from the community this week.',
      from: 'news@community.example',
      authoringTier: 'inbox_newsletter',
    },
  },
];
