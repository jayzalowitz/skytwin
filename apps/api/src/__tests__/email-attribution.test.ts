import { describe, expect, it } from 'vitest';
import { ConfidenceLevel, SKYTWIN_EMAIL_ATTRIBUTION_TEXT } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import {
  annotateEmailAttributionPreview,
  prepareEmailActionForExecution,
} from '../email-attribution.js';

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'a-1',
    decisionId: 'd-1',
    actionType: 'draft_email',
    description: 'Draft a reply',
    domain: 'email',
    parameters: { emailId: 'msg-1', draftBody: 'Looks good to me.' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.MODERATE,
    reasoning: 'test',
    ...overrides,
  };
}

describe('prepareEmailActionForExecution', () => {
  it('turns reviewed draft_email candidates into irreversible send_reply executions', () => {
    const action = makeAction();

    prepareEmailActionForExecution(action, { autonomy_settings: {} });

    expect(action.actionType).toBe('send_reply');
    expect(action.reversible).toBe(false);
    expect(action.parameters['originalActionType']).toBe('draft_email');
    expect(action.parameters['draftBody']).toContain(SKYTWIN_EMAIL_ATTRIBUTION_TEXT);
    expect(action.parameters['emailAttributionSignatureEnabled']).toBe(true);
  });

  it('does not append the signature when the user disabled it', () => {
    const action = makeAction();

    prepareEmailActionForExecution(action, {
      autonomy_settings: { emailAttributionSignatureEnabled: false },
    });

    expect(action.parameters['draftBody']).toBe('Looks good to me.');
    expect(action.parameters['emailAttributionSignatureEnabled']).toBe(false);
  });

  it('leaves non-email actions untouched', () => {
    const action = makeAction({
      actionType: 'archive_email',
      reversible: true,
      parameters: { emailId: 'msg-1' },
    });

    prepareEmailActionForExecution(action, { autonomy_settings: {} });

    expect(action.actionType).toBe('archive_email');
    expect(action.parameters['emailAttributionSignatureEnabled']).toBeUndefined();
  });
});

describe('annotateEmailAttributionPreview', () => {
  it('adds current attribution settings to approval-visible parameters', () => {
    expect(
      annotateEmailAttributionPreview(
        { draftBody: 'Body' },
        { autonomy_settings: { emailAttributionSignatureEnabled: false } },
      ),
    ).toMatchObject({
      draftBody: 'Body',
      emailAttributionSignatureEnabled: false,
      emailAttributionSignatureText: SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
    });
  });
});
