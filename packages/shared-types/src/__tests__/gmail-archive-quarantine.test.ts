import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { classifyGmailArchiveGenericAction } from '../gmail-archive-quarantine.js';

describe('classifyGmailArchiveGenericAction', () => {
  it.each([
    { actionType: 'archive_email' },
    { actionType: 'archive_email', parameters: {} },
    { actionType: 'archive_email', parameters: { emailId: 'legacy' } },
    { actionType: 'archive_email', parameters: { schema: 'unexpected' } },
    Object.assign(Object.create(null), { actionType: 'archive_email' }),
  ])('quarantines every archive representation: %o', (value) => {
    expect(classifyGmailArchiveGenericAction(value)).toEqual({ kind: 'archive' });
  });

  it.each([
    { actionType: 'label_email' },
    { actionType: 'Archive_Email' },
    { actionType: 'send_email', parameters: { operation: 'archive' } },
  ])('leaves an exact unrelated action outside the quarantine: %o', (value) => {
    expect(classifyGmailArchiveGenericAction(value)).toEqual({ kind: 'other' });
  });

  it.each([null, undefined, [], 'archive_email', {}, { actionType: 1 }])(
    'distinguishes an invalid action from an unrelated action: %o',
    (value) => {
      expect(classifyGmailArchiveGenericAction(value)).toEqual({ kind: 'invalid' });
    },
  );

  it('does not invoke an actionType accessor', () => {
    const getter = vi.fn(() => 'archive_email');
    const value = Object.defineProperty({}, 'actionType', { enumerable: true, get: getter });
    expect(classifyGmailArchiveGenericAction(value)).toEqual({ kind: 'invalid' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('quarantines archive without inspecting hostile parameters', () => {
    const getter = vi.fn(() => {
      throw new Error('parameters must remain opaque');
    });
    const value = Object.defineProperty({ actionType: 'archive_email' }, 'parameters', {
      enumerable: true,
      get: getter,
    });
    expect(classifyGmailArchiveGenericAction(value)).toEqual({ kind: 'archive' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('fails closed for inherited, symbolic, and hostile proxy shapes', () => {
    expect(classifyGmailArchiveGenericAction(
      Object.create({ actionType: 'archive_email' }),
    )).toEqual({ kind: 'invalid' });
    expect(classifyGmailArchiveGenericAction({
      actionType: 'archive_email',
      [Symbol('hidden')]: true,
    })).toEqual({ kind: 'invalid' });
    expect(classifyGmailArchiveGenericAction(new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile');
      },
    }))).toEqual({ kind: 'invalid' });
  });

  it('returns frozen singleton results', () => {
    expect(Object.isFrozen(classifyGmailArchiveGenericAction({
      actionType: 'archive_email',
    }))).toBe(true);
  });

  it('remains a dependency-neutral classifier with no runtime authority', async () => {
    const source = await readFile(
      new URL('../gmail-archive-quarantine.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/@skytwin\/(?:db|ironclaw-adapter|execution-router)/);
    expect(source).not.toMatch(/GmailArchiveCallerKernel|GmailInboxMutationService|fetch\s*\(/);
  });
});
