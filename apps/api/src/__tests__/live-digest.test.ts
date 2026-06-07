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

  it('maps a security decision to a to-do with meaningful power-view detail', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [decisionRow()] }) // decisions+outcomes
      .mockResolvedValueOnce({ rows: [] }); // connected_accounts

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
      .mockResolvedValueOnce({ rows: [] });

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
      .mockResolvedValueOnce({ rows: [] });

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
      .mockResolvedValueOnce({ rows: [] });

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
      .mockResolvedValueOnce({ rows: [] });

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
      .mockResolvedValueOnce({ rows: [] });

    const d = await buildLiveDigest('u1');
    const item = d!.topics.flatMap((t) => t.items)[0];
    expect(item?.detail?.provenanceLabel).toMatch(/from you/i);
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
      .mockResolvedValueOnce({ rows: [] });

    const d = await buildLiveDigest('u1');
    expect(d!.handledCount).toBe(1);
  });
});
