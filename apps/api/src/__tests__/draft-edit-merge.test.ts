import { describe, it, expect } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import {
  applyDraftEditOverride,
  resolveDraftEditOverride,
} from '../routes/draft-edit-merge.js';

function makeDraftEmailAction(
  overrides: Partial<CandidateAction> = {},
): CandidateAction {
  return {
    id: 'a-1',
    decisionId: 'd-1',
    actionType: 'draft_email',
    description: 'Draft a reply',
    domain: 'email',
    parameters: { draftBody: 'original stored body' },
    estimatedCostCents: 5,
    reversible: true,
    confidence: ConfidenceLevel.MODERATE,
    reasoning: 'Drafted from 3 of your prior emails',
    ...overrides,
  };
}

describe('resolveDraftEditOverride', () => {
  it('returns the edited body when actionType=draft_email + non-empty string', () => {
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: 'user edited this',
      }),
    ).toBe('user edited this');
  });

  it('returns null for non-draft_email action types (guards against misuse)', () => {
    // A misused field on a non-draft action shouldn't accidentally
    // overwrite unrelated parameters.
    expect(
      resolveDraftEditOverride({
        actionType: 'archive_email',
        editedBody: 'hostile edit',
      }),
    ).toBeNull();
    expect(
      resolveDraftEditOverride({
        actionType: 'send_reply',
        editedBody: 'wrong action',
      }),
    ).toBeNull();
  });

  it('returns null when editedBody is not a string', () => {
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: undefined,
      }),
    ).toBeNull();
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: null,
      }),
    ).toBeNull();
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: 42,
      }),
    ).toBeNull();
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: { body: 'no objects' },
      }),
    ).toBeNull();
  });

  it('returns null when editedBody is whitespace-only', () => {
    // A whitespace-only submission would blank out a real draft;
    // user almost certainly meant to Discard instead. Reject.
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: '',
      }),
    ).toBeNull();
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: '   ',
      }),
    ).toBeNull();
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: '\n\n\t',
      }),
    ).toBeNull();
  });

  it('accepts long bodies — no length cap beyond what the LLM produced', () => {
    const long = 'paragraph one\n\nparagraph two.\n\n'.repeat(50);
    expect(
      resolveDraftEditOverride({
        actionType: 'draft_email',
        editedBody: long,
      }),
    ).toBe(long);
  });
});

describe('applyDraftEditOverride', () => {
  it('mutates parameters.draftBody in place when override applies', () => {
    const action = makeDraftEmailAction();
    const changed = applyDraftEditOverride(action, 'edited!');
    expect(changed).toBe(true);
    expect(action.parameters['draftBody']).toBe('edited!');
  });

  it('leaves parameters untouched when override does not apply', () => {
    const action = makeDraftEmailAction();
    expect(applyDraftEditOverride(action, '')).toBe(false);
    expect(action.parameters['draftBody']).toBe('original stored body');
    expect(applyDraftEditOverride(action, undefined)).toBe(false);
    expect(action.parameters['draftBody']).toBe('original stored body');
  });

  it('preserves other parameters when overriding draftBody', () => {
    // The override only touches draftBody — other parameters
    // (emailId, replyToFrom, examplesUsed) must survive.
    const action = makeDraftEmailAction({
      parameters: {
        draftBody: 'orig',
        emailId: 'msg-42',
        replyToFrom: 'colleague@example.com',
        examplesUsed: 3,
      },
    });
    applyDraftEditOverride(action, 'new body');
    expect(action.parameters['draftBody']).toBe('new body');
    expect(action.parameters['emailId']).toBe('msg-42');
    expect(action.parameters['replyToFrom']).toBe('colleague@example.com');
    expect(action.parameters['examplesUsed']).toBe(3);
  });

  it('refuses to override on non-draft_email actions even with a valid string', () => {
    // A `send_reply` action that gets an editedBody field by mistake
    // (or maliciously) should NOT have its parameters touched. The
    // override is exclusive to draft_email.
    const action = makeDraftEmailAction({
      actionType: 'send_reply',
      parameters: { to: 'a@b.c', subject: 's', body: 'stored body' },
    });
    expect(applyDraftEditOverride(action, 'attack payload')).toBe(false);
    expect(action.parameters['body']).toBe('stored body');
  });
});
