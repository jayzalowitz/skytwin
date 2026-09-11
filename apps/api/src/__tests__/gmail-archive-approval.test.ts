import { describe, expect, it } from 'vitest';
import { isReservedGmailArchiveApproval } from '../routes/gmail-archive-approval.js';

describe('reserved Gmail archive approval classifier', () => {
  it('recognizes the canonical proposal', () => {
    expect(isReservedGmailArchiveApproval({
      actionType: 'archive_email',
      parameters: {
        schema: 'gmail_inbox_mutation_v1',
        messageRefId: '11111111-1111-4111-8111-111111111111',
        operation: 'archive',
      },
    })).toBe(true);
  });

  it.each([
    { schema: 'unexpected' },
    { messageRefId: '11111111-1111-4111-8111-111111111111' },
    { operation: 'restore' },
  ])('fails closed for a partially malformed reserved shape: %o', (parameters) => {
    expect(isReservedGmailArchiveApproval({
      actionType: 'archive_email',
      parameters,
    })).toBe(true);
  });

  it.each([
    null,
    [],
    { actionType: 'archive_email', parameters: {} },
    { actionType: 'archive_email', parameters: { emailId: 'legacy', folder: 'archive' } },
    { actionType: 'label_email', parameters: { schema: 'gmail_inbox_mutation_v1' } },
  ])('does not capture unrelated or legacy approval shapes: %o', (value) => {
    expect(isReservedGmailArchiveApproval(value)).toBe(false);
  });
});
