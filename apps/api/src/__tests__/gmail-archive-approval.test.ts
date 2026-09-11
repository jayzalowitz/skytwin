import { describe, expect, it, vi } from 'vitest';
import {
  isCanonicalGmailArchiveApproval,
  isReservedGmailArchiveApproval,
} from '../routes/gmail-archive-approval.js';

function canonicalApproval(): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    actionType: 'archive_email',
    description: 'Propose moving this message out of the Inbox.',
    domain: 'email',
    parameters: {
      schema: 'gmail_inbox_mutation_v1',
      messageRefId: '11111111-1111-4111-8111-111111111111',
      operation: 'archive',
    },
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: 'moderate',
    reasoning: 'The trusted Gmail decision identifies one opaque, account-bound message target.',
    provenance: 'untrusted_external',
  };
}

describe('reserved Gmail archive approval classifier', () => {
  it('recognizes the canonical proposal', () => {
    expect(isReservedGmailArchiveApproval(canonicalApproval())).toBe(true);
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

describe('canonical Gmail archive approval classifier', () => {
  it('accepts only the exact canonical projection', () => {
    expect(isCanonicalGmailArchiveApproval(canonicalApproval())).toBe(true);
    expect(isCanonicalGmailArchiveApproval({ ...canonicalApproval(), extra: true })).toBe(false);
    const forgedParameters = canonicalApproval()['parameters'] as Record<string, unknown>;
    expect(isCanonicalGmailArchiveApproval({
      ...canonicalApproval(),
      parameters: { ...forgedParameters, providerMessageId: 'forged' },
    })).toBe(false);
  });

  it.each([
    ['wrong schema', { schema: 'gmail_inbox_mutation_v2' }],
    ['wrong operation', { operation: 'delete' }],
    ['invalid reference', { messageRefId: 'provider-id' }],
  ])('rejects %s', (_label, replacement) => {
    const candidate = canonicalApproval();
    candidate['parameters'] = {
      ...(candidate['parameters'] as Record<string, unknown>),
      ...replacement,
    };
    expect(isCanonicalGmailArchiveApproval(candidate)).toBe(false);
  });

  it('rejects symbol keys before sorting string keys', () => {
    const candidate = canonicalApproval();
    Object.defineProperty(candidate, Symbol('authority'), {
      enumerable: true,
      value: 'forged',
    });
    expect(isCanonicalGmailArchiveApproval(candidate)).toBe(false);
  });

  it('does not invoke getters and keeps accessor shapes reserved fail-closed', () => {
    const getter = vi.fn(() => 'archive_email');
    const candidate = canonicalApproval();
    Object.defineProperty(candidate, 'actionType', { enumerable: true, get: getter });

    expect(isCanonicalGmailArchiveApproval(candidate)).toBe(false);
    expect(isReservedGmailArchiveApproval(candidate)).toBe(true);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects a throwing proxy without throwing and reserves it fail-closed', () => {
    const candidate = new Proxy(canonicalApproval(), {
      getPrototypeOf() {
        throw new Error('untrusted reflection');
      },
    });

    expect(() => isCanonicalGmailArchiveApproval(candidate)).not.toThrow();
    expect(isCanonicalGmailArchiveApproval(candidate)).toBe(false);
    expect(isReservedGmailArchiveApproval(candidate)).toBe(true);
  });
});
