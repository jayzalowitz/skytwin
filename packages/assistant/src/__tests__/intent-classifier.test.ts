import { describe, it, expect } from 'vitest';
import { detectIntent } from '../intent-classifier.js';

// Issue #148 v1 — rule-based intent classifier. Tests assert both that
// known intents match (the action surface works) AND that conversational
// messages don't accidentally match (the safety surface — chat about
// scheduling shouldn't queue a real meeting). The latter is more
// load-bearing because false positives mean unintended approvals
// landing in the user's queue.

describe('detectIntent', () => {
  // ── Email actions ─────────────────────────────────────────────

  it('detects archive intent (positional variants)', () => {
    expect(detectIntent('archive that email')?.situationType).toBe('email_triage');
    expect(detectIntent('please archive the receipt')?.situationType).toBe('email_triage');
    expect(detectIntent('archive this for me')?.situationType).toBe('email_triage');
  });

  it('detects label intent and captures the label name', () => {
    const intent = detectIntent('label that email as receipts');
    expect(intent?.situationType).toBe('email_triage');
    expect(intent?.rawData['intent']).toBe('label_email');
    expect(intent?.rawData['label']).toBe('receipts');
  });

  it('detects "tag this as work" as a label intent', () => {
    const intent = detectIntent('tag this as work');
    expect(intent?.rawData['intent']).toBe('label_email');
    expect(intent?.rawData['label']).toBe('work');
  });

  it('detects reply intent (multiple phrasings)', () => {
    expect(detectIntent('reply to that email')?.rawData['intent']).toBe('send_reply');
    expect(detectIntent('respond to it for me')?.rawData['intent']).toBe('send_reply');
    expect(detectIntent('please send a reply')?.rawData['intent']).toBe('send_reply');
  });

  // ── Calendar actions ──────────────────────────────────────────

  it('detects schedule intent', () => {
    expect(detectIntent('schedule a meeting with Alice')?.situationType).toBe('calendar_invite');
    expect(detectIntent('book an appointment for tomorrow')?.situationType).toBe('calendar_invite');
    expect(detectIntent('set up a call with the team')?.situationType).toBe('calendar_invite');
  });

  it('detects decline intent', () => {
    expect(detectIntent('decline that meeting')?.situationType).toBe('calendar_update');
    expect(detectIntent('cancel my appointment')?.situationType).toBe('calendar_update');
    expect(detectIntent('skip the call')?.situationType).toBe('calendar_update');
  });

  // ── Task actions ──────────────────────────────────────────────

  it('detects task creation intent', () => {
    expect(detectIntent('remind me to call mom')?.situationType).toBe('task_management');
    expect(detectIntent('add a task to review the PR')?.situationType).toBe('task_management');
  });

  // ── Negative cases (no false positives) ───────────────────────

  it('returns null for short / ambiguous messages', () => {
    expect(detectIntent('ok')).toBeNull();
    expect(detectIntent('thanks')).toBeNull();
    expect(detectIntent('sure')).toBeNull();
    expect(detectIntent('')).toBeNull();
    expect(detectIntent('   ')).toBeNull();
  });

  it('returns null for non-string inputs (defensive)', () => {
    expect(detectIntent(undefined as unknown as string)).toBeNull();
    expect(detectIntent(null as unknown as string)).toBeNull();
    expect(detectIntent(42 as unknown as string)).toBeNull();
  });

  it('does NOT match meta-discussion about scheduling (false positive guard)', () => {
    // The user is talking ABOUT how scheduling works, not asking the
    // assistant to schedule something. False positive here would queue
    // an unintended approval.
    expect(detectIntent('how do you decide when to schedule things?')).toBeNull();
    expect(detectIntent('what does archive mean in your system?')).toBeNull();
  });

  it('does NOT match action verbs without an object phrase', () => {
    // "archive" alone, or with no object pronoun/article, isn't enough
    // to trust as an intent. Avoids matches like "I have a big archive
    // of emails" where archive is a noun.
    expect(detectIntent('I have a large archive of files')).toBeNull();
    expect(detectIntent('what is your favorite label?')).toBeNull();
  });

  it('preserves the trigger message verbatim for the approval card', () => {
    const intent = detectIntent('archive that email please');
    expect(intent?.triggerMessage).toBe('archive that email please');
  });

  it('trims surrounding whitespace before matching', () => {
    const intent = detectIntent('   archive that email   ');
    expect(intent?.triggerMessage).toBe('archive that email');
  });

  it('marks chat-driven rawData with source: "chat"', () => {
    // Lets downstream consumers (decision engine, audit log) distinguish
    // chat-driven decisions from real-signal-driven ones if they want.
    const intent = detectIntent('archive that email');
    expect(intent?.rawData['source']).toBe('chat');
  });
});
