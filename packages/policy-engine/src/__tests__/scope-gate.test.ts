import { describe, it, expect } from 'vitest';
import { requiredWriteScope, hasWriteScope, applyScopeGate } from '../scope-gate.js';
import { ConfidenceLevel, type CandidateAction } from '@skytwin/shared-types';

const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

function cand(actionType: string): CandidateAction {
  return {
    id: 'c1',
    decisionId: 'd1',
    actionType,
    description: `do ${actionType}`,
    domain: 'email',
    parameters: { to: 'a@x.com', body: 'hi' },
    estimatedCostCents: 0,
    reversible: false,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'x',
  };
}

describe('requiredWriteScope (spec 11)', () => {
  it('maps send/reply to gmail.send and calendar writes to calendar.events', () => {
    expect(requiredWriteScope('send_reply')?.scope).toBe('gmail.send');
    expect(requiredWriteScope('create_calendar_event')?.scope).toBe('calendar.events');
    expect(requiredWriteScope('calendar_update')?.scope).toBe('calendar.events');
  });
  it('returns null for non-scoped actions', () => {
    expect(requiredWriteScope('create_note')).toBeNull();
    expect(requiredWriteScope('escalate_to_user')).toBeNull();
  });
});

describe('hasWriteScope — fail-safe (spec 11)', () => {
  it('true when the granted scopes include the required scope', () => {
    expect(hasWriteScope('send_reply', [GMAIL_SEND])).toBe(true);
  });
  it('false (fail-safe) when the required scope is missing, empty, or unrelated', () => {
    expect(hasWriteScope('send_reply', [])).toBe(false);
    expect(hasWriteScope('send_reply', ['gmail.readonly'])).toBe(false);
    // @ts-expect-error garbage input
    expect(hasWriteScope('send_reply', null)).toBe(false);
  });
  it('true for actions that need no tracked scope', () => {
    expect(hasWriteScope('create_note', [])).toBe(true);
  });
});

describe('applyScopeGate (spec 11)', () => {
  it('downgrades an un-granted send into a human-review grant-access escalation', () => {
    const [out] = applyScopeGate([cand('send_reply')], []);
    expect(out!.actionType).toBe('escalate_to_user');
    expect(out!.parameters.reason).toBe('missing_write_scope');
    expect(out!.parameters.requiredScope).toBe('gmail.send');
    expect(out!.reversible).toBe(true);
  });
  it('passes a properly-scoped send through unchanged', () => {
    const [out] = applyScopeGate([cand('send_reply')], [GMAIL_SEND]);
    expect(out!.actionType).toBe('send_reply');
  });
  it('passes non-write candidates through unchanged', () => {
    const [out] = applyScopeGate([cand('create_note')], []);
    expect(out!.actionType).toBe('create_note');
  });
});
