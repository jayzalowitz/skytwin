import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only @skytwin/db's query — the decision-engine fold (buildDigest,
// toSignalText, buildDigestItemDetail, computeCoverage) stays REAL so this
// exercises the actual mapper glue, not a stub of it.
const mockQuery = vi.fn();
vi.mock('@skytwin/db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { buildLiveDigest } from '../services/live-digest.js';

function decisionRow(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    raw_event: {
      source: 'gmail',
      type: 'message',
      data: {
        subject: 'Account notice',
        from: 'no-reply@accounts.example',
        snippet: 'A sign-in from a new device.',
        authoringTier: 'inbox_automated',
      },
    },
    summary: 'Account notice',
    domain: 'security',
    urgency: 'high',
    situation_type: 'security_alert',
    created_at: new Date('2026-06-01T00:00:00Z'),
    requires_approval: true,
    auto_executed: false,
    escalation_reason: 'untrusted_origin',
    confidence: 0.8,
    selected_action_desc: null,
    selected_action_type: null,
    ...over,
  };
}

describe('buildLiveDigest', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns null when the user has no decisions (cold start)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await buildLiveDigest('u1')).toBeNull();
  });

  it('returns a memory-only digest when recent memory has a novel older connection', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // decisions+outcomes
      .mockResolvedValueOnce({
        rows: [
          {
            bucket: 'recent',
            id: 'page-recent',
            title: 'gmail/message',
            content: 'Acme renewal thread: Maria asked whether the security review is still blocking procurement.',
            source: 'signal',
            source_ref: 'sig-recent',
            metadata: { signalSource: 'gmail', fromAddress: 'maria@acme.example' },
            created_at: new Date('2026-06-25T12:00:00Z'),
          },
          {
            bucket: 'older',
            id: 'page-older',
            title: 'gmail/message',
            content: 'Acme security review was blocked on the SOC2 packet and procurement wanted an exception memo.',
            source: 'signal',
            source_ref: 'sig-older',
            metadata: { signalSource: 'gmail', fromAddress: 'maria@acme.example' },
            created_at: new Date('2026-05-10T12:00:00Z'),
          },
        ],
      }) // brain_pages action opportunities
      .mockResolvedValueOnce({ rows: [{ provider: 'google', scopes: [] }] }); // oauth_tokens

    const d = await buildLiveDigest('u1');
    expect(d).not.toBeNull();
    expect(d!.todos).toEqual([]);
    expect(d!.topics).toEqual([]);
    expect(d!.memorySuggestions).toHaveLength(1);
    expect(d!.memorySuggestions[0]?.novelty).toBe('connection');
    expect(d!.memorySuggestions[0]?.reason).toMatch(/Acme security review/i);
    expect(d!.memorySuggestions[0]?.actionPlan).toMatchObject({
      actionType: 'draft_email',
      primaryAdapter: 'ironclaw',
      readiness: 'known_action_type',
      runtimeVersion: {
        runtime: 'ironclaw',
        stableVersion: '0.29.1',
      },
    });
  });

  it('coverage reflects connected oauth_tokens accounts (panel is not stuck in cold-start)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [decisionRow()] }) // decisions+outcomes
      .mockResolvedValueOnce({ rows: [] }) // brain_pages pin/hide overrides
      .mockResolvedValueOnce({ rows: [{ provider: 'google', scopes: [] }] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d).not.toBeNull();
    // A Google connection → the "what I can see" panel is NOT cold-start.
    expect(d!.coverage?.coldStart).toBe(false);
    expect(d!.coverage?.connected).toContain('gmail');
    const security = d!.coverage?.capabilityStatus.find((c) => c.capability === 'security');
    expect(security?.status).toBe('available');
  });

  it('coverage gives a Microsoft-only user the same statuses as Google (no cross-vendor nudge)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [decisionRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ provider: 'microsoft', scopes: [] }] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d!.coverage?.coldStart).toBe(false);
    expect(d!.coverage?.connected).toEqual(['outlook', 'outlook_calendar']);
    const security = d!.coverage?.capabilityStatus.find((c) => c.capability === 'security');
    expect(security?.status).toBe('available'); // Outlook mail enables security, parity with Google
    expect(d!.coverage?.missing).not.toContain('gmail'); // never nudged to connect Google
  });

  it('maps a security decision to a to-do with meaningful power-view detail', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [decisionRow()] }) // decisions+outcomes
      .mockResolvedValueOnce({ rows: [] }) // brain_pages pin/hide overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d).not.toBeNull();
    expect(d!.todos).toHaveLength(1);

    const todo = d!.todos[0]!;
    // Title comes from toSignalText (the real subject), not the generic summary.
    expect(todo.text).toBe('Account notice');
    expect(todo.sourceType).toBe('email');
    // Detail is meaningful: real confidence, the sender as the ref, a real
    // urgency reason, inbound provenance — not "[id slice]" / "Default for X".
    expect(todo.detail?.confidencePct).toBe(80);
    expect(todo.detail?.sourceRefs[0]).toContain('no-reply@accounts.example');
    expect(todo.detail?.sourceRefs[0]).not.toMatch(/^email:\s*[0-9a-f]{8}$/);
    expect(todo.detail?.urgencyReason).toMatch(/security alert/i);
    // Plain-language provenance (no scary "untrusted" jargon), still fail-safe.
    expect(todo.detail?.provenanceLabel).toBe('From someone else');
    expect(todo.detail?.whyNotAutoExecuted.join(' ')).toMatch(/someone else/i);
    expect(todo.detail?.whyNotAutoExecuted.join(' ')).not.toMatch(/untrusted/i);
    // Actionable, not system labels: the real snippet + a recommended step.
    expect(todo.body).toBe('A sign-in from a new device.');
    expect(todo.detail?.suggestedAction).toMatch(/security settings/i);
  });

  it('derives a clean suggested step from the selected action TYPE', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            situation_type: 'calendar_invite',
            domain: 'calendar',
            urgency: 'medium',
            requires_approval: false,
            escalation_reason: null,
            // The engine's raw description is internal-y; we map the TYPE.
            selected_action_desc: 'Accept this calendar invitation.',
            selected_action_type: 'accept_invite',
            raw_event: {
              source: 'google_calendar',
              type: 'event',
              data: { title: 'Acme kickoff', description: 'Project kickoff with Acme.' },
            },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    // calendar_invite is a to-do (needs RSVP)
    const todo = d!.todos[0]!;
    expect(todo.text).toBe('Acme kickoff');
    expect(todo.body).toBe('Project kickoff with Acme.');
    expect(todo.detail?.suggestedAction).toMatch(/accept the invite/i);
  });

  it('cleans the engine\'s internal action text into a user-facing step', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            situation_type: 'generic',
            domain: 'general',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
            // Raw rule-based text that should NOT leak to the user.
            selected_action_desc: 'Escalate to user: Decision needed regarding: transcript.',
            selected_action_type: 'escalate_to_user',
            raw_event: { source: 'voice', type: 'note', data: { transcript: 'Call Acme Monday.' } },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    const item = d!.topics.flatMap((t) => t.items)[0];
    expect(item?.detail?.suggestedAction).not.toMatch(/escalate to user|decision needed regarding/i);
    expect(item?.detail?.suggestedAction).toMatch(/take a look/i);
  });

  it('puts routine inbound items in topics, not to-dos', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            situation_type: 'email_triage',
            domain: 'email',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
            summary: 'Weekly digest',
            raw_event: {
              source: 'gmail',
              type: 'message',
              data: { subject: 'Weekly digest', from: 'news@x.example' },
            },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d!.todos).toHaveLength(0);
    const item = d!.topics.flatMap((t) => t.items)[0];
    expect(item?.text).toBe('Weekly digest');
    // No fabricated "not auto-run" reason for a non-escalated FYI item.
    expect(item?.detail?.whyNotAutoExecuted).toEqual([]);
  });

  it('degrades a malformed raw_event to the summary without throwing', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            raw_event: null,
            summary: 'fallback summary',
            situation_type: 'email_triage',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    const item = d!.topics.flatMap((t) => t.items)[0];
    expect(item?.text).toBe('fallback summary');
  });

  it('marks a user-authored signal as from-you provenance', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            situation_type: 'email_triage',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
            raw_event: {
              source: 'gmail',
              type: 'message',
              data: { subject: 'Re: vendor', authoringTier: 'user_sent_reply' },
            },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    const item = d!.topics.flatMap((t) => t.items)[0];
    expect(item?.detail?.provenanceLabel).toMatch(/from you/i);
  });

  // --- #475: commitment extraction wired into the live digest ---

  /** A decision built from a user-authored sent email carrying commitments. */
  function authoredEmailRow(body: string, over: Record<string, unknown> = {}) {
    return decisionRow({
      // The sent email itself is a routine FYI decision — the commitment is the
      // to-do, not the email-triage decision.
      situation_type: 'email_triage',
      domain: 'work',
      urgency: 'low',
      requires_approval: false,
      auto_executed: true,
      escalation_reason: null,
      confidence: 0.9,
      raw_event: {
        source: 'gmail',
        type: 'message',
        data: {
          subject: 'Re: kickoff',
          to: 'client@acme.example',
          from: 'me@example.com',
          body,
          authoringTier: 'user_sent_reply',
        },
      },
      ...over,
    });
  }

  it('surfaces user-authored commitments as to-dos with from-you provenance and a citation', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          authoredEmailRow(
            "I'll send over the draft tomorrow. I can reach out to the vendor this week.",
          ),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages pin/hide overrides (#485)
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d).not.toBeNull();
    // Two distinct commitments → two commitment to-dos (AC #1). The parent
    // email-triage decision is a routine FYI, so it isn't a to-do itself.
    expect(d!.todos).toHaveLength(2);

    const texts = d!.todos.map((t) => t.text);
    expect(texts).toContain('Send over the draft tomorrow');
    expect(texts.some((t) => /reach out to the vendor/i.test(t))).toBe(true);

    const first = d!.todos[0]!;
    // Provenance is from-you (highest trust) and the explanation cites the
    // user's own sentence (safety invariant #2).
    expect(first.detail?.provenanceLabel).toMatch(/from you/i);
    expect(first.detail?.explanation).toMatch(/from what you wrote/i);
    expect(first.body && first.body.length).toBeGreaterThan(0); // rawSpan citation
    expect(first.sourceType).toBe('email');
    // Deadline hint travels through (AC #7).
    expect(d!.todos.some((t) => t.deadline === 'tomorrow')).toBe(true);
  });

  it('does NOT extract commitments from inbound (non-authored) content (gating, AC #2)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          authoredEmailRow("I'll send over the draft tomorrow.", {
            raw_event: {
              source: 'gmail',
              type: 'message',
              data: {
                subject: 'Re: kickoff',
                from: 'client@acme.example',
                // identical phrasing but INBOUND — must not become a to-do
                body: "I'll send over the draft tomorrow.",
                authoringTier: 'inbox_personal',
              },
            },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages pin/hide overrides (#485)
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    // No commitment to-do; the inbound email is a routine FYI topic.
    expect(d!.todos).toHaveLength(0);
  });

  it('collapses a commitment restated in the same body to one to-do (AC #4)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          authoredEmailRow(
            "I'll send over the draft tomorrow. Just to confirm, I'll send over the draft tomorrow.",
          ),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages pin/hide overrides (#485)
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d!.todos).toHaveLength(1);
    expect(d!.todos[0]!.text).toBe('Send over the draft tomorrow');
  });

  it('does not emit commitment to-dos when COMMITMENT_EXTRACTION=off (rollback flag)', async () => {
    const prev = process.env.COMMITMENT_EXTRACTION;
    process.env.COMMITMENT_EXTRACTION = 'off';
    try {
      mockQuery
        .mockResolvedValueOnce({
          rows: [authoredEmailRow("I'll send over the draft tomorrow.")],
        })
        .mockResolvedValueOnce({ rows: [] }) // brain_pages pin/hide overrides (#485)
        .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

      const d = await buildLiveDigest('u1');
      expect(d!.todos).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.COMMITMENT_EXTRACTION;
      else process.env.COMMITMENT_EXTRACTION = prev;
    }
  });

  it('counts only auto_executed decisions in handledCount', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({ id: 'a', auto_executed: true, requires_approval: false, situation_type: 'email_triage', urgency: 'low', escalation_reason: null }),
          decisionRow({ id: 'b', auto_executed: false, requires_approval: false, situation_type: 'email_triage', urgency: 'low', escalation_reason: null }),
          decisionRow({ id: 'c', auto_executed: null, requires_approval: false, situation_type: 'email_triage', urgency: 'low', escalation_reason: null }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d!.handledCount).toBe(1);
  });

  it('drops a hidden sender end-to-end (#270/#485): hidden item never surfaces', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          // Visible routine item from one sender.
          decisionRow({
            id: 'visible',
            situation_type: 'email_triage',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
            raw_event: { source: 'gmail', type: 'message', data: { subject: 'Keep me', from: 'ok@x.example' } },
          }),
          // Item from a sender the user hid (bulk-hide stamped userOverride=hidden
          // on brain_pages keyed by fromAddress).
          decisionRow({
            id: 'hidden',
            situation_type: 'email_triage',
            urgency: 'high', // would normally be a to-do
            requires_approval: false,
            escalation_reason: null,
            raw_event: { source: 'gmail', type: 'message', data: { subject: 'Hide me', from: 'Spammy <SPAM@x.example>' } },
          }),
        ],
      })
      // brain_pages overrides: the hidden sender (normalized, lowercased).
      .mockResolvedValueOnce({
        rows: [{ from_address: 'spam@x.example', user_override: 'hidden' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    const allRefs = [
      ...d!.todos.map((t) => t.ref),
      ...d!.topics.flatMap((t) => t.items.map((i) => i.ref)),
    ];
    expect(allRefs).toContain('visible');
    expect(allRefs).not.toContain('hidden');
  });

  it('passes through items when the brain has no overrides (pre-#485 parity)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            id: 'keep',
            situation_type: 'email_triage',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
            raw_event: { source: 'gmail', type: 'message', data: { subject: 'Normal', from: 'a@x.example' } },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // brain_pages overrides — empty
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    const allRefs = [
      ...d!.todos.map((t) => t.ref),
      ...d!.topics.flatMap((t) => t.items.map((i) => i.ref)),
    ];
    expect(allRefs).toContain('keep');
  });

  it('degrades to no overrides when the brain_pages query fails (resilience)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          decisionRow({
            id: 'still-here',
            situation_type: 'email_triage',
            urgency: 'low',
            requires_approval: false,
            escalation_reason: null,
            raw_event: { source: 'gmail', type: 'message', data: { subject: 'Hi', from: 'a@x.example' } },
          }),
        ],
      })
      // brain_pages overrides query throws (e.g. table absent on a
      // mempalace-only deploy) — must not error the whole digest.
      .mockRejectedValueOnce(new Error('relation "brain_pages" does not exist'))
      .mockResolvedValueOnce({ rows: [] }); // oauth_tokens (connected accounts)

    const d = await buildLiveDigest('u1');
    expect(d).not.toBeNull();
    const allRefs = [
      ...d!.todos.map((t) => t.ref),
      ...d!.topics.flatMap((t) => t.items.map((i) => i.ref)),
    ];
    expect(allRefs).toContain('still-here');
  });
});
