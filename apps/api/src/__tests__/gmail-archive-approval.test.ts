import { describe, expect, it } from 'vitest';
import { classifyGmailArchiveApproval } from '../routes/gmail-archive-approval.js';

describe('reserved Gmail archive approval classifier', () => {
  it('recognizes the canonical proposal', () => {
    expect(classifyGmailArchiveApproval({
      actionType: 'archive_email',
      parameters: {
        schema: 'gmail_inbox_mutation_v1',
        messageRefId: '11111111-1111-4111-8111-111111111111',
        operation: 'archive',
      },
    })).toEqual({ kind: 'archive' });
  });

  it.each([
    { schema: 'unexpected' },
    { messageRefId: '11111111-1111-4111-8111-111111111111' },
    { operation: 'restore' },
  ])('fails closed for a partially malformed reserved shape: %o', (parameters) => {
    expect(classifyGmailArchiveApproval({
      actionType: 'archive_email',
      parameters,
    })).toEqual({ kind: 'archive' });
  });

  it.each([
    { actionType: 'archive_email', parameters: {} },
    { actionType: 'archive_email', parameters: { emailId: 'legacy', folder: 'archive' } },
    { actionType: 'archive_email' },
  ])('quarantines mixed, legacy, and parameter-free archive shapes: %o', (value) => {
    expect(classifyGmailArchiveApproval(value)).toEqual({ kind: 'archive' });
  });

  it.each([
    { actionType: 'label_email', parameters: { schema: 'gmail_inbox_mutation_v1' } },
    { actionType: 'send_email', parameters: { operation: 'archive' } },
  ])('does not capture an exact unrelated approval shape: %o', (value) => {
    expect(classifyGmailArchiveApproval(value)).toEqual({ kind: 'other' });
  });

  it.each([null, [], {}, { actionType: 7 }])(
    'marks an unreadable stored action invalid instead of allowing generic fallback: %o',
    (value) => {
      expect(classifyGmailArchiveApproval(value)).toEqual({ kind: 'invalid' });
    },
  );

  it('does not invoke hostile accessors', () => {
    let invoked = false;
    const value = Object.defineProperty({}, 'actionType', {
      enumerable: true,
      get() {
        invoked = true;
        return 'archive_email';
      },
    });
    expect(classifyGmailArchiveApproval(value)).toEqual({ kind: 'invalid' });
    expect(invoked).toBe(false);
  });
});
